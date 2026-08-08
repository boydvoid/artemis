// psql output parsing, ported from the native app's parsePage/parseTableRows.
//
// With `-A -F <US> -R <RS> -P footer=off`, psql emits one record per row
// separated by RS, fields separated by US, and record 0 is the header.
// An unquoted empty field is SQL NULL — psql prints nothing for it — so
// NULL and empty string are genuinely indistinguishable in this format.
// That ambiguity is inherited from the native app; it is called out here
// because the grid renders both as a dimmed NULL marker.

import { RS, US } from "./bridge";

/// What psql prints for SQL NULL (`-P null=` on the native side). With it,
/// NULL and empty string are finally distinguishable: an empty field is a
/// real empty string, and this marker is NULL.
export const NULL_FIELD = "\x01";

export function isNullField(value: string): boolean {
  return value === NULL_FIELD;
}

/// The editing representation of a raw field: a NULL cell opens as the
/// text "NULL", which is also what commits back as SQL NULL — the same
/// convention the app has always had, now round-trip coherent.
export function editText(value: string): string {
  return value === NULL_FIELD ? "NULL" : value;
}

export interface TableRef {
  id: string;
  schema: string;
  name: string;
}

/// One column of a table, for the AI chat's schema context.
export interface ColumnRef {
  name: string;
  type: string;
}

/// Columns grouped by their table id (`schema.name`), as `columnsSql`
/// returns them. Table order and column order are preserved.
export type SchemaColumns = Map<string, ColumnRef[]>;

/// Parse `(table_schema, table_name, column_name, data_type)` records into a
/// map keyed by `schema.name`. Skips the header record.
export function parseColumns(out: string): SchemaColumns {
  const lines = records(out);
  const schema: SchemaColumns = new Map();
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(US);
    if (fields.length < 4) continue;
    const [tableSchema, tableName, column, type] = fields;
    const id = `${tableSchema}.${tableName}`;
    const cols = schema.get(id);
    const ref: ColumnRef = { name: column, type };
    if (cols) cols.push(ref);
    else schema.set(id, [ref]);
  }
  return schema;
}

/// One foreign key column pair, for the AI chat's join paths. Table ids use
/// the same `schema.name` shape as `SchemaColumns` keys.
export interface ForeignKeyRef {
  tableId: string;
  column: string;
  refTableId: string;
  /// Empty when the FK references the target's primary key implicitly
  /// (SQLite allows omitting the column list).
  refColumn: string;
}

/// Parse `(table_schema, table_name, column_name, foreign_schema,
/// foreign_name, foreign_column)` records. Skips the header record.
export function parseForeignKeys(out: string): ForeignKeyRef[] {
  const lines = records(out);
  const fks: ForeignKeyRef[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(US);
    if (fields.length < 6) continue;
    const [schema, table, column, refSchema, refTable, refColumn] = fields;
    if (!table || !column || !refTable) continue;
    fks.push({
      tableId: `${schema}.${table}`,
      column,
      refTableId: `${refSchema}.${refTable}`,
      refColumn: isNullField(refColumn) ? "" : refColumn,
    });
  }
  return fks;
}

/// The complete value list of one small text column, for the AI chat. Only
/// columns whose (sampled) values are few and short qualify — these are the
/// enum-like columns ("status", "name", "plan") whose actual values decide
/// which table a request like "the flowiki org" is really about.
export interface ColumnValues {
  tableId: string;
  column: string;
  values: string[];
}

/// How many distinct values still count as "enum-like". The catalog query
/// fetches one more than this so an over-full column can be told apart from
/// one with exactly the cap.
export const VALUE_CATALOG_CAP = 25;

/// Parse `(table_id, column_name, value)` records into per-column value
/// lists, dropping any column that proves to be free text after all: more
/// distinct values than the cap, or values too long to be labels.
export function parseValueCatalog(out: string): ColumnValues[] {
  const lines = records(out);
  const groups = new Map<string, ColumnValues>();
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(US);
    if (fields.length < 3) continue;
    const [tableId, column, value] = fields;
    if (isNullField(value)) continue;
    const key = `${tableId}\x1f${column}`;
    let group = groups.get(key);
    if (!group) {
      group = { tableId, column, values: [] };
      groups.set(key, group);
    }
    group.values.push(value);
  }
  const catalog: ColumnValues[] = [];
  for (const group of groups.values()) {
    if (group.values.length === 0 || group.values.length > VALUE_CATALOG_CAP) continue;
    if (group.values.some((v) => v.length > 80)) continue;
    catalog.push(group);
  }
  return catalog;
}

export interface Page {
  cols: string[];
  rows: string[][];
  /// ctid per row when the query was keyed; empty otherwise.
  keys: string[];
  hasNext: boolean;
}

function records(out: string): string[] {
  const trimmed = out.endsWith("\n") ? out.slice(0, -1) : out;
  if (trimmed.length === 0) return [];
  return trimmed.split(RS).filter((line) => line.length > 0);
}

export function parseTables(out: string): TableRef[] {
  const lines = records(out);
  const tables: TableRef[] = [];
  // Record 0 is the psql header row.
  for (let i = 1; i < lines.length; i++) {
    const sep = lines[i].indexOf(US);
    if (sep < 0) continue;
    const schema = lines[i].slice(0, sep);
    const name = lines[i].slice(sep + 1);
    tables.push({ id: `${schema}.${name}`, schema, name });
  }
  return tables;
}

export function parsePkCols(out: string): string[] {
  const lines = records(out);
  const cols: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("pk:")) cols.push(lines[i].slice(3));
  }
  return cols;
}

/// A single count(*) value: record 0 is the header, record 1 the number.
export function parseCount(out: string): number | null {
  const lines = records(out);
  if (lines.length < 2) return null;
  const value = Number.parseInt(lines[1], 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/// One page of results. `keyed` means the statement selected `ctid, *`,
/// so field 0 is the row key rather than user data.
export function parsePage(out: string, keyed: boolean, cap: number): Page {
  const lines = records(out);
  if (lines.length === 0) return { cols: [], rows: [], keys: [], hasNext: false };

  const header = lines[0].split(US);
  const cols = keyed ? header.slice(1) : header;

  const rows: string[][] = [];
  const keys: string[] = [];
  let hasNext = false;

  for (let i = 1; i < lines.length; i++) {
    if (rows.length >= cap) {
      // The probe row exists, so there is another page. It is never shown.
      hasNext = true;
      break;
    }
    const fields = lines[i].split(US);
    if (keyed) {
      keys.push(fields[0] ?? "");
      rows.push(padTo(fields.slice(1), cols.length));
    } else {
      rows.push(padTo(fields, cols.length));
    }
  }

  return { cols, rows, keys, hasNext };
}

/// A short row is padded rather than dropped: a ragged record should show
/// as blank trailing cells, never as a column shift.
function padTo(fields: string[], width: number): string[] {
  if (fields.length >= width) return fields.slice(0, width);
  return fields.concat(new Array(width - fields.length).fill(""));
}
