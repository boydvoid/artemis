// Chat conversations, persisted.
//
// A conversation is app data — it outlives the window, like a saved query —
// so it lives in artemis.db through `store.exec`, not in the WebView. Two
// tables, both additive and created on demand, so an older store opens fine.
//
// Each conversation keeps TWO transcripts, because they are genuinely
// different:
//
//   * `display` — what the panel shows. A probe is one short receipt here
//     ("probe · 12 rows").
//   * `model`   — what the model is told. The same probe is the full rows.
//
// Keeping only one would either show the human a wall of raw rows or resume
// a conversation the model cannot follow. They are stored side by side in
// one table, told apart by `channel`.
//
// A conversation also remembers the CLI session handle it was built on, so
// reopening it days later continues that Claude session rather than paying
// to re-upload the schema. `session_key` is what makes that safe: it
// fingerprints the setup the handle was created under (provider, model,
// binary, system prompt), and a mismatch means the handle is stale.

import { RS, US, storeExec } from "./bridge";
import type { Provider } from "./agent";
import type { ChatMessage } from "./ollama";

export interface ChatSessionRow {
  id: number;
  /// Derived from the first message; renamed by nothing else so far.
  title: string;
  provider: Provider;
  /// The CLI's own conversation id, empty for Ollama or a fresh chat.
  cliSession: string;
  /// Fingerprint of the setup `cliSession` was created under.
  sessionKey: string;
  updatedAt: string;
}

/// One rendered turn, as stored. Mirrors the panel's `Turn` minus the
/// transient bits (its React id, and whether it is still streaming).
export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
  kind: string;
  note: string;
  error: boolean;
}

export interface StoredTranscript {
  display: StoredTurn[];
  model: ChatMessage[];
}

const INIT_SQL =
  "CREATE TABLE IF NOT EXISTS chat_sessions (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id INTEGER NOT NULL, " +
  "title TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '', " +
  "cli_session TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL DEFAULT '', " +
  "updated_at TEXT NOT NULL DEFAULT ''); " +
  "CREATE TABLE IF NOT EXISTS chat_messages (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, seq INTEGER NOT NULL, " +
  "channel TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, " +
  "kind TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', " +
  "is_error INTEGER NOT NULL DEFAULT 0); ";

/// A single message is capped before it is stored. The store speaks to the
/// shell over a bridge with a 1 MiB request ceiling, and a transcript is
/// rewritten whole on every turn — so one runaway reply must not be able to
/// make the whole conversation unsaveable. The cut is marked, never silent.
const max_stored_chars = 64 * 1024;

/// The framing that carries rows back from SQLite uses these two bytes, so
/// text containing them would split a row in half on the way out. Chat text
/// has no business holding either (the probe formatter already strips them),
/// but a stored transcript is not the place to find out.
function clean(value: string): string {
  const stripped = value.replace(/[\x1e\x1f]/g, " ");
  return stripped.length > max_stored_chars
    ? `${stripped.slice(0, max_stored_chars)}\n… (truncated when saved)`
    : stripped;
}

function literal(value: string): string {
  return `'${clean(value).replace(/'/g, "''")}'`;
}

function parseRows(out: string): string[][] {
  const trimmed = out.endsWith(RS) ? out.slice(0, -1) : out;
  if (trimmed.trim().length === 0) return [];
  return trimmed
    .split(RS)
    .filter((line) => line.length > 0)
    .map((line) => line.split(US));
}

const LIST_COLUMNS = "id, title, provider, cli_session, session_key, updated_at";

function parseSessions(out: string): ChatSessionRow[] {
  const rows: ChatSessionRow[] = [];
  for (const fields of parseRows(out)) {
    if (fields.length < 6) continue;
    const id = Number.parseInt(fields[0], 10);
    if (!Number.isFinite(id) || id === 0) continue;
    rows.push({
      id,
      title: fields[1],
      provider: fields[2] as Provider,
      cliSession: fields[3],
      sessionKey: fields[4],
      updatedAt: fields[5],
    });
  }
  return rows;
}

/// Every conversation for one connection, most recent first. Scoped to the
/// connection on purpose: a chat is about a specific database's schema, and
/// showing another connection's threads would invite resuming one against
/// the wrong tables.
export async function listChatSessions(connectionId: number): Promise<ChatSessionRow[]> {
  const result = await storeExec(
    `${INIT_SQL}SELECT ${LIST_COLUMNS} FROM chat_sessions WHERE connection_id = ${connectionId} ` +
      "ORDER BY updated_at DESC, id DESC LIMIT 50;",
  );
  if (!result.ok) return [];
  return parseSessions(result.out);
}

/// Start a conversation and return its id. Called on the first message
/// rather than when the panel opens, so browsing the chat never leaves a
/// trail of empty threads.
export async function createChatSession(
  connectionId: number,
  provider: Provider,
  title: string,
): Promise<number | null> {
  const result = await storeExec(
    `${INIT_SQL}INSERT INTO chat_sessions (connection_id, title, provider, updated_at) VALUES ` +
      `(${connectionId}, ${literal(title)}, ${literal(provider)}, ${literal(new Date().toISOString())}); ` +
      "SELECT last_insert_rowid();",
  );
  if (!result.ok) return null;
  const rows = parseRows(result.out);
  const id = Number.parseInt(rows[rows.length - 1]?.[0] ?? "", 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function updateChatSession(
  id: number,
  patch: { title?: string; provider?: Provider; cliSession?: string; sessionKey?: string },
): Promise<unknown> {
  const sets: string[] = [`updated_at = ${literal(new Date().toISOString())}`];
  if (patch.title !== undefined) sets.push(`title = ${literal(patch.title)}`);
  if (patch.provider !== undefined) sets.push(`provider = ${literal(patch.provider)}`);
  if (patch.cliSession !== undefined) sets.push(`cli_session = ${literal(patch.cliSession)}`);
  if (patch.sessionKey !== undefined) sets.push(`session_key = ${literal(patch.sessionKey)}`);
  return storeExec(`${INIT_SQL}UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ${id};`);
}

export function deleteChatSession(id: number): Promise<unknown> {
  return storeExec(
    `${INIT_SQL}DELETE FROM chat_messages WHERE session_id = ${id}; ` +
      `DELETE FROM chat_sessions WHERE id = ${id};`,
  );
}

export async function loadTranscript(sessionId: number): Promise<StoredTranscript> {
  const result = await storeExec(
    `${INIT_SQL}SELECT channel, role, content, kind, note, is_error FROM chat_messages ` +
      `WHERE session_id = ${sessionId} ORDER BY seq, id;`,
  );
  const transcript: StoredTranscript = { display: [], model: [] };
  if (!result.ok) return transcript;
  for (const fields of parseRows(result.out)) {
    if (fields.length < 6) continue;
    const [channel, role, content, kind, note, isError] = fields;
    if (channel === "display") {
      transcript.display.push({
        role: role === "assistant" ? "assistant" : "user",
        content,
        kind,
        note,
        error: isError === "1",
      });
    } else {
      transcript.model.push({ role: role as ChatMessage["role"], content });
    }
  }
  return transcript;
}

/// Rewrite a conversation's transcript. Whole-file rather than incremental
/// because a turn can edit what came before it — a stream that fails
/// half-way annotates the message it was already writing — and a
/// twenty-message chat is a cheap statement.
export function saveTranscript(
  sessionId: number,
  display: StoredTurn[],
  model: ChatMessage[],
): Promise<unknown> {
  const values: string[] = [];
  display.forEach((turn, index) => {
    values.push(
      `(${sessionId}, ${index}, 'display', ${literal(turn.role)}, ${literal(turn.content)}, ` +
        `${literal(turn.kind)}, ${literal(turn.note)}, ${turn.error ? 1 : 0})`,
    );
  });
  model.forEach((message, index) => {
    values.push(
      `(${sessionId}, ${index}, 'model', ${literal(message.role)}, ${literal(message.content)}, '', '', 0)`,
    );
  });

  const insert =
    values.length === 0
      ? ""
      : "INSERT INTO chat_messages (session_id, seq, channel, role, content, kind, note, is_error) VALUES " +
        `${values.join(", ")}; `;
  return storeExec(
    `${INIT_SQL}DELETE FROM chat_messages WHERE session_id = ${sessionId}; ${insert}`,
  );
}

/// A conversation's name, taken from its opening message. Titles are not
/// generated by the model: that would cost a request per chat and, on a
/// rate-limited subscription, the user did not ask for it.
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  const clipped = line.length > 60 ? `${line.slice(0, 60)}…` : line;
  return clipped || "New chat";
}
