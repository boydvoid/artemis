// Database dialects.
//
// One connection speaks one SQL dialect. Almost everything the app builds is
// identical across engines — both Postgres and SQLite quote identifiers with
// `"..."` and literals with `'...'`, both take LIMIT/OFFSET, IS NULL, and the
// comparison operators. A `Dialect` carries only the pieces that actually
// differ, so the SQL builders in `../sql.ts` stay one shared body.
//
// The dialect of a connection is a pure function of its URL scheme — a
// `sqlite:` prefix means SQLite, anything else Postgres — so no schema
// migration was needed to add a second engine: the `url` column already
// says everything.

export type DbKind = "postgres" | "sqlite";

/// A quoted identifier. Doubling embedded quotes is what makes a column
/// literally named `we"ird` safe to interpolate. Both engines agree here.
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/// A quoted literal, same doubling rule for single quotes.
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface Dialect {
  kind: DbKind;
  /// Sent to the native bridge so it knows which client to shell out to
  /// (`psql` vs `sqlite3`).
  driver: string;
  /// The implicit per-row identity column — `ctid` (Postgres) / `rowid`
  /// (SQLite) — selected as field 0 so the grid can address a row for editing
  /// even when the table has no primary key.
  rowKey: string;
  /// Lists browsable tables as `(table_schema, table_name)` records.
  tablesSql: string;
  /// Primary-key columns of one table, each emitted as a `pk:<name>` record
  /// so the shared parser reads them the same way for every engine.
  pkSql(schema: string, name: string): string;
  /// The `contains` operator: a case-insensitive substring match that works
  /// on any column type (numbers included), so the value is cast to text.
  contains(quotedColumn: string, value: string): string;
}

/// The dialect a connection URL implies. SQLite connections are stored as
/// `sqlite:<path>`; everything else is Postgres.
export function connectionKind(url: string): DbKind {
  return url.startsWith("sqlite:") ? "sqlite" : "postgres";
}
