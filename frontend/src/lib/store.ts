// The app's own state: saved connections and saved queries.
//
// This is NOT web storage. Every read and write goes through the
// `store.exec` bridge command to the same SQLite database the canvas app
// used (`.artemis/artemis.db`), so the web layer holds no durable state of
// its own — it is a client for the app, not a second copy of it.
//
// Schema and statements mirror ../../../src/db.ts so both front ends see
// exactly one store.

import { RS, US, storeExec } from "./bridge";

export interface Connection {
  id: number;
  name: string;
  url: string;
}

export interface SavedQuery {
  id: number;
  name: string;
  sql: string;
}

/// SQLite string literal: doubling embedded quotes is what makes a
/// password containing an apostrophe safe to store.
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const INIT_SQL =
  "CREATE TABLE IF NOT EXISTS connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL); " +
  "CREATE TABLE IF NOT EXISTS saved_queries (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sql TEXT NOT NULL); " +
  // app_state is additive: the canvas app creates its tables with IF NOT
  // EXISTS and ignores anything else, so sharing the file stays safe.
  "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); ";

const LIST_SQL = "SELECT id, name, url FROM connections ORDER BY id;";

/// Every mutation ends with the LIST select, so one round trip both writes
/// and returns the fresh set — the native app's pattern, kept.
function withList(statements: string): string {
  return `${INIT_SQL}${statements}${LIST_SQL}`;
}

function parseRows(out: string): string[][] {
  const trimmed = out.endsWith(RS) ? out.slice(0, -1) : out;
  if (trimmed.trim().length === 0) return [];
  return trimmed
    .split(RS)
    .filter((line) => line.length > 0)
    .map((line) => line.split(US));
}

function parseConnections(out: string): Connection[] {
  const rows: Connection[] = [];
  for (const fields of parseRows(out)) {
    if (fields.length < 3) continue;
    const id = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(id) || id === 0) continue;
    rows.push({ id, name: fields[1], url: fields[2] });
  }
  return rows;
}

async function listing(sql: string): Promise<Connection[]> {
  const result = await storeExec(sql);
  if (!result.ok) throw new Error(result.err.trim() || "the connection store failed");
  return parseConnections(result.out);
}

export function loadConnections(): Promise<Connection[]> {
  return listing(withList(""));
}

export function addConnection(name: string, url: string): Promise<Connection[]> {
  return listing(
    withList(`INSERT INTO connections (name, url) VALUES (${literal(name)}, ${literal(url)}); `),
  );
}

export function updateConnection(id: number, name: string, url: string): Promise<Connection[]> {
  return listing(
    withList(
      `UPDATE connections SET name = ${literal(name)}, url = ${literal(url)} WHERE id = ${id}; `,
    ),
  );
}

export function deleteConnection(id: number): Promise<Connection[]> {
  return listing(withList(`DELETE FROM connections WHERE id = ${id}; `));
}

const SQ_LIST_SQL = "SELECT id, name, sql FROM saved_queries ORDER BY id;";

function parseSaved(out: string): SavedQuery[] {
  const rows: SavedQuery[] = [];
  for (const fields of parseRows(out)) {
    if (fields.length < 3) continue;
    const id = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(id) || id === 0) continue;
    // A saved statement may itself contain the unit separator only if it
    // came from outside this app; rejoin defensively so SQL survives.
    rows.push({ id, name: fields[1], sql: fields.slice(2).join(US) });
  }
  return rows;
}

async function savedListing(sql: string): Promise<SavedQuery[]> {
  const result = await storeExec(sql);
  if (!result.ok) throw new Error(result.err.trim() || "the query store failed");
  return parseSaved(result.out);
}

export function loadSavedQueries(): Promise<SavedQuery[]> {
  return savedListing(`${INIT_SQL}${SQ_LIST_SQL}`);
}

export function saveQuery(name: string, sql: string): Promise<SavedQuery[]> {
  return savedListing(
    `${INIT_SQL}INSERT INTO saved_queries (name, sql) VALUES (${literal(name)}, ${literal(sql)}); ${SQ_LIST_SQL}`,
  );
}

export function updateSavedQuery(id: number, name: string, sql: string): Promise<SavedQuery[]> {
  return savedListing(
    `${INIT_SQL}UPDATE saved_queries SET name = ${literal(name)}, sql = ${literal(sql)} WHERE id = ${id}; ${SQ_LIST_SQL}`,
  );
}

export function deleteSavedQuery(id: number): Promise<SavedQuery[]> {
  return savedListing(`${INIT_SQL}DELETE FROM saved_queries WHERE id = ${id}; ${SQ_LIST_SQL}`);
}

/// The active connection is UI state, but it should survive a restart like
/// every other preference, so it lives in the store rather than the
/// WebView.
export async function loadActiveId(): Promise<number> {
  const result = await storeExec(
    `${INIT_SQL}SELECT value FROM app_state WHERE key = 'active_connection';`,
  );
  if (!result.ok) return 0;
  const rows = parseRows(result.out);
  if (rows.length === 0) return 0;
  const id = Number.parseInt(rows[0][0], 10);
  return Number.isFinite(id) ? id : 0;
}

export async function saveActiveId(id: number): Promise<void> {
  await storeExec(
    `${INIT_SQL}INSERT INTO app_state (key, value) VALUES ('active_connection', ${literal(String(id))}) ` +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
  );
}
