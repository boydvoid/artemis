// Data access - the one place SQLite lives.
//
// Connections and saved queries persist in a local SQLite database
// (.artemis/artemis.db) driven through the system `sqlite3` CLI via
// Cmd.spawn. Every statement batch ends with the matching LIST select,
// so each operation's exit delivers the fresh row set and one loaded
// arm per table is the single reload path. Output rows are framed with
// the ASCII unit/record separators so values containing newlines or
// pipes cannot corrupt parsing.

import { asciiBytes } from "@native-sdk/core";
import { type ConnectionRow, type SavedQuery } from "./types.ts";
import { bytesConcat, sqlQuoted, parseDecimal, unitSeparator, recordSeparator } from "./bytes.ts";

export const DB_PATH = asciiBytes(".artemis/artemis.db");

const INIT_SQL = asciiBytes(
  "CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL); ",
);

const LIST_SQL = asciiBytes("SELECT id, name, url FROM connections ORDER BY id;");

const SQ_INIT_SQL = asciiBytes(
  "CREATE TABLE IF NOT EXISTS saved_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sql TEXT NOT NULL); ",
);

const SQ_LIST_SQL = asciiBytes("SELECT id, name, sql FROM saved_queries ORDER BY id;");

export function dbInitListSql(): Uint8Array {
  return bytesConcat([INIT_SQL, LIST_SQL]);
}

export function dbInsertSql(name: Uint8Array, url: Uint8Array): Uint8Array {
  return bytesConcat([
    asciiBytes("INSERT INTO connections (name, url) VALUES ("),
    sqlQuoted(name),
    asciiBytes(", "),
    sqlQuoted(url),
    asciiBytes("); "),
    LIST_SQL,
  ]);
}

export function dbUpdateSql(id: number, name: Uint8Array, url: Uint8Array): Uint8Array {
  return bytesConcat([
    asciiBytes("UPDATE connections SET name = "),
    sqlQuoted(name),
    asciiBytes(", url = "),
    sqlQuoted(url),
    asciiBytes(` WHERE id = ${id}; `),
    LIST_SQL,
  ]);
}

export function dbDeleteSql(id: number): Uint8Array {
  return bytesConcat([asciiBytes(`DELETE FROM connections WHERE id = ${id}; `), LIST_SQL]);
}

export function sqInitListSql(): Uint8Array {
  return bytesConcat([SQ_INIT_SQL, SQ_LIST_SQL]);
}

export function sqInsertSql(name: Uint8Array, sql: Uint8Array): Uint8Array {
  return bytesConcat([
    asciiBytes("INSERT INTO saved_queries (name, sql) VALUES ("),
    sqlQuoted(name),
    asciiBytes(", "),
    sqlQuoted(sql),
    asciiBytes("); "),
    SQ_LIST_SQL,
  ]);
}

export function sqDeleteSql(id: number): Uint8Array {
  return bytesConcat([asciiBytes(`DELETE FROM saved_queries WHERE id = ${id}; `), SQ_LIST_SQL]);
}

export function parseConnectionRows(out: Uint8Array): readonly ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  const lines = out.split(recordSeparator());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstSep = line.indexOf(unitSeparator());
    if (firstSep < 0) continue;
    const rest = line.subarray(firstSep + 1);
    const secondSep = rest.indexOf(unitSeparator());
    if (secondSep < 0) continue;
    const id = parseDecimal(line.subarray(0, firstSep).trim());
    if (id === 0) continue;
    rows.push({
      id: id,
      name: rest.subarray(0, secondSep),
      url: rest.subarray(secondSep + 1),
    });
  }
  return rows;
}

export function parseSavedRows(out: Uint8Array): readonly SavedQuery[] {
  const rows: SavedQuery[] = [];
  const lines = out.split(recordSeparator());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstSep = line.indexOf(unitSeparator());
    if (firstSep < 0) continue;
    const rest = line.subarray(firstSep + 1);
    const secondSep = rest.indexOf(unitSeparator());
    if (secondSep < 0) continue;
    const id = parseDecimal(line.subarray(0, firstSep).trim());
    if (id === 0) continue;
    rows.push({
      id: id,
      name: rest.subarray(0, secondSep),
      sql: rest.subarray(secondSep + 1),
    });
  }
  return rows;
}
