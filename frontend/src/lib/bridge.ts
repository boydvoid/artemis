// The one seam to the native shell.
//
// `db.exec` runs a statement through psql on the Zig side and hands back
// raw stdout in unit/record-separator framing. Everything above this file
// works in plain strings.

export const US = "\x1f"; // field separator  (psql -F)
export const RS = "\x1e"; // record separator (psql -R)

export interface ExecResult {
  ok: boolean;
  code: number;
  out: string;
  err: string;
  truncated: boolean;
}

/// A result too large for one bridge response arrives in pieces: the first
/// reply carries a stash handle, and `db.chunk` returns the rest. Callers
/// never see this — `exec` reassembles before returning.
interface ChunkedExecResult extends ExecResult {
  more?: { handle: number; next: number; total: number } | null;
}

interface Chunk {
  ok: boolean;
  data: string;
  next: number;
  done: boolean;
}

interface ZeroApi {
  invoke<T>(command: string, payload?: unknown): Promise<T>;
}

function zero(): ZeroApi | null {
  return (window as unknown as { zero?: ZeroApi }).zero ?? null;
}

/// True when running inside the native shell. In a plain browser tab
/// (`npm run dev` without the shell) there is no bridge and every query
/// fails honestly rather than hanging.
export function bridgeAvailable(): boolean {
  return zero() !== null;
}

const NO_BRIDGE =
  "No native bridge. Run the app with `native dev` rather than opening the dev server in a browser.";

async function invoke(command: string, payload: unknown): Promise<ExecResult> {
  const api = zero();
  if (!api) {
    return { ok: false, code: -1, out: "", err: NO_BRIDGE, truncated: false };
  }
  try {
    return await api.invoke<ExecResult>(command, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: -1, out: "", err: message, truncated: false };
  }
}

/// Run SQL against a connected database. `driver` picks the native client
/// (`postgres` → psql, `sqlite` → sqlite3); `url` is that connection's URL.
/// Oversized results come back in chunks; they are reassembled here so
/// every caller keeps seeing one complete ExecResult.
export async function exec(
  url: string,
  sql: string,
  driver = "postgres",
): Promise<ExecResult> {
  const first = (await invoke("db.exec", { url, sql, driver })) as ChunkedExecResult;
  const base: ExecResult = {
    ok: first.ok,
    code: first.code,
    out: first.out,
    err: first.err,
    truncated: first.truncated,
  };
  if (!first.more) return base;

  const api = zero();
  if (!api) return base;

  let out = first.out;
  let offset = first.more.next;
  const handle = first.more.handle;
  try {
    for (;;) {
      const chunk = await api.invoke<Chunk>("db.chunk", { handle, offset });
      if (!chunk.ok) {
        // The stash evicted this result (too many large queries at once).
        // A partial result presented as whole would be a silent lie.
        return {
          ...base,
          ok: false,
          out: "",
          err: "Result expired before it was fully delivered - run the query again.",
        };
      }
      out += chunk.data;
      if (chunk.done) break;
      offset = chunk.next;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, ok: false, out: "", err: message };
  }
  return { ...base, out };
}

/// Open the native file picker for a SQLite database. Resolves to the chosen
/// absolute path, or null if cancelled or unavailable (no shell / no picker).
export async function pickSqliteFile(): Promise<string | null> {
  const api = zero();
  if (!api) return null;
  try {
    const result = await api.invoke<{ path: string | null }>("dialog.pickFile");
    return result.path ?? null;
  } catch {
    return null;
  }
}

/// Run SQL against the app's own SQLite store (sqlite3, native side).
export function storeExec(sql: string): Promise<ExecResult> {
  return invoke("store.exec", { sql });
}
