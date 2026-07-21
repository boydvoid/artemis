// Postgres access - the one place psql lives.
//
// The connected database is read through the PostgreSQL client CLI
// (`psql <url> -X -q -A -F <US> -R <RS> -P footer=off -v
// ON_ERROR_STOP=1 -c <sql>`) via Cmd.spawn, with the same
// unit/record-separator framing the SQLite layer uses. The first output
// record is always the header row; parsers consume or skip it
// accordingly. Table views select `ctid, *` ordered by the discovered
// primary key, and staged edits commit as one grouped UPDATE per row
// inside a single transaction.

import { asciiBytes } from "@native-sdk/core";
import {
  MAX_COLUMNS,
  PAGE_SIZE,
  type FilterOp,
  type FilterRow,
  type CellRec,
  type ColumnRef,
  type RowKey,
  type StagedEdit,
  type TableRef,
} from "./types.ts";
import {
  bytesConcat,
  bytesEqual,
  identQuoted,
  recordSeparator,
  sqlQuoted,
  stripFinalNewline,
  unitSeparator,
} from "./bytes.ts";

export const TABLES_SQL = asciiBytes(
  "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name;",
);

/// The operator's display text ("contains", ">=", "is null", ...).
export function opLabel(op: FilterOp): Uint8Array {
  switch (op) {
    case "eq":
      return asciiBytes("=");
    case "ne":
      return asciiBytes("!=");
    case "gt":
      return asciiBytes(">");
    case "lt":
      return asciiBytes("<");
    case "gte":
      return asciiBytes(">=");
    case "lte":
      return asciiBytes("<=");
    case "contains":
      return asciiBytes("contains");
    case "is_null":
      return asciiBytes("is null");
    case "not_null":
      return asciiBytes("is not null");
  }
}

/// Whether the operator takes a comparison value.
export function opTakesValue(op: FilterOp): boolean {
  return op !== "is_null" && op !== "not_null";
}

/// One filter as a SQL conjunct: quoted identifier, operator, quoted value.
export function filterClause(filter: FilterRow): Uint8Array {
  const ident = identQuoted(filter.column);
  switch (filter.op) {
    case "eq":
      return bytesConcat([ident, asciiBytes(" = "), sqlQuoted(filter.value)]);
    case "ne":
      return bytesConcat([ident, asciiBytes(" <> "), sqlQuoted(filter.value)]);
    case "gt":
      return bytesConcat([ident, asciiBytes(" > "), sqlQuoted(filter.value)]);
    case "lt":
      return bytesConcat([ident, asciiBytes(" < "), sqlQuoted(filter.value)]);
    case "gte":
      return bytesConcat([ident, asciiBytes(" >= "), sqlQuoted(filter.value)]);
    case "lte":
      return bytesConcat([ident, asciiBytes(" <= "), sqlQuoted(filter.value)]);
    case "contains":
      return bytesConcat([ident, asciiBytes("::text ILIKE "), sqlQuoted(bytesConcat([asciiBytes("%"), filter.value, asciiBytes("%")]))]);
    case "is_null":
      return bytesConcat([ident, asciiBytes(" IS NULL")]);
    case "not_null":
      return bytesConcat([ident, asciiBytes(" IS NOT NULL")]);
  }
}

/// " WHERE a AND b" for the filter set ("" when empty).
export function whereSql(filters: readonly FilterRow[]): Uint8Array {
  if (filters.length === 0) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  parts.push(asciiBytes(" WHERE "));
  for (let i = 0; i < filters.length; i++) {
    if (i > 0) parts.push(asciiBytes(" AND "));
    parts.push(filterClause(filters[i]));
  }
  return bytesConcat(parts);
}

/// The primary-key columns of a table, one 'pk:<name>' row each (the
/// prefix keeps the result-set boundary unambiguous when batched).
export function pkSql(schema: Uint8Array, name: Uint8Array): Uint8Array {
  const qualified = bytesConcat([identQuoted(schema), asciiBytes("."), identQuoted(name)]);
  return bytesConcat([
    asciiBytes("SELECT 'pk:' || a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = "),
    sqlQuoted(qualified),
    asciiBytes("::regclass AND i.indisprimary ORDER BY a.attnum;"),
  ]);
}

/// Parse pkSql output: header record, then 'pk:<name>' rows -> US-joined.
export function parsePkCols(out: Uint8Array): Uint8Array {
  const lines = stripFinalNewline(out).split(recordSeparator());
  const parts: Uint8Array[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(asciiBytes("pk:"))) continue;
    if (parts.length > 0) parts.push(unitSeparator());
    parts.push(line.subarray(3));
  }
  return bytesConcat(parts);
}

/// A deterministic ORDER BY: the primary key when known, ctid otherwise.
/// Stable ordering keeps OFFSET pagination honest and keeps a row in
/// place on the page after its update commits.
export function orderSql(pk_cols: Uint8Array): Uint8Array {
  if (pk_cols.length === 0) return asciiBytes(" ORDER BY ctid");
  const names = pk_cols.split(unitSeparator());
  const parts: Uint8Array[] = [];
  parts.push(asciiBytes(" ORDER BY "));
  for (let i = 0; i < names.length; i++) {
    if (i > 0) parts.push(asciiBytes(", "));
    parts.push(identQuoted(names[i]));
  }
  return bytesConcat(parts);
}

/// One page of table data; one extra row probes for a next page.
export function dataSql(
  schema: Uint8Array,
  name: Uint8Array,
  filters: readonly FilterRow[],
  pk_cols: Uint8Array,
  offset: number,
): Uint8Array {
  return bytesConcat([
    asciiBytes("SELECT ctid, * FROM "),
    identQuoted(schema),
    asciiBytes("."),
    identQuoted(name),
    whereSql(filters),
    orderSql(pk_cols),
    asciiBytes(` LIMIT ${PAGE_SIZE + 1} OFFSET ${offset};`),
  ]);
}

/// A free-form SELECT wrapped for pagination (probe row included).
export function wrapPaged(base: Uint8Array, offset: number): Uint8Array {
  return bytesConcat([
    asciiBytes("SELECT * FROM ("),
    base,
    asciiBytes(`) AS artemis_page LIMIT ${PAGE_SIZE + 1} OFFSET ${offset};`),
  ]);
}

/// Catalog rows: record 0 is the psql header, then schema/name pairs.
export function parseTableRows(out: Uint8Array): readonly TableRef[] {
  const tables: TableRef[] = [];
  const lines = stripFinalNewline(out).split(recordSeparator());
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const sep = line.indexOf(unitSeparator());
    if (sep < 0) continue;
    tables.push({
      id: tables.length + 1,
      schema: line.subarray(0, sep),
      name: line.subarray(sep + 1),
    });
  }
  return tables;
}

export function cellAt(fields: readonly Uint8Array[], index: number): Uint8Array {
  if (index >= fields.length) return new Uint8Array(0);
  return fields[index];
}



/// The staged value for (row key, column), or the base value.
export function stagedValueFor(
  staged: readonly StagedEdit[],
  key: Uint8Array,
  col: number,
  base: Uint8Array,
): Uint8Array {
  for (let i = 0; i < staged.length; i++) {
    if (staged[i].col_index === col && bytesEqual(staged[i].key, key)) return staged[i].new_value;
  }
  return base;
}

export function stagedHas(staged: readonly StagedEdit[], key: Uint8Array, col: number): boolean {
  for (let i = 0; i < staged.length; i++) {
    if (staged[i].col_index === col && bytesEqual(staged[i].key, key)) return true;
  }
  return false;
}

/// A staged value as SQL: the literal text NULL sets the column NULL.
export function stagedSqlValue(value: Uint8Array): Uint8Array {
  if (bytesEqual(value, asciiBytes("NULL"))) return asciiBytes("NULL");
  return sqlQuoted(value);
}

/// The staged edits as one atomic batch, refreshed by the page select.
/// All edits of one ROW collapse into a single UPDATE (one predicate
/// lookup), so multi-column edits of a row always land together.
export function commitSql(
  schema: Uint8Array,
  name: Uint8Array,
  staged: readonly StagedEdit[],
  filters: readonly FilterRow[],
  pk_cols: Uint8Array,
  offset: number,
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(asciiBytes("BEGIN; "));
  for (let i = 0; i < staged.length; i++) {
    // The first edit of each row emits that row's whole UPDATE.
    let seen = false;
    for (let j = 0; j < i; j++) {
      if (bytesEqual(staged[j].key, staged[i].key)) seen = true;
    }
    if (seen) continue;
    parts.push(asciiBytes("UPDATE "));
    parts.push(identQuoted(schema));
    parts.push(asciiBytes("."));
    parts.push(identQuoted(name));
    parts.push(asciiBytes(" SET "));
    let first = true;
    for (let j = i; j < staged.length; j++) {
      if (!bytesEqual(staged[j].key, staged[i].key)) continue;
      if (!first) parts.push(asciiBytes(", "));
      parts.push(identQuoted(staged[j].column));
      parts.push(asciiBytes(" = "));
      parts.push(stagedSqlValue(staged[j].new_value));
      first = false;
    }
    parts.push(asciiBytes(" WHERE "));
    parts.push(staged[i].where_sql);
    parts.push(asciiBytes("; "));
  }
  parts.push(asciiBytes("COMMIT; "));
  parts.push(dataSql(schema, name, filters, pk_cols, offset));
  return bytesConcat(parts);
}

/// One output record's fields, capped at MAX_COLUMNS. Keyed records
/// (table views) carry the row's ctid in field 0, so data starts at 1.
export function recordFields(line: Uint8Array, keyed: boolean): readonly Uint8Array[] {
  const fields = line.split(unitSeparator());
  const out: Uint8Array[] = [];
  let start = 0;
  if (keyed) start = 1;
  for (let i = start; i < fields.length; i++) {
    if (out.length >= MAX_COLUMNS) break;
    out.push(fields[i]);
  }
  return out;
}

/// The record's row key (ctid) when the result is keyed.
export function recordKey(line: Uint8Array, keyed: boolean): Uint8Array {
  if (!keyed) return new Uint8Array(0);
  const fields = line.split(unitSeparator());
  if (fields.length === 0) return new Uint8Array(0);
  return fields[0];
}

/// The header record as the result's column list.
export function parseColumns(line: Uint8Array, keyed: boolean): readonly ColumnRef[] {
  const fields = recordFields(line, keyed);
  const out: ColumnRef[] = [];
  for (let i = 0; i < fields.length; i++) out.push({ name: fields[i] });
  return out;
}

/// One record's cells at `row`, padded to `width` so every row fills its
/// slots (a short record cannot shift the grid).
export function rowCells(line: Uint8Array, keyed: boolean, row: number, width: number): readonly CellRec[] {
  const fields = recordFields(line, keyed);
  const out: CellRec[] = [];
  for (let col = 0; col < width; col++) {
    let text: Uint8Array = new Uint8Array(0);
    if (col < fields.length) text = fields[col];
    out.push({ row: row, col: col, text: text });
  }
  return out;
}

export function rowKeyOf(line: Uint8Array, keyed: boolean): RowKey {
  return { key: recordKey(line, keyed) };
}
