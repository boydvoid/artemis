// SQL construction, ported from the native app's src/pg.ts.
//
// The native version threaded Uint8Array everywhere to satisfy the
// app-core subset checker; here it is plain strings, but the statements
// and the quoting rules are the same.

export const PAGE_SIZE = 15;

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

export interface Filter {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
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
export function filterClause(filter: Filter): string {
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

/// " WHERE a AND b" for the filter set ("" when empty).
export function whereSql(filters: readonly Filter[]): string {
  if (filters.length === 0) return "";
  return ` WHERE ${filters.map(filterClause).join(" AND ")}`;
}

export function filterLabel(filter: Filter): string {
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

/// A deterministic ORDER BY: the primary key when known, ctid otherwise.
/// Stable ordering is what keeps OFFSET pagination from repeating or
/// skipping rows between pages.
export function orderSql(pkCols: readonly string[]): string {
  if (pkCols.length === 0) return " ORDER BY ctid";
  return ` ORDER BY ${pkCols.map(ident).join(", ")}`;
}

/// One page of table data. `ctid` rides field 0 as the row key, and one
/// extra row probes for a next page without a COUNT.
export function dataSql(
  schema: string,
  name: string,
  filters: readonly Filter[],
  pkCols: readonly string[],
  offset: number,
): string {
  return (
    `SELECT ctid, * FROM ${ident(schema)}.${ident(name)}` +
    whereSql(filters) +
    orderSql(pkCols) +
    ` LIMIT ${PAGE_SIZE + 1} OFFSET ${offset};`
  );
}

/// A free-form SELECT wrapped for pagination (probe row included).
export function wrapPaged(base: string, offset: number): string {
  const trimmed = base.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (${trimmed}) AS artemis_page LIMIT ${PAGE_SIZE + 1} OFFSET ${offset};`;
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
  filters: readonly Filter[],
  pkCols: readonly string[],
  offset: number,
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
  statements.push(dataSql(schema, name, filters, pkCols, offset));
  return statements.join(" ");
}
