// The web side of the Ollama bridge.
//
// The WebView cannot call Ollama directly — its origin is rejected by
// Ollama's CORS and navigation is locked down — so every call goes through
// the native shell, exactly like `db.exec`. Three commands:
//
//   * `ollama.tags`  → the local model list.
//   * `ollama.chat`  → streams a reply; token deltas arrive as `ollama.token`
//                      events, and the bridge promise resolves when the
//                      stream ends (or rejects on failure).
//   * `ollama.cancel`→ stop an in-flight `ollama.chat` by its stream id.
//
// This module never talks HTTP. It builds the request body, correlates the
// streamed tokens, and hands plain strings to the UI.

import { invokeCommand, onNativeEvent } from "./bridge";

/// Ollama's default local endpoint. The endpoint is a stored setting so
/// custom hosts (and, later, remote ones) need no code change.
export const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";

export interface OllamaModel {
  name: string;
  /// Human size like "1.1 GB", derived from the daemon's byte count.
  size?: string;
  /// Parameter size from the model details, e.g. "1B".
  params?: string;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/// The bridge envelope shared with `db.exec` — Ollama commands reuse it so
/// the ok/err contract is identical across the app.
interface BridgeResult {
  ok: boolean;
  code: number;
  out: string;
  err: string;
}

/// Thrown when Ollama cannot be reached or returns an error, carrying a
/// message already fit to show the user.
export class OllamaError extends Error {}

function humanSize(bytes: unknown): string | undefined {
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/// GET /api/tags via the shell, parsed into a tidy model list. Throws an
/// `OllamaError` with a readable message when the daemon is down.
export async function listModels(endpoint: string): Promise<OllamaModel[]> {
  const result = await invokeCommand<BridgeResult>("ollama.tags", { url: endpoint });
  if (!result.ok) {
    throw new OllamaError(result.err.trim() || "Could not reach Ollama.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.out);
  } catch {
    throw new OllamaError("Ollama sent an unreadable model list.");
  }
  const models = (parsed as { models?: unknown[] }).models ?? [];
  return models
    .map((raw): OllamaModel | null => {
      const m = raw as { name?: string; model?: string; size?: number; details?: { parameter_size?: string } };
      const name = m.name ?? m.model;
      if (!name) return null;
      return { name, size: humanSize(m.size), params: m.details?.parameter_size };
    })
    .filter((m): m is OllamaModel => m !== null);
}

/// A random, collision-proof id for one chat stream. `crypto.randomUUID` is
/// available in the WebView; the timestamp fallback covers older engines.
function newStreamId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export interface ChatOptions {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  /// Called for each streamed token as it arrives.
  onToken: (delta: string) => void;
}

/// A handle on a running chat: await `done` for completion (it rejects with
/// an `OllamaError` on failure), or call `cancel()` to stop it early.
export interface ChatHandle {
  id: string;
  done: Promise<void>;
  cancel: () => void;
}

/// Start a streaming chat. Tokens are delivered through `onToken`; the
/// returned `done` promise settles when the stream ends. The subscription is
/// always torn down, whether the stream finishes, fails, or is cancelled.
export function chat(options: ChatOptions): ChatHandle {
  const id = newStreamId();
  const body = JSON.stringify({
    model: options.model,
    messages: options.messages,
    stream: true,
  });

  const unsubscribe = onNativeEvent<{ id: string; delta: string }>("ollama.token", (detail) => {
    if (detail && detail.id === id) options.onToken(detail.delta);
  });

  const done = invokeCommand<BridgeResult>("ollama.chat", { url: options.endpoint, body, id })
    .then((result) => {
      if (!result.ok) throw new OllamaError(result.err.trim() || "The chat request failed.");
    })
    .finally(unsubscribe);

  const cancel = () => {
    void invokeCommand("ollama.cancel", { id }).catch(() => {});
  };

  return { id, done, cancel };
}
