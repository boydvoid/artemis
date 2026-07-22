// The SQLite dialect. Runs through `sqlite3` on the native side.
//
// SQLite has no schema namespace to speak of, so tables report a synthetic
// `main` schema — that keeps the (schema, name) shape the rest of the app
// expects, and `"main"."orders"` is valid SQLite. Row identity is `rowid`
// (an ordinary table always has one; a WITHOUT ROWID table must have a
// primary key, which the editor falls back to).

import { literal, type Dialect } from "./dialect";

export const sqliteDialect: Dialect = {
  kind: "sqlite",
  driver: "sqlite",
  rowKey: "rowid",

  tablesSql:
    "SELECT 'main' AS table_schema, name AS table_name FROM sqlite_master " +
    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",

  // `schema` is always the synthetic "main"; pragma_table_info addresses the
  // table by bare name. Emitting `pk:<name>` matches the Postgres shape so
  // the shared parser needs no branch.
  pkSql(_schema, name) {
    return `SELECT 'pk:' || name FROM pragma_table_info(${literal(name)}) WHERE pk > 0 ORDER BY pk;`;
  },

  // SQLite LIKE is case-insensitive for ASCII by default; CAST makes it work
  // on non-text columns the same way Postgres's `::text` does.
  contains(quotedColumn, value) {
    return `CAST(${quotedColumn} AS TEXT) LIKE ${literal(`%${value}%`)}`;
  },
};
