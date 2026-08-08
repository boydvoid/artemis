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

  // pg_constraint rather than information_schema: one pass, no privilege
  // filtering surprises, and multi-column keys come out in order via the
  // paired unnest.
  foreignKeysSql:
    "SELECT sn.nspname, st.relname, sa.attname, tn.nspname, tt.relname, ta.attname " +
    "FROM pg_constraint c " +
    "JOIN pg_class st ON st.oid = c.conrelid " +
    "JOIN pg_namespace sn ON sn.oid = st.relnamespace " +
    "JOIN pg_class tt ON tt.oid = c.confrelid " +
    "JOIN pg_namespace tn ON tn.oid = tt.relnamespace " +
    "JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, fattnum, ord) ON true " +
    "JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = k.attnum " +
    "JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.fattnum " +
    "WHERE c.contype = 'f' AND sn.nspname NOT IN ('pg_catalog', 'information_schema') " +
    "ORDER BY sn.nspname, st.relname, c.conname, k.ord;",

  // text-ish columns plus USER-DEFINED, which is how information_schema
  // reports enums — the strongest catalog candidates of all.
  isCatalogType(type) {
    return (
      type === "text" ||
      type === "character varying" ||
      type === "character" ||
      type === "USER-DEFINED"
    );
  },

  // Per column: distinct over a 1000-row sample, capped at 26 values. The
  // sample bounds the work on huge tables; `::text` renders enums.
  valueCatalogSql(targets) {
    const parts = targets.map(({ schema, table, column }) => {
      const tableId = literal(`${schema}.${table}`);
      const col = ident(column);
      return (
        `SELECT ${tableId}, ${literal(column)}, v::text FROM ` +
        `(SELECT DISTINCT ${col} AS v FROM ` +
        `(SELECT ${col} FROM ${ident(schema)}.${ident(table)} WHERE ${col} IS NOT NULL LIMIT 1000) s0 ` +
        `LIMIT 26) s1`
      );
    });
    return parts.join("\nUNION ALL\n") + ";";
  },

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
