// The AI chat panel.
//
// A right-side panel that talks to a local Ollama model to help build queries
// and reports. It streams token-by-token (the native shell pushes `ollama.token`
// events), and every SQL block the model produces gets a "Send to editor"
// action that opens it as a fresh query tab — the draft-into-editor stage, so
// the human always reviews and runs. The model has the connection's table list
// as context, so its SQL targets the live database in the right dialect.
//
// Composed from the shadcn chat primitives: MessageScroller owns streaming
// scroll behaviour, Message/Bubble the layout, Marker the system notes.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, RefreshCw, Settings2, Square, User, X } from "lucide-react";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Message, MessageAvatar, MessageContent } from "@/components/ui/message";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { bridgeAvailable } from "@/lib/bridge";
import {
  chat,
  listModels,
  OllamaError,
  type ChatHandle,
  type ChatMessage,
  type OllamaModel,
} from "@/lib/ollama";
import type { SchemaColumns, TableRef } from "@/lib/parse";

interface Props {
  endpoint: string;
  setEndpoint: (endpoint: string) => void;
  model: string;
  setModel: (model: string) => void;
  /// The active connection's tables, handed to the model as schema context.
  tables: TableRef[];
  /// Columns per table (`schema.name` → columns), so the model uses real
  /// column names and types instead of inventing them.
  schema: SchemaColumns;
  /// Dialect name ("postgres" / "sqlite") so generated SQL uses the right
  /// syntax.
  dialectName: string;
  connectionName: string;
  /// Open a SQL statement as a new query tab.
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

/// A chat turn. `id` is stable for the message-scroller; `pending` marks the
/// assistant bubble currently streaming so an empty one shows a thinking cue.
interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
  error?: boolean;
}

let turnSeq = 0;
function nextTurnId(): string {
  turnSeq += 1;
  return `t${turnSeq}`;
}

/// Split assistant text into prose and fenced code blocks, so SQL can be
/// rendered as an actionable block. A ```lang fence opens a code segment;
/// everything else is prose. Unclosed fences (mid-stream) still render.
type Segment = { kind: "text"; text: string } | { kind: "code"; lang: string; text: string };

function parseSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (match.index > last) {
      const text = content.slice(last, match.index);
      if (text.trim().length > 0) segments.push({ kind: "text", text });
    }
    segments.push({ kind: "code", lang: match[1] || "", text: match[2].replace(/\n$/, "") });
    last = fence.lastIndex;
  }
  if (last < content.length) {
    const text = content.slice(last);
    if (text.trim().length > 0) segments.push({ kind: "text", text });
  }
  return segments;
}

/// Whether a code block looks like SQL worth a "Send to editor" action.
function looksLikeSql(segment: Segment): boolean {
  if (segment.kind !== "code") return false;
  if (segment.lang && !/sql/i.test(segment.lang)) return false;
  return /\b(select|insert|update|delete|create|with|alter|drop)\b/i.test(segment.text);
}

/// Render the live schema as a compact DDL-ish listing the model can rely on:
/// one line per table with its real columns and types. This is what stops it
/// inventing column names. Falls back to a bare table name when columns for a
/// table have not loaded yet.
function renderSchema(tables: TableRef[], schema: SchemaColumns): string {
  if (tables.length === 0) return "(no tables loaded yet)";
  return tables
    .map((t) => {
      const cols = schema.get(t.id);
      if (!cols || cols.length === 0) return `${t.schema}.${t.name}`;
      const columns = cols.map((c) => `${c.name} ${c.type}`).join(", ");
      return `${t.schema}.${t.name}(${columns})`;
    })
    .join("\n");
}

/// Build the system prompt from the live schema, so replies target the real
/// database in the right dialect with real columns.
function systemPrompt(
  tables: TableRef[],
  schema: SchemaColumns,
  dialectName: string,
  connectionName: string,
): string {
  return [
    "You are a SQL assistant embedded in Artemis, a database query and report builder.",
    `The active connection is "${connectionName}" using the ${dialectName} SQL dialect.`,
    "",
    "Schema (table(column type, ...)):",
    renderSchema(tables, schema),
    "",
    "Rules:",
    `- Use ONLY the tables and columns listed above. Never invent names — if a`,
    "  needed column does not exist, say so instead of guessing.",
    `- When asked for data, a query, or a report, reply with ONE runnable SQL`,
    `  statement in a \`\`\`sql code block, valid for ${dialectName}.`,
    "- Add a brief plain explanation. Keep answers concise.",
  ].join("\n");
}

export default function ChatPanel(props: Props) {
  const { endpoint, model, setModel, tables, schema, dialectName, connectionName, onSendToEditor } =
    props;

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [endpointDraft, setEndpointDraft] = useState(endpoint);

  const handleRef = useRef<ChatHandle | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /// Load the model list from the daemon. Picks a default model when none is
  /// chosen yet, and surfaces a readable message when Ollama is unreachable.
  const refreshModels = useCallback(async () => {
    if (!bridgeAvailable()) {
      setModelsError("Run the app with the native shell to reach Ollama.");
      return;
    }
    setLoadingModels(true);
    setModelsError(null);
    try {
      const list = await listModels(endpoint);
      setModels(list);
      if (list.length === 0) {
        setModelsError("No models installed. Pull one with `ollama pull <model>`.");
      } else if (!list.some((m) => m.name === model)) {
        setModel(list[0].name);
      }
    } catch (error) {
      setModelsError(error instanceof OllamaError ? error.message : String(error));
    } finally {
      setLoadingModels(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, model]);

  // Load models on mount and whenever the endpoint changes.
  useEffect(() => {
    void refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  // A cancelled/aborted stream must not keep updating state after unmount.
  useEffect(() => {
    return () => handleRef.current?.cancel();
  }, []);

  const patchLastAssistant = useCallback((patch: (turn: Turn) => Turn) => {
    setTurns((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].role === "assistant") {
          next[i] = patch(next[i]);
          break;
        }
      }
      return next;
    });
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    if (text.length === 0 || streaming || !model) return;

    const history: ChatMessage[] = turns
      .filter((t) => !t.error && t.content.trim().length > 0)
      .map((t) => ({ role: t.role, content: t.content }));

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(tables, schema, dialectName, connectionName) },
      ...history,
      { role: "user", content: text },
    ];

    const assistantId = nextTurnId();
    setTurns((prev) => [
      ...prev,
      { id: nextTurnId(), role: "user", content: text },
      { id: assistantId, role: "assistant", content: "", pending: true },
    ]);
    setInput("");
    setStreaming(true);

    const handle = chat({
      endpoint,
      model,
      messages,
      onToken: (delta) =>
        patchLastAssistant((t) => ({ ...t, content: t.content + delta, pending: false })),
    });
    handleRef.current = handle;

    handle.done
      .catch((error) => {
        const message = error instanceof OllamaError ? error.message : String(error);
        patchLastAssistant((t) => ({
          ...t,
          content: t.content.length > 0 ? t.content : message,
          pending: false,
          error: t.content.length === 0,
        }));
      })
      .finally(() => {
        handleRef.current = null;
        setStreaming(false);
        patchLastAssistant((t) => ({ ...t, pending: false }));
      });
  }, [input, streaming, model, turns, tables, schema, dialectName, connectionName, endpoint, patchLastAssistant]);

  const stop = useCallback(() => {
    handleRef.current?.cancel();
  }, []);

  function onInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
    // Escape is handled at the App level to close the panel; let it bubble.
  }

  function applyEndpoint() {
    const next = endpointDraft.trim();
    if (next.length > 0 && next !== endpoint) props.setEndpoint(next);
    setShowSettings(false);
  }

  const canSend = input.trim().length > 0 && !streaming && !!model;

  return (
    <aside
      className="flex w-[380px] flex-none flex-col border-l border-border bg-card"
      aria-label="AI chat"
    >
      <header className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2">
        <Bot className="size-3.5 flex-none text-amber" />
        <span className="font-mono text-[10px] tracking-[0.1em] text-faint uppercase">chat</span>
        {/* Name the provider: Ollama is the only backend for now, and saying so
            sets the expectation that this is local-only. */}
        <span
          className="rounded-full border border-border px-1.5 py-px font-mono text-[9.5px] tracking-[0.08em] text-faint uppercase"
          title="Local models via Ollama. API keys and custom providers are coming."
        >
          Ollama
        </span>
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => setShowSettings((open) => !open)}
          aria-pressed={showSettings}
          aria-label="Chat settings"
        >
          <Settings2 />
        </Button>
        <button
          className="p-0.5 text-faint transition-colors hover:text-amber"
          onClick={props.onClose}
          aria-label="Close chat"
        >
          <X className="size-3.5" />
        </button>
      </header>

      {/* Model picker + endpoint. The picker switches the local model mid
          conversation; the endpoint hides behind the gear. */}
      <div className="flex flex-none flex-col gap-2 border-b border-hairline px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Select value={model} onValueChange={(next) => next && setModel(next)} disabled={models.length === 0}>
            <SelectTrigger
              size="sm"
              className="h-7 flex-1 font-mono text-[11.5px]"
              aria-label="Model"
            >
              <SelectValue placeholder={loadingModels ? "loading models…" : "no model"} />
            </SelectTrigger>
            <SelectContent>
              {models.map((m) => (
                <SelectItem key={m.name} value={m.name} className="font-mono text-[11.5px]">
                  {m.name}
                  {m.params && <span className="text-faint"> · {m.params}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void refreshModels()}
            disabled={loadingModels}
            aria-label="Reload models"
          >
            <RefreshCw className={cn(loadingModels && "animate-spin")} />
          </Button>
        </div>

        {showSettings && (
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[9.5px] tracking-[0.1em] text-faint uppercase">
              Ollama endpoint
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                className="h-7 flex-1 font-mono text-[11px]"
                value={endpointDraft}
                onChange={(e) => setEndpointDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyEndpoint();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEndpointDraft(endpoint);
                    setShowSettings(false);
                  }
                }}
                placeholder="http://127.0.0.1:11434"
                aria-label="Ollama endpoint"
              />
              <Button size="sm" onClick={applyEndpoint}>
                Set
              </Button>
            </div>
            <p className="text-[10.5px] leading-relaxed text-faint">
              Local Ollama only for now. API keys and custom providers are coming.
            </p>
          </div>
        )}

        {modelsError && (
          <p className="font-mono text-[11px] leading-relaxed text-destructive/90">{modelsError}</p>
        )}
      </div>

      {/* The conversation. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-3 py-3">
            <MessageScrollerContent className="gap-5">
              {turns.length === 0 && (
                <EmptyState hasModel={!!model} />
              )}
              {turns.map((turn, index) => (
                <MessageScrollerItem
                  key={turn.id}
                  messageId={turn.id}
                  scrollAnchor={index === turns.length - 1}
                >
                  <ChatTurn turn={turn} onSendToEditor={onSendToEditor} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* Composer. */}
      <div className="flex flex-none items-end gap-2 border-t border-hairline p-3">
        <textarea
          ref={inputRef}
          className="max-h-[160px] min-h-[38px] flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-ring"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={model ? "Ask for a query or report…" : "Pick a model to start"}
          rows={1}
          spellCheck={false}
          aria-label="Message"
        />
        {streaming ? (
          <Button size="icon" variant="secondary" onClick={stop} aria-label="Stop">
            <Square />
          </Button>
        ) : (
          <Button size="icon" onClick={send} disabled={!canSend} aria-label="Send">
            <ArrowUp />
          </Button>
        )}
      </div>
    </aside>
  );
}

function EmptyState({ hasModel }: { hasModel: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Bot className="size-6 text-faint" />
      <p className="text-[12.5px] font-medium text-foreground">
        {hasModel ? "Ask about your data" : "Pick a model to start"}
      </p>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        {hasModel
          ? "Describe the query or report you want. SQL answers get a Send to editor button so you review and run them yourself."
          : "This chat runs a local model through Ollama. Choose one above to begin."}
      </p>
    </div>
  );
}

function ChatTurn({ turn, onSendToEditor }: { turn: Turn; onSendToEditor: (sql: string) => void }) {
  if (turn.error) {
    return (
      <Marker variant="default" className="text-destructive/90">
        <MarkerContent className="font-mono text-[11px]">{turn.content}</MarkerContent>
      </Marker>
    );
  }

  const isUser = turn.role === "user";
  const segments = isUser ? null : parseSegments(turn.content);

  return (
    <Message align={isUser ? "end" : "start"}>
      <MessageAvatar className="size-6 text-faint">
        {isUser ? <User className="size-3.5" /> : <Bot className="size-3.5 text-amber" />}
      </MessageAvatar>
      <MessageContent>
        {isUser ? (
          <Bubble variant="default" align="end">
            <BubbleContent className="font-mono text-[12px] whitespace-pre-wrap">
              {turn.content}
            </BubbleContent>
          </Bubble>
        ) : turn.pending && turn.content.length === 0 ? (
          <Bubble variant="muted">
            <BubbleContent>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-amber" />
                <span className="text-[12px]">thinking…</span>
              </span>
            </BubbleContent>
          </Bubble>
        ) : (
          <div className="flex flex-col gap-2">
            {segments!.map((segment, i) =>
              segment.kind === "text" ? (
                <Bubble key={i} variant="muted">
                  <BubbleContent className="text-[12.5px] whitespace-pre-wrap">
                    {segment.text.trim()}
                  </BubbleContent>
                </Bubble>
              ) : (
                <CodeBlock
                  key={i}
                  code={segment.text}
                  isSql={looksLikeSql(segment)}
                  onSendToEditor={onSendToEditor}
                />
              ),
            )}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

function CodeBlock({
  code,
  isSql,
  onSendToEditor,
}: {
  code: string;
  isSql: boolean;
  onSendToEditor: (sql: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <pre className="max-h-[280px] overflow-auto px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre">
        {code}
      </pre>
      {isSql && (
        <div className="flex items-center justify-end gap-1.5 border-t border-hairline px-2 py-1.5">
          <Button size="xs" variant="ghost" onClick={() => void navigator.clipboard?.writeText(code)}>
            Copy
          </Button>
          <Button size="xs" onClick={() => onSendToEditor(code)}>
            Send to editor
          </Button>
        </div>
      )}
    </div>
  );
}
