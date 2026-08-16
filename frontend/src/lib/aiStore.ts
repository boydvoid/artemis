// AI settings persistence.
//
// Which backend the chat runs on, and each backend's own settings, are
// preferences — so, like the active connection in ./store.ts, they live in
// the app's SQLite store through the `store.exec` bridge rather than in the
// WebView. A handful of `app_state` keys is all it takes; the table is
// created by store.ts's INIT_SQL, so this module only reads and upserts.
//
// Nothing secret is kept here. The CLI backends authenticate through their
// own login (`claude`, `codex login`), so there is no API key to store —
// only a model name and, if the binary lives somewhere unusual, its path.

import { storeExec } from "./bridge";
import { DEFAULT_ENDPOINT } from "./ollama";
import type { Provider } from "./agent";

export interface AiSettings {
  /// Which backend the chat talks to.
  provider: Provider;
  /// Ollama: daemon endpoint and chosen local model.
  endpoint: string;
  model: string;
  /// Claude Code CLI: model id (blank = the CLI's own default) and an
  /// optional path to the binary.
  claudeModel: string;
  claudeBinary: string;
  /// Codex CLI, same two.
  codexModel: string;
  codexBinary: string;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "ollama",
  endpoint: DEFAULT_ENDPOINT,
  model: "",
  claudeModel: "",
  claudeBinary: "",
  codexModel: "",
  codexBinary: "",
};

const INIT_SQL =
  "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); ";

/// Setting → `app_state` key. The two original keys keep their names so an
/// existing store keeps its Ollama preferences.
const KEYS: Record<keyof AiSettings, string> = {
  provider: "ai_provider",
  endpoint: "ai_endpoint",
  model: "ai_model",
  claudeModel: "ai_claude_model",
  claudeBinary: "ai_claude_binary",
  codexModel: "ai_codex_model",
  codexBinary: "ai_codex_binary",
};

/// SQLite string literal: doubling embedded quotes keeps a value safe.
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/// Record-separator framing from the store, same as store.ts.
const RS = "\x1e";
const US = "\x1f";

function readValues(out: string): Map<string, string> {
  const values = new Map<string, string>();
  const trimmed = out.endsWith(RS) ? out.slice(0, -1) : out;
  for (const line of trimmed.split(RS)) {
    if (line.length === 0) continue;
    const fields = line.split(US);
    if (fields.length >= 2) values.set(fields[0], fields[1]);
  }
  return values;
}

function isProvider(value: string): value is Provider {
  return value === "ollama" || value === "claude" || value === "codex";
}

/// Load every setting in one round trip, falling back to the defaults for
/// anything a previous version never wrote.
export async function loadAiSettings(): Promise<AiSettings> {
  const keys = Object.values(KEYS).map(literal).join(", ");
  const result = await storeExec(
    `${INIT_SQL}SELECT key, value FROM app_state WHERE key IN (${keys});`,
  );
  if (!result.ok) return { ...DEFAULT_AI_SETTINGS };

  const values = readValues(result.out);
  const provider = values.get(KEYS.provider) ?? "";
  return {
    provider: isProvider(provider) ? provider : DEFAULT_AI_SETTINGS.provider,
    endpoint: values.get(KEYS.endpoint) ?? DEFAULT_AI_SETTINGS.endpoint,
    model: values.get(KEYS.model) ?? DEFAULT_AI_SETTINGS.model,
    claudeModel: values.get(KEYS.claudeModel) ?? DEFAULT_AI_SETTINGS.claudeModel,
    claudeBinary: values.get(KEYS.claudeBinary) ?? DEFAULT_AI_SETTINGS.claudeBinary,
    codexModel: values.get(KEYS.codexModel) ?? DEFAULT_AI_SETTINGS.codexModel,
    codexBinary: values.get(KEYS.codexBinary) ?? DEFAULT_AI_SETTINGS.codexBinary,
  };
}

/// Persist the settings a patch actually changed, in one statement.
export function saveAiSettings(patch: Partial<AiSettings>): Promise<unknown> {
  const rows = (Object.keys(patch) as (keyof AiSettings)[])
    .map((field) => `(${literal(KEYS[field])}, ${literal(String(patch[field]))})`)
    .join(", ");
  if (rows.length === 0) return Promise.resolve();
  return storeExec(
    `${INIT_SQL}INSERT INTO app_state (key, value) VALUES ${rows} ` +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
  );
}
