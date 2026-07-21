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

/// Run SQL against a connected Postgres database (psql, native side).
export function exec(url: string, sql: string): Promise<ExecResult> {
  return invoke("db.exec", { url, sql });
}

/// Run SQL against the app's own SQLite store (sqlite3, native side).
export function storeExec(sql: string): Promise<ExecResult> {
  return invoke("store.exec", { sql });
}
