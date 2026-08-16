// The web side of the coding-agent CLI bridge.
//
// Alongside Ollama, the chat can run on a CLI the user has already signed
// into — Claude Code or Codex. The subscription IS the login: the shell
// spawns `claude` / `codex`, and whatever seat that CLI is authenticated
// with is the seat the reply is billed to. No API key is entered anywhere,
// and none is passed through this module.
//
// Three commands, mirroring the Ollama ones:
//
//   * `agent.status` → is the CLI installed, and which version.
//   * `agent.chat`   → streams a reply; deltas arrive as `agent.token`
//                      events and the promise resolves with the session
//                      handle when the run ends.
//   * `agent.cancel` → stop an in-flight run by its stream id.
//
// This module spawns nothing and parses no CLI output. It shapes the turn
// (what is system prompt, what is transcript, what can be resumed) and
// hands plain strings to the UI.

import { invokeCommand, onNativeEvent } from "./bridge";
import type { ChatMessage } from "./ollama";

/// Every backend the chat can run on. "ollama" is the local daemon; the
/// rest are CLIs driven as child processes.
export type Provider = "ollama" | "claude" | "codex";

export type CliProvider = Exclude<Provider, "ollama">;

export function isCliProvider(provider: Provider): provider is CliProvider {
  return provider === "claude" || provider === "codex";
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  claude: "Claude CLI",
  codex: "Codex CLI",
};

/// The picker's own labels — the "CLI" suffix is noise when all three sit
/// side by side and the row is already about which CLI answers.
export const PROVIDER_SHORT_LABELS: Record<Provider, string> = {
  ollama: "Ollama",
  claude: "Claude",
  codex: "Codex",
};

/// Display order: the local backend first, then the two subscriptions.
export const PROVIDERS: Provider[] = ["ollama", "claude", "codex"];

/// One line on what each backend costs the user, shown under the picker.
export const PROVIDER_BLURBS: Record<Provider, string> = {
  ollama: "Local models — nothing leaves this machine.",
  claude: "Your Claude subscription, through the signed-in CLI.",
  codex: "Your ChatGPT subscription, through the signed-in CLI.",
};

/// Model ids offered as suggestions per CLI. Deliberately a datalist rather
/// than a closed list: both vendors ship new ids faster than this app does,
/// and an empty value means "whatever the CLI is configured to use".
export const MODEL_SUGGESTIONS: Record<CliProvider, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5", "gpt-5-codex"],
};

/// How the user signs the CLI in, shown when it is installed but rejected.
export const LOGIN_HINTS: Record<CliProvider, string> = {
  claude: "Run `claude` in a terminal and sign in.",
  codex: "Run `codex login` in a terminal.",
};

export const INSTALL_HINTS: Record<CliProvider, string> = {
  claude: "Install Claude Code, then sign in with your Claude subscription.",
  codex: "Install the Codex CLI, then sign in with your ChatGPT subscription.",
};

/// The bridge envelope shared with `db.exec`.
interface BridgeResult {
  ok: boolean;
  code: number;
  out: string;
  err: string;
}

/// Thrown when the CLI cannot be run or reports a failure, carrying a
/// message already fit to show the user.
export class AgentError extends Error {}

export interface AgentStatus {
  installed: boolean;
  /// Where the binary was found, once it has been.
  path: string;
  /// The CLI's own `--version` line.
  version: string;
  /// Why it is unavailable, when it is.
  message: string;
}

/// Look for the CLI and read its version. Never throws: "not installed" is
/// an ordinary answer, and the panel shows it as guidance rather than an
/// error. `binary` is the user's optional path override.
export async function agentStatus(provider: CliProvider, binary: string): Promise<AgentStatus> {
  try {
    const result = await invokeCommand<BridgeResult>("agent.status", { provider, binary });
    if (!result.ok) {
      return { installed: false, path: "", version: "", message: result.err.trim() || "not found" };
    }
    const parsed = JSON.parse(result.out) as { path?: string; version?: string };
    return {
      installed: true,
      path: parsed.path ?? "",
      version: parsed.version ?? "",
      message: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { installed: false, path: "", version: "", message };
  }
}

function newStreamId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `a-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/// Flatten a conversation into one prompt. Used whenever the turn cannot
/// resume a CLI session — the CLI has no memory of the exchange, so the
/// exchange has to be in the text.
export function renderTranscript(messages: ChatMessage[]): string {
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 1) return turns[0].content;
  return turns
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export interface Turn {
  system: string;
  prompt: string;
  session: string;
}

/// Decide what actually goes to the CLI for this turn.
///
/// Resuming matters more here than it does with a local model: the system
/// prompt carries the whole schema, and a subscription is rate-limited, so
/// resending it every message is real money. Claude can continue a session
/// by id, in which case only the new message is sent. Codex cannot — its
/// `exec resume` does not emit the JSON stream we read — so its turns are
/// always the full transcript, with the system prompt folded in because the
/// CLI has no flag for one.
///
/// A resumed turn still carries the system prompt. `--resume` restores the
/// transcript but not the prompt the session was started with, so leaving
/// it off is exactly how a chat forgets which database it is looking at.
export function buildTurn(
  provider: CliProvider,
  system: string,
  messages: ChatMessage[],
  session: string,
): Turn {
  if (provider === "claude" && session) {
    const last = messages[messages.length - 1];
    return { system, prompt: last?.content ?? "", session };
  }
  const transcript = renderTranscript(messages);
  if (provider === "claude") return { system, prompt: transcript, session: "" };
  return {
    system: "",
    prompt: system ? `${system}\n\n---\n\n${transcript}` : transcript,
    session: "",
  };
}

/// Fingerprint of the setup a CLI session was created under. A stored
/// session handle is only safe to resume while this matches: the session
/// was started with one system prompt, one model and one binary, and
/// continuing it under different ones would answer about the wrong schema.
///
/// Hashed rather than kept whole because the system prompt IS the schema —
/// tens of kilobytes — and this is written next to every conversation.
export function turnKey(provider: CliProvider, model: string, binary: string, system: string): string {
  const source = `${provider}|${model}|${binary}|${system}`;
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(36)}-${source.length.toString(36)}`;
}

export interface AgentChatOptions {
  provider: CliProvider;
  /// Optional path override; empty means "find the binary".
  binary: string;
  model: string;
  system: string;
  prompt: string;
  session: string;
  onToken: (delta: string) => void;
}

/// A running CLI turn. `done` resolves with the session handle to reuse for
/// the next message (empty when the CLI gave none), and rejects with an
/// `AgentError` on failure.
export interface AgentChatHandle {
  id: string;
  done: Promise<{ session: string }>;
  cancel: () => void;
}

export function agentChat(options: AgentChatOptions): AgentChatHandle {
  const id = newStreamId();

  const unsubscribe = onNativeEvent<{ id: string; delta: string }>("agent.token", (detail) => {
    if (detail && detail.id === id) options.onToken(detail.delta);
  });

  const done = invokeCommand<BridgeResult>("agent.chat", {
    provider: options.provider,
    binary: options.binary,
    model: options.model,
    system: options.system,
    prompt: options.prompt,
    session: options.session,
    id,
  })
    .then((result) => {
      // A failed run still reports its session, but resuming into a broken
      // conversation only repeats the failure — the caller drops it.
      if (!result.ok) throw new AgentError(result.err.trim() || "The CLI request failed.");
      try {
        const parsed = JSON.parse(result.out) as { session?: string };
        return { session: parsed.session ?? "" };
      } catch {
        return { session: "" };
      }
    })
    .finally(unsubscribe);

  const cancel = () => {
    void invokeCommand("agent.cancel", { id }).catch(() => {});
  };

  return { id, done, cancel };
}
