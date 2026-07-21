// SQL construction, ported from the native app's src/pg.ts.
//
// The native version threaded Uint8Array everywhere to satisfy the
// app-core subset checker; here it is plain strings, but the statements
// and the quoting rules are the same.

/// Rows per page. 15 came over from the canvas app and made you page through
/// anything real; 50 fills a window without making the +1 probe row costly.
/// The size is per-tab — see QueryTab.pageSize.
export const DEFAULT_PAGE_SIZE = 50;
export const PAGE_SIZES: readonly number[] = [25, 50, 100, 250];

/// A quoted identifier. Doubling embedded quotes is what makes a column
/// literally named `we"ird` safe to interpolate.
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/// A quoted literal, same doubling rule for single quotes.
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export const TABLES_SQL =
  "SELECT table_schema, table_name FROM information_schema.tables " +
  "WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') " +
  "ORDER BY table_schema, table_name;";

export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "contains"
  | "is_null"
  | "not_null";

/// The predicate tree.
///
/// This used to be a flat `Filter[]`, which was an implicit AND. A group
/// makes the connective explicit and lets it nest, which is the whole
/// difference between a filter list and a query builder: `a AND (b OR c)`
/// has no flat spelling.
export interface Condition {
  kind: "condition";
  id: string;
  column: string;
  op: FilterOp;
  value: string;
}

export interface Group {
  kind: "group";
  id: string;
  connective: "and" | "or";
  children: Predicate[];
}

export type Predicate = Condition | Group;

export interface Sort {
  column: string;
  dir: "asc" | "desc";
}

/// Everything the builder controls for one table.
export interface TableQuery {
  where: Group;
  sort: Sort[];
  /// Columns the user hid. Storing what is hidden rather than what is shown
  /// means a column added to the table later appears by default.
  hidden: string[];
}

/// Ids only have to be unique within a session — they key React lists and
/// address nodes for edit, and never outlive the tab.
let nodeSeq = 0;
export function nodeId(): string {
  nodeSeq += 1;
  return `n${nodeSeq}`;
}

/// A restored tree carries ids minted in an earlier session, while the counter
/// above starts back at zero. Push it past whatever came back or the next new
/// node collides with one already in the tree — and since every tree edit is
/// addressed by id, the edit would silently land on the wrong node.
export function reserveNodeIds(node: Predicate): void {
  const match = /^n(\d+)$/.exec(node.id);
  if (match) nodeSeq = Math.max(nodeSeq, Number(match[1]));
  if (node.kind === "group") for (const child of node.children) reserveNodeIds(child);
}

export function emptyGroup(connective: "and" | "or" = "and"): Group {
  return { kind: "group", id: nodeId(), connective, children: [] };
}

export function emptyQuery(): TableQuery {
  return { where: emptyGroup(), sort: [], hidden: [] };
}

export function newCondition(column: string): Condition {
  return { kind: "condition", id: nodeId(), column, op: "eq", value: "" };
}

/// Conditions in the tree, for the tab badge.
export function countConditions(node: Predicate): number {
  if (node.kind === "condition") return 1;
  return node.children.reduce((n, child) => n + countConditions(child), 0);
}

export const FILTER_OPS: ReadonlyArray<{ op: FilterOp; label: string }> = [
  { op: "eq", label: "=" },
  { op: "ne", label: "!=" },
  { op: "gt", label: ">" },
  { op: "lt", label: "<" },
  { op: "gte", label: ">=" },
  { op: "lte", label: "<=" },
  { op: "contains", label: "contains" },
  { op: "is_null", label: "is null" },
  { op: "not_null", label: "is not null" },
];

export function opLabel(op: FilterOp): string {
  return FILTER_OPS.find((entry) => entry.op === op)?.label ?? "=";
}

/// Whether the operator takes a comparison value.
export function opTakesValue(op: FilterOp): boolean {
  return op !== "is_null" && op !== "not_null";
}

/// One filter as a SQL conjunct.
///
/// Values are compared as text (`::text`) for `contains` so the operator
/// works on non-text columns too; the ordering operators compare in the
/// column's own type, which is what makes `qty > 10` numeric rather than
/// lexicographic.
export function conditionSql(filter: Condition): string {
  const column = ident(filter.column);
  switch (filter.op) {
    case "eq":
      return `${column} = ${literal(filter.value)}`;
    case "ne":
      return `${column} <> ${literal(filter.value)}`;
    case "gt":
      return `${column} > ${literal(filter.value)}`;
    case "lt":
      return `${column} < ${literal(filter.value)}`;
    case "gte":
      return `${column} >= ${literal(filter.value)}`;
    case "lte":
      return `${column} <= ${literal(filter.value)}`;
    case "contains":
      return `${column}::text ILIKE ${literal(`%${filter.value}%`)}`;
    case "is_null":
      return `${column} IS NULL`;
    case "not_null":
      return `${column} IS NOT NULL`;
  }
}

/// One node as SQL. Empty groups vanish rather than emitting `()`, and a
/// group of one needs no parentheses — so a half-built tree still produces a
/// statement that runs, which is what lets the preview update as you type.
export function predicateSql(node: Predicate): string {
  if (node.kind === "condition") {
    if (opTakesValue(node.op) && node.value.length === 0) return "";
    if (node.column.length === 0) return "";
    return conditionSql(node);
  }
  const parts = node.children.map(predicateSql).filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `(${parts.join(node.connective === "and" ? " AND " : " OR ")})`;
}

/// " WHERE ..." for the tree ("" when it contributes nothing).
///
/// The root is joined here rather than through `predicateSql` so the whole
/// clause is not wrapped in a redundant outer pair of parentheses — this SQL
/// is read in the preview and handed to a query tab, so it should look like
/// something a person would have written.
export function whereSql(where: Group): string {
  const parts = where.children.map(predicateSql).filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  const glue = where.connective === "and" ? " AND " : " OR ";
  return ` WHERE ${parts.join(glue)}`;
}

export function conditionLabel(filter: Condition): string {
  if (!opTakesValue(filter.op)) return `${filter.column} ${opLabel(filter.op)}`;
  return `${filter.column} ${opLabel(filter.op)} ${filter.value}`;
}

/// Primary-key columns, one `pk:<name>` row each. The prefix keeps the
/// result-set boundary unambiguous.
export function pkSql(schema: string, name: string): string {
  const qualified = `${ident(schema)}.${ident(name)}`;
  return (
    "SELECT 'pk:' || a.attname FROM pg_index i " +
    "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) " +
    `WHERE i.indrelid = ${literal(qualified)}::regclass AND i.indisprimary ORDER BY a.attnum;`
  );
}

/// The user's sort, made total.
///
/// Whatever they picked, the key always trails it: OFFSET pagination repeats
/// and skips rows whenever the ordering leaves ties, so a sort on a column
/// with duplicates is only safe with a unique tiebreaker behind it.
export function orderSql(sort: readonly Sort[], pkCols: readonly string[]): string {
  const parts = sort
    .filter((entry) => entry.column.length > 0)
    .map((entry) => `${ident(entry.column)} ${entry.dir === "desc" ? "DESC" : "ASC"}`);
  const chosen = new Set(sort.map((entry) => entry.column));
  if (pkCols.length === 0) parts.push("ctid");
  else for (const pk of pkCols) if (!chosen.has(pk)) parts.push(ident(pk));
  return ` ORDER BY ${parts.join(", ")}`;
}

/// The select list. `columns` is the table's full column set, not the last
/// page's — otherwise hiding two columns and unhiding one would lose the
/// other, since the page no longer knows it exists.
function projectionSql(columns: readonly string[], hidden: readonly string[]): string {
  if (columns.length === 0 || hidden.length === 0) return "*";
  const visible = columns.filter((name) => !hidden.includes(name));
  // Hiding every column would select nothing; read it as hiding none.
  if (visible.length === 0) return "*";
  return visible.map(ident).join(", ");
}

/// One page of table data. `ctid` rides field 0 as the row key, and one
/// extra row probes for a next page without a COUNT.
export function dataSql(
  schema: string,
  name: string,
  query: TableQuery,
  pkCols: readonly string[],
  offset: number,
  pageSize: number,
  columns: readonly string[] = [],
): string {
  return (
    `SELECT ctid, ${projectionSql(columns, query.hidden)} FROM ${ident(schema)}.${ident(name)}` +
    whereSql(query.where) +
    orderSql(query.sort, pkCols) +
    ` LIMIT ${pageSize + 1} OFFSET ${offset};`
  );
}

/// The same query as you would write it by hand — no ctid, no paging. This
/// is what the builder previews and what "Edit as SQL" hands to a query tab.
export function plainSql(
  schema: string,
  name: string,
  query: TableQuery,
  pkCols: readonly string[],
  columns: readonly string[] = [],
): string {
  return (
    `SELECT ${projectionSql(columns, query.hidden)} FROM ${ident(schema)}.${ident(name)}` +
    whereSql(query.where) +
    orderSql(query.sort, pkCols) +
    ";"
  );
}

/// A free-form SELECT wrapped for pagination (probe row included).
export function wrapPaged(base: string, offset: number, pageSize: number): string {
  const trimmed = base.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS artemis_page LIMIT ${pageSize + 1} OFFSET ${offset};`;
}

/// Whether a statement can be paginated by wrapping it in a subquery.
/// Anything that is not a bare SELECT/WITH runs verbatim, once.
export function isPageable(sql: string): boolean {
  const head = sql.trim().replace(/^\(+/, "").slice(0, 6).toLowerCase();
  return head.startsWith("select") || head.startsWith("with");
}

export interface StagedEdit {
  /// The row's ctid — the staging identity, stable within a page.
  key: string;
  column: string;
  colIndex: number;
  value: string;
  /// The WHERE that addresses this row, resolved when the edit was staged.
  where: string;
}

/// The literal text NULL sets the column NULL; anything else is a string
/// literal. This is the native app's rule, kept so muscle memory carries
/// over — it does mean you cannot store the four characters "NULL".
export function stagedSqlValue(value: string): string {
  return value === "NULL" ? "NULL" : literal(value);
}

/// How to address one row in an UPDATE. Primary key equality when every
/// pk column is present in the result, ctid otherwise.
///
/// `baseRow` must be the row's ORIGINAL values, not staged ones: editing
/// a primary-key column must still match on the value the database holds.
export function rowPredicate(
  pkCols: readonly string[],
  cols: readonly string[],
  baseRow: readonly string[],
  ctid: string,
): string {
  if (pkCols.length > 0) {
    const parts: string[] = [];
    let resolved = true;
    for (const pk of pkCols) {
      const index = cols.indexOf(pk);
      if (index < 0) {
        resolved = false;
        break;
      }
      parts.push(`${ident(pk)} = ${literal(baseRow[index] ?? "")}`);
    }
    if (resolved && parts.length > 0) return parts.join(" AND ");
  }
  return `ctid = ${literal(ctid)}`;
}

/// Staged edits as one atomic batch, followed by the page select so the
/// caller gets fresh rows back from the same round trip.
///
/// All edits to one row collapse into a single UPDATE, so a multi-column
/// edit of a row always lands together.
export function commitSql(
  schema: string,
  name: string,
  staged: readonly StagedEdit[],
  query: TableQuery,
  pkCols: readonly string[],
  offset: number,
  pageSize: number,
  columns: readonly string[] = [],
): string {
  const byRow = new Map<string, StagedEdit[]>();
  for (const edit of staged) {
    const list = byRow.get(edit.key);
    if (list) list.push(edit);
    else byRow.set(edit.key, [edit]);
  }

  const statements: string[] = ["BEGIN;"];
  for (const [, edits] of byRow) {
    const assignments = edits
      .map((e) => `${ident(e.column)} = ${stagedSqlValue(e.value)}`)
      .join(", ");
    statements.push(
      `UPDATE ${ident(schema)}.${ident(name)} SET ${assignments} WHERE ${edits[0].where};`,
    );
  }
  statements.push("COMMIT;");
  statements.push(dataSql(schema, name, query, pkCols, offset, pageSize, columns));
  return statements.join(" ");
}
