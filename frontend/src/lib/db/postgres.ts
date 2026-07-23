// The Postgres dialect. Runs through `psql` on the native side.

import { ident, literal, type Dialect } from "./dialect";

export const postgresDialect: Dialect = {
  kind: "postgres",
  driver: "postgres",
  // Every heap table has a ctid; it changes when a row is UPDATEd, which is
  // exactly why the page re-fetches after a commit.
  rowKey: "ctid",

  tablesSql:
    "SELECT table_schema, table_name FROM information_schema.tables " +
    "WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') " +
    "ORDER BY table_schema, table_name;",

  columnsSql:
    "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns " +
    "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') " +
    "ORDER BY table_schema, table_name, ordinal_position;",

  pkSql(schema, name) {
    const qualified = `${ident(schema)}.${ident(name)}`;
    return (
      "SELECT 'pk:' || a.attname FROM pg_index i " +
      "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) " +
      `WHERE i.indrelid = ${literal(qualified)}::regclass AND i.indisprimary ORDER BY a.attnum;`
    );
  },

  contains(quotedColumn, value) {
    return `${quotedColumn}::text ILIKE ${literal(`%${value}%`)}`;
  },
};
