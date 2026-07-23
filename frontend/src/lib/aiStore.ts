// AI settings persistence.
//
// The Ollama endpoint and the last-chosen model are preferences, so — like
// the active connection in ./store.ts — they live in the app's SQLite store
// through the `store.exec` bridge, not in the WebView. Two `app_state` keys
// are all it takes; the table is created by store.ts's INIT_SQL, so this
// module only reads and upserts.

import { storeExec } from "./bridge";
import { DEFAULT_ENDPOINT } from "./ollama";

export interface AiSettings {
  endpoint: string;
  model: string;
}

const INIT_SQL =
  "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); ";

const ENDPOINT_KEY = "ai_endpoint";
const MODEL_KEY = "ai_model";

/// SQLite string literal: doubling embedded quotes keeps a value safe.
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/// Record-separator framing from the store, same as store.ts.
const RS = "\x1e";
const US = "\x1f";

function readValue(out: string, key: string): string | null {
  const trimmed = out.endsWith(RS) ? out.slice(0, -1) : out;
  for (const line of trimmed.split(RS)) {
    if (line.length === 0) continue;
    const fields = line.split(US);
    if (fields.length >= 2 && fields[0] === key) return fields[1];
  }
  return null;
}

/// Load both settings in one round trip, falling back to the Ollama default
/// endpoint and an empty model (meaning "pick the first available").
export async function loadAiSettings(): Promise<AiSettings> {
  const result = await storeExec(
    `${INIT_SQL}SELECT key, value FROM app_state WHERE key IN (${literal(ENDPOINT_KEY)}, ${literal(MODEL_KEY)});`,
  );
  if (!result.ok) return { endpoint: DEFAULT_ENDPOINT, model: "" };
  return {
    endpoint: readValue(result.out, ENDPOINT_KEY) ?? DEFAULT_ENDPOINT,
    model: readValue(result.out, MODEL_KEY) ?? "",
  };
}

function upsert(key: string, value: string): Promise<unknown> {
  return storeExec(
    `${INIT_SQL}INSERT INTO app_state (key, value) VALUES (${literal(key)}, ${literal(value)}) ` +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
  );
}

export function saveEndpoint(endpoint: string): Promise<unknown> {
  return upsert(ENDPOINT_KEY, endpoint);
}

export function saveModel(model: string): Promise<unknown> {
  return upsert(MODEL_KEY, model);
}
