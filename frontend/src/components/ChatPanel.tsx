// The AI chat panel.
//
// A right-side panel that talks to a model to help build queries and
// reports. Three backends, one conversation: a local Ollama daemon, or the
// Claude Code / Codex CLI the user has already signed into — which is how a
// subscription gets used here, since the CLI's own login is the credential
// and no API key is ever entered.
//
// It streams token-by-token (the native shell pushes `ollama.token` /
// `agent.token` events), and every SQL block the model produces gets a
// "Send to editor" action that opens it as a fresh query tab — the
// draft-into-editor stage, so the human always reviews and runs. The model
// has the connection's table list as context, so its SQL targets the live
// database in the right dialect.
//
// Composed from the shadcn chat primitives: MessageScroller owns streaming
// scroll behaviour, Message/Bubble the layout, Marker the system notes.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, ChevronDown, ChevronRight, Plus, RefreshCw, Settings2, Square, Trash2, User, X } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
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
  extractProbe,
  formatProbeResult,
  looksLikeSql,
  parseSegments,
  PROBE_LIMIT,
  sanitizeProbe,
} from "@/lib/probe";
import {
  chat,
  listModels,
  OllamaError,
  type ChatHandle,
  type ChatMessage,
  type OllamaModel,
} from "@/lib/ollama";
import {
  AgentError,
  agentChat,
  agentStatus,
  buildTurn,
  INSTALL_HINTS,
  isCliProvider,
  LOGIN_HINTS,
  MODEL_SUGGESTIONS,
  PROVIDER_BLURBS,
  PROVIDER_LABELS,
  PROVIDER_SHORT_LABELS,
  PROVIDERS,
  turnKey,
  type AgentStatus,
  type CliProvider,
  type Provider,
} from "@/lib/agent";
import type { AiSettings } from "@/lib/aiStore";
import {
  createChatSession,
  deleteChatSession,
  listChatSessions,
  loadTranscript,
  saveTranscript,
  titleFrom,
  updateChatSession,
  type ChatSessionRow,
} from "@/lib/chatStore";
import type { ColumnValues, ForeignKeyRef, SchemaColumns, TableRef } from "@/lib/parse";

interface Props {
  /// Which backend to run on, and every backend's own settings.
  settings: AiSettings;
  updateSettings: (patch: Partial<AiSettings>) => void;
  /// The active connection's tables, handed to the model as schema context.
  tables: TableRef[];
  /// Columns per table (`schema.name` → columns), so the model uses real
  /// column names and types instead of inventing them.
  schema: SchemaColumns;
  /// Foreign keys of the active connection, so joins follow the database's
  /// real relationships instead of guessed `<table>_id` columns.
  foreignKeys: ForeignKeyRef[];
  /// Complete value lists of the enum-like columns, so the model can find
  /// WHICH table/column holds "flowiki" instead of assuming from wording.
  valueCatalog: ColumnValues[];
  /// Run a sanitized read-only exploration probe against the live
  /// connection, returning the raw framed result.
  runProbe: (sql: string) => Promise<{ ok: boolean; out: string; err: string }>;
  /// Dialect name ("postgres" / "sqlite") so generated SQL uses the right
  /// syntax.
  dialectName: string;
  connectionName: string;
  /// The active connection's row id. Conversations are stored against it —
  /// a chat is about one database's schema.
  connectionId: number;
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
  /// A problem that ended the reply early (stream failure, context window
  /// full). Shown under the partial content — a cut-off answer must never
  /// read as a complete one.
  note?: string;
  /// "probe-result": a system-side marker showing what an exploration probe
  /// returned (the model sees the full rows; the human sees a summary).
  kind?: "probe-result";
}

let turnSeq = 0;
function nextTurnId(): string {
  turnSeq += 1;
  return `t${turnSeq}`;
}

// The fence parsing and the probe machinery (extraction, sanitizing, result
// formatting) live in lib/probe.ts — pure string work, testable without
// React. This file owns only the loop and the rendering.

/// A column whose type makes it the natural target for date/time reasoning.
/// Small models match "on July 1st" to a text column unless the temporal
/// columns are called out, so we detect them from the SQL type name.
function isTemporalType(type: string): boolean {
  return /\b(timestamp|timestamptz|datetime|date|time)\b/i.test(type);
}

/// Postgres's verbose type names, abbreviated to their common aliases. On a
/// large schema this saves real context-window tokens without losing any
/// information the model acts on.
const TYPE_ALIASES = new Map<string, string>([
  ["character varying", "varchar"],
  ["timestamp with time zone", "timestamptz"],
  ["timestamp without time zone", "timestamp"],
  ["time with time zone", "timetz"],
  ["time without time zone", "time"],
  ["double precision", "float8"],
  ["boolean", "bool"],
  ["integer", "int"],
]);

function compactType(type: string): string {
  return TYPE_ALIASES.get(type) ?? type;
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
      const columns = cols.map((c) => `${c.name} ${compactType(c.type)}`).join(", ");
      return `${t.schema}.${t.name}(${columns})`;
    })
    .join("\n");
}

/// Render the foreign keys as `table.column -> table.column` lines — the
/// database's real join paths, so the model never guesses a join column.
/// Empty string when there are none (or they have not loaded).
function renderJoinPaths(foreignKeys: ForeignKeyRef[]): string {
  return foreignKeys
    .map((fk) => `${fk.tableId}.${fk.column} -> ${fk.refTableId}${fk.refColumn ? `.${fk.refColumn}` : ""}`)
    .join("\n");
}

/// Render the value catalog as `table.column: 'a', 'b'` lines. SQL-literal
/// quoting on purpose: the model copies these straight into WHERE clauses.
function renderKnownValues(catalog: ColumnValues[]): string {
  return catalog
    .map((c) => `${c.tableId}.${c.column}: ${c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")}`)
    .join("\n");
}

/// Name every date/time column across the schema, grouped by table, so the
/// model reaches for these — not a text column — whenever a request mentions
/// a day, month, year, or relative time. Empty string when the schema has no
/// temporal columns (or none are loaded yet), so the caller can omit the line.
function renderTemporalColumns(tables: TableRef[], schema: SchemaColumns): string {
  const lines: string[] = [];
  for (const t of tables) {
    const cols = schema.get(t.id);
    if (!cols) continue;
    const temporal = cols.filter((c) => isTemporalType(c.type)).map((c) => c.name);
    if (temporal.length > 0) lines.push(`${t.schema}.${t.name}: ${temporal.join(", ")}`);
  }
  return lines.join("\n");
}

/// Build the system prompt from the live schema, so replies target the real
/// database in the right dialect with the right columns for each request.
///
/// The schema alone is not enough: a small model will drop a request's words
/// verbatim into a text filter (`name ILIKE '%july 1st%'`) unless it is told
/// to first pick the column whose *type* matches the concept. So the prompt
/// carries explicit reasoning rules, the current date (so "July 1st" resolves
/// to a real range), and one worked example to anchor the behaviour.
function systemPrompt(
  tables: TableRef[],
  schema: SchemaColumns,
  foreignKeys: ForeignKeyRef[],
  valueCatalog: ColumnValues[],
  dialectName: string,
  connectionName: string,
  today: string,
): string {
  const temporal = renderTemporalColumns(tables, schema);
  const joins = renderJoinPaths(foreignKeys);
  const values = renderKnownValues(valueCatalog);
  // Whether this database uses soft deletes. Only then is the extra
  // `deleted_at IS NULL` guidance worth its tokens — schemas without it get a
  // leaner prompt and no rule that references a column they do not have.
  const softDelete = tables.some((t) =>
    (schema.get(t.id) ?? []).some((c) => c.name === "deleted_at"),
  );
  const lines = [
    "You are a SQL assistant embedded in Artemis, a database query and report builder.",
    `The active connection is "${connectionName}" using the ${dialectName} SQL dialect.`,
    `Today's date is ${today}. Resolve relative dates ("last week", "in July") against it.`,
    "",
    "Schema (table(column type, ...)):",
    renderSchema(tables, schema),
  ];

  if (joins) {
    lines.push(
      "",
      "Join paths (foreign keys, `from -> to`). Join tables ONLY along these —",
      "if no path connects two tables, say so instead of inventing a join column:",
      joins,
    );
  }

  if (values) {
    lines.push(
      "",
      "Known values — the actual values of small label-like columns, from the",
      "live data. When a request names a specific thing (an org, a workspace, a",
      "status, a plan…), FIND that value here to learn which table and column",
      "really hold it. Never assume from the request's wording — \"the flowiki",
      "main workspace\" may mean org 'flowiki', workspace 'main':",
      values,
    );
  }

  if (temporal) {
    lines.push(
      "",
      "Date/time columns (use these for anything about WHEN, never a text column):",
      temporal,
    );
  }

  lines.push(
    "",
    "Looking at the data first (probes):",
    "- If you cannot tell where a mentioned value lives (not in Known values,",
    "  no obviously right column), do NOT guess — send a probe: reply with",
    "  ONLY one fenced block tagged `probe` containing a single small SELECT,",
    "  e.g.:",
    "```probe",
    "SELECT name FROM public.workspaces LIMIT 20",
    "```",
    "- The rows come back as the next message; then answer (or probe again if",
    `  truly needed, at most ${PROBE_LIMIT} probes per request).`,
    "- Probes are read-only SELECTs, one statement, small LIMIT. Never probe",
    "  for data the Known values list or the schema already gives you.",
  );

  lines.push(
    "",
    "How to choose columns — do this before writing SQL:",
    "- Match each part of the request to the column whose TYPE fits the concept,",
    "  not the column whose name contains the request's words.",
    "- WHEN something happened (a day, month, year, \"created on…\", \"last week\"):",
    "  filter a date/time column with a half-open range, e.g.",
    "  `created_at >= '2026-07-01' AND created_at < '2026-07-02'` for a single day.",
    "  Never put a date into an ILIKE/LIKE on a text column.",
    "- Text search (\"named X\", \"containing Y\"): use ILIKE on the relevant text",
    "  column only. Do not AND several text columns together unless the request",
    "  truly asks for all of them to match.",
    "- \"how many\" / \"count\" → SELECT COUNT(*). \"per\" / \"by\" / \"breakdown\" →",
    "  GROUP BY that dimension. \"total\" / \"average\" → SUM / AVG on a numeric column.",
    "",
    "Example — \"how many docs were created on July 1st\" →",
    "```sql",
    "SELECT COUNT(*) FROM public.docs",
    "WHERE created_at >= '2026-07-01' AND created_at < '2026-07-02'" + (softDelete ? " AND deleted_at IS NULL" : "") + ";",
    "```",
    "",
    "Rules:",
    "- Use ONLY names copied EXACTLY from the schema above — same spelling, same",
    "  case, same singular/plural. The table is `public.docs`, not `docs` or",
    "  `documents`; it is `public.user`, not `public.users`. If an exact name is",
    "  not in the list, do not guess a variant — say the table/column is missing.",
    "- Answer ONLY what was asked. If the request names one thing (e.g. docs),",
    "  query just that one table. Do not add extra tables, counts, or columns that",
    "  were not requested.",
  );

  if (softDelete) {
    lines.push(
      "- Rows are soft-deleted via a `deleted_at` column (NULL = live). Unless the",
      "  request explicitly wants deleted rows, add `deleted_at IS NULL` so counts",
      "  and reports reflect live data only.",
    );
  }

  lines.push(
    `- When asked for data, a query, or a report, reply with ONE runnable SQL`,
    `  statement in a \`\`\`sql code block, valid for ${dialectName}.`,
    "- Add a brief plain explanation. Keep answers concise.",
  );

  return lines.join("\n");
}

/// Today as `YYYY-MM-DD` in the user's local zone, for resolving relative and
/// bare dates in the system prompt. Local (not UTC) so "today" matches what
/// the user sees; the DB's own zone handling is the human's call at review.
function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/// Which of the per-provider settings fields hold this CLI's model and
/// binary path, so one set of controls can drive either.
const CLI_FIELDS: Record<CliProvider, { model: keyof AiSettings; binary: keyof AiSettings }> = {
  claude: { model: "claudeModel", binary: "claudeBinary" },
  codex: { model: "codexModel", binary: "codexBinary" },
};

export default function ChatPanel(props: Props) {
  const {
    settings,
    updateSettings,
    tables,
    schema,
    foreignKeys,
    valueCatalog,
    runProbe,
    dialectName,
    connectionName,
    connectionId,
    onSendToEditor,
  } = props;

  const provider = settings.provider;
  const endpoint = settings.endpoint;
  const cli = isCliProvider(provider) ? provider : null;
  const cliModel = cli ? (settings[CLI_FIELDS[cli].model] as string) : "";
  const cliBinary = cli ? (settings[CLI_FIELDS[cli].binary] as string) : "";
  /// The model in force, whichever backend is selected. Empty on a CLI
  /// means "the CLI's own default", which is a usable state — unlike
  /// Ollama, where a model must be named.
  const model = cli ? cliModel : settings.model;

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  /// What was found when we looked for the selected CLI. Null while the
  /// look-up is still running, or when the backend is Ollama.
  const [cliStatus, setCliStatus] = useState<AgentStatus | null>(null);
  /// Stored conversations for this connection, most recent first, and which
  /// one is open. Null means an unsaved chat: no row exists until the first
  /// message, so browsing never leaves empty threads behind.
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [sessionId, setSessionId] = useState<number | null>(null);

  // What the model is actually told about the database. Surfaced so a wrong
  // or empty schema is visible instead of guessed at: if "with columns" is 0,
  // column metadata never loaded and the model can only invent names.
  const tablesWithColumns = tables.filter((t) => (schema.get(t.id)?.length ?? 0) > 0).length;
  const joinContext = renderJoinPaths(foreignKeys);
  const valuesContext = renderKnownValues(valueCatalog);
  const schemaContext = [
    renderSchema(tables, schema),
    joinContext && `\n-- join paths --\n${joinContext}`,
    valuesContext && `\n-- known values --\n${valuesContext}`,
  ]
    .filter(Boolean)
    .join("\n");

  /// The in-flight stream, whichever backend produced it. Only `cancel` is
  /// needed here, and both handles offer it.
  const handleRef = useRef<Pick<ChatHandle, "cancel"> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /// Load the model list from the daemon. Picks a default model when none is
  /// chosen yet, and surfaces a readable message when Ollama is unreachable.
  const refreshModels = useCallback(async () => {
    if (provider !== "ollama") return;
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
        updateSettings({ model: list[0].name });
      }
    } catch (error) {
      setModelsError(error instanceof OllamaError ? error.message : String(error));
    } finally {
      setLoadingModels(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, model, provider]);

  // Load models on mount and whenever the endpoint or backend changes.
  useEffect(() => {
    void refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, provider]);

  /// Look for the selected CLI. Cheap (`--version`) and worth doing up
  /// front: "not installed" and "installed but signed out" are the two
  /// states a user hits first, and neither should cost a request to learn.
  const refreshCliStatus = useCallback(async () => {
    if (!cli) {
      setCliStatus(null);
      return;
    }
    if (!bridgeAvailable()) {
      setCliStatus({
        installed: false,
        path: "",
        version: "",
        message: "Run the app with the native shell to reach the CLI.",
      });
      return;
    }
    setCliStatus(null);
    setCliStatus(await agentStatus(cli, cliBinary));
  }, [cli, cliBinary]);

  useEffect(() => {
    void refreshCliStatus();
  }, [refreshCliStatus]);

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

  /// The exact messages sent to the model (minus the per-send system
  /// prompt). Kept apart from the display turns: probe exchanges are full
  /// messages to the model but only summary markers on screen.
  const convoRef = useRef<ChatMessage[]>([]);
  /// Stop pressed: ends the probe loop as well as the current stream.
  const abortRef = useRef(false);

  /// The CLI conversation this panel is continuing, and the setup it was
  /// started with. A resumed session already holds the schema and the
  /// history, so only the new message is sent — which on a rate-limited
  /// subscription is the difference between one schema upload and one per
  /// message. Any change to the setup invalidates it: the session was
  /// created under the old system prompt and cannot be told about the new
  /// one.
  const sessionRef = useRef<{ key: string; id: string } | null>(null);

  /// The rendered conversation, mirrored into a ref so the save that runs
  /// when a turn finishes reads what is on screen rather than the value
  /// captured when the send started.
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  /// Open a stored conversation: both transcripts, and the CLI handle it was
  /// built on. Switching also switches the backend back — the handle belongs
  /// to that CLI, and continuing a Claude thread under Codex is nonsense.
  const openChat = useCallback(
    async (row: ChatSessionRow) => {
      handleRef.current?.cancel();
      abortRef.current = true;
      const transcript = await loadTranscript(row.id);
      convoRef.current = transcript.model;
      sessionRef.current =
        row.cliSession && row.sessionKey ? { key: row.sessionKey, id: row.cliSession } : null;
      setTurns(
        transcript.display.map((stored) => ({
          id: nextTurnId(),
          role: stored.role,
          content: stored.content,
          kind: stored.kind === "probe-result" ? "probe-result" : undefined,
          note: stored.note || undefined,
          error: stored.error || undefined,
        })),
      );
      setSessionId(row.id);
      if (row.provider && row.provider !== provider) updateSettings({ provider: row.provider });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [provider],
  );

  /// Start over. The row for the current chat stays; this one materialises
  /// on its first message.
  const newChat = useCallback(() => {
    handleRef.current?.cancel();
    abortRef.current = true;
    convoRef.current = [];
    sessionRef.current = null;
    setTurns([]);
    setSessionId(null);
  }, []);

  // Load this connection's conversations, and reopen the most recent one so
  // toggling the panel (or restarting the app) does not lose the thread.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (connectionId <= 0 || !bridgeAvailable()) {
        setSessions([]);
        return;
      }
      const rows = await listChatSessions(connectionId);
      if (cancelled) return;
      setSessions(rows);
      if (rows.length > 0) await openChat(rows[0]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  /// Write the conversation to the store. Creates its row on the first save,
  /// naming it after the opening message.
  const persist = useCallback(
    async (currentTurns: Turn[]) => {
      if (connectionId <= 0 || currentTurns.length === 0 || !bridgeAvailable()) return;
      let id = sessionId;
      if (id === null) {
        const opening = currentTurns.find((t) => t.role === "user" && t.kind !== "probe-result");
        id = await createChatSession(connectionId, provider, titleFrom(opening?.content ?? ""));
        if (id === null) return;
        setSessionId(id);
      }
      await saveTranscript(
        id,
        currentTurns.map((turn) => ({
          role: turn.role,
          content: turn.content,
          kind: turn.kind ?? "",
          note: turn.note ?? "",
          error: turn.error ?? false,
        })),
        convoRef.current,
      );
      await updateChatSession(id, {
        provider,
        cliSession: sessionRef.current?.id ?? "",
        sessionKey: sessionRef.current?.key ?? "",
      });
      setSessions(await listChatSessions(connectionId));
    },
    [connectionId, provider, sessionId],
  );

  // Save when a turn finishes rather than as it streams: one write per
  // exchange instead of one per token, and by then the panel state is the
  // finished thing worth storing.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) void persist(turnsRef.current);
    wasStreaming.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  /// Stream one assistant reply into a fresh display turn. Resolves with the
  /// full text plus the failure that ended it early, if any — never rejects.
  const streamOnce = useCallback(
    (messages: ChatMessage[]): Promise<{ content: string; failure: string | null }> => {
      setTurns((prev) => [
        ...prev,
        { id: nextTurnId(), role: "assistant", content: "", pending: true },
      ]);
      let content = "";
      const onToken = (delta: string) => {
        content += delta;
        patchLastAssistant((t) => ({ ...t, content: t.content + delta, pending: false }));
      };

      if (!cli) {
        const handle = chat({ endpoint, model, messages, onToken });
        handleRef.current = handle;
        return handle.done
          .then(() => ({ content, failure: null as string | null }))
          .catch((error) => ({
            content,
            failure: error instanceof OllamaError ? error.message : String(error),
          }))
          .finally(() => {
            handleRef.current = null;
          });
      }

      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const key = turnKey(cli, cliModel, cliBinary, system);
      const resumable = sessionRef.current?.key === key ? sessionRef.current.id : "";
      const turn = buildTurn(cli, system, messages, resumable);

      const handle = agentChat({
        provider: cli,
        binary: cliBinary,
        model: cliModel,
        system: turn.system,
        prompt: turn.prompt,
        session: turn.session,
        onToken,
      });
      handleRef.current = handle;
      return handle.done
        .then((result) => {
          sessionRef.current = result.session ? { key, id: result.session } : null;
          return { content, failure: null as string | null };
        })
        .catch((error) => {
          // Resuming into a conversation that just failed only repeats the
          // failure, so the next message starts a fresh session.
          sessionRef.current = null;
          return {
            content,
            failure: error instanceof AgentError ? error.message : String(error),
          };
        })
        .finally(() => {
          handleRef.current = null;
        });
    },
    [cli, cliBinary, cliModel, endpoint, model, patchLastAssistant],
  );

  /// Can this backend take a message? Ollama needs a chosen model; a CLI
  /// needs to exist. An unfinished look-up counts as ready — the CLI's own
  /// error is a better answer than a disabled button.
  const backendReady = cli ? cliStatus?.installed !== false : !!model;
  /// Whichever "am I usable" check this backend runs is in flight.
  const checking = cli ? cliStatus === null : loadingModels;

  const send = useCallback(() => {
    const text = input.trim();
    if (text.length === 0 || streaming || !backendReady) return;

    setTurns((prev) => [...prev, { id: nextTurnId(), role: "user", content: text }]);
    setInput("");
    setStreaming(true);
    abortRef.current = false;

    const convo = convoRef.current;
    convo.push({ role: "user", content: text });

    // The probe loop: stream a reply; if it is a probe, run it, feed the rows
    // back, and stream again. A final answer (or a failure, or Stop, or the
    // probe budget) ends the loop.
    void (async () => {
      const system: ChatMessage = {
        role: "system",
        content: systemPrompt(
          tables,
          schema,
          foreignKeys,
          valueCatalog,
          dialectName,
          connectionName,
          localToday(),
        ),
      };
      let probes = 0;
      try {
        for (;;) {
          const outcome = await streamOnce([system, ...convo]);
          if (outcome.content.length > 0) {
            convo.push({ role: "assistant", content: outcome.content });
          }
          if (outcome.failure) {
            const failure = outcome.failure;
            // A failure after some text arrived keeps the text but must say
            // the reply is incomplete — silently presenting a cut-off answer
            // as a whole one is worse than the error itself.
            patchLastAssistant((t) =>
              t.content.length > 0
                ? { ...t, pending: false, note: failure }
                : { ...t, content: failure, pending: false, error: true },
            );
            break;
          }
          patchLastAssistant((t) => ({ ...t, pending: false }));

          const probe =
            probes < PROBE_LIMIT && !abortRef.current ? extractProbe(outcome.content) : null;
          if (!probe) break;
          probes += 1;

          const checked = sanitizeProbe(probe);
          let feedback: string;
          let summary: string;
          if (!checked.ok) {
            feedback = `PROBE REJECTED (${checked.reason}). Send one plain read-only SELECT, or answer with what you already know.`;
            summary = `probe rejected — ${checked.reason}`;
          } else {
            const result = await runProbe(checked.sql);
            if (result.ok) {
              const formatted = formatProbeResult(result.out);
              feedback = `PROBE RESULT:\n${formatted.text}`;
              summary = `probe · ${formatted.rows} row${formatted.rows === 1 ? "" : "s"}`;
            } else {
              feedback = `PROBE FAILED: ${result.err.trim() || "the probe failed"}`;
              summary = "probe failed";
            }
          }
          setTurns((prev) => [
            ...prev,
            { id: nextTurnId(), role: "user", content: summary, kind: "probe-result" },
          ]);
          convo.push({
            role: "user",
            content: `${feedback}\n\nNow answer the original question with a final \`\`\`sql query — probe again only if strictly needed.`,
          });
          if (abortRef.current) break;
        }
      } finally {
        setStreaming(false);
      }
    })();
  }, [input, streaming, backendReady, tables, schema, foreignKeys, valueCatalog, dialectName, connectionName, streamOnce, runProbe, patchLastAssistant]);

  const stop = useCallback(() => {
    abortRef.current = true;
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
    if (next.length > 0 && next !== endpoint) updateSettings({ endpoint: next });
    setShowSettings(false);
  }

  /// Switching backend mid-conversation is allowed — the transcript is ours,
  /// not the model's — but the CLI session handle belongs to the old one.
  function selectProvider(next: Provider) {
    if (next === provider) return;
    sessionRef.current = null;
    updateSettings({ provider: next });
  }

  function updateCli(field: "model" | "binary", value: string) {
    if (!cli) return;
    sessionRef.current = null;
    updateSettings({ [CLI_FIELDS[cli][field]]: value });
  }

  async function removeChat(row: ChatSessionRow) {
    await deleteChatSession(row.id);
    if (row.id === sessionId) newChat();
    setSessions(await listChatSessions(connectionId));
  }

  /// The open conversation's name. An unsaved chat has no row yet, so it is
  /// named from what has been typed so far — the same rule the row will get.
  const openSession = sessions.find((s) => s.id === sessionId) ?? null;
  const firstUserTurn = turns.find((t) => t.role === "user" && t.kind !== "probe-result");
  const chatTitle =
    openSession?.title || (firstUserTurn ? titleFrom(firstUserTurn.content) : "New chat");

  const canSend = input.trim().length > 0 && !streaming && backendReady;

  return (
    <aside
      className="float-panel flex w-[380px] flex-none flex-col"
      aria-label="AI chat"
    >
      <header className="flex flex-none items-center gap-1 border-b border-hairline px-3 py-2">
        <Bot className="size-3.5 flex-none text-amber" />
        {/* The conversation, named and switchable. Chats are stored per
            connection and reopened on the next visit, so the panel needs a
            way to say which one you are in and to get back to the others. */}
        <Menu>
          <MenuTrigger
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-accent data-popup-open:bg-accent"
            title="Switch conversation"
            aria-label="Conversations"
          >
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {chatTitle}
            </span>
            <ChevronDown className="size-3 flex-none text-faint" />
          </MenuTrigger>
          <MenuContent align="start" className="w-[300px]">
            <MenuItem onClick={newChat} className="gap-2 font-mono text-[11.5px]">
              <Plus className="size-3.5 flex-none text-faint" />
              New chat
            </MenuItem>
            {sessions.length > 0 && <MenuSeparator />}
            {sessions.map((row) => (
              <MenuItem
                key={row.id}
                onClick={() => void openChat(row)}
                className={cn(
                  "group gap-2 font-mono text-[11.5px]",
                  row.id === sessionId && "text-amber",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{row.title || "Untitled"}</span>
                <span className="flex-none text-[9.5px] text-faint">
                  {PROVIDER_SHORT_LABELS[row.provider] ?? row.provider}
                </span>
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Delete ${row.title || "conversation"}`}
                  className="flex-none rounded p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  onClick={(event) => {
                    // The row's own click opens the chat; this one must not.
                    event.stopPropagation();
                    event.preventDefault();
                    void removeChat(row);
                  }}
                >
                  <Trash2 className="size-3" />
                </span>
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={newChat}
          disabled={turns.length === 0 && sessionId === null}
          aria-label="New chat"
        >
          <Plus />
        </Button>
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

      {/* Model picker. Ollama has an installed list to choose from; a CLI
          takes any id its vendor ships, so that one is a free-text field
          with suggestions and an empty value meaning "the CLI's default". */}
      <div className="flex flex-none flex-col gap-2 border-b border-hairline px-3 py-2">
        {/* Which backend answers. First control in the panel, and a
            segmented one — all three destinations visible at once — because
            the choice decides where the question goes and who pays for the
            reply. A dropdown here reads as a badge and gets missed. */}
        <div
          className="flex items-center gap-0.5 rounded-full border border-hairline bg-background/60 p-0.5"
          role="group"
          aria-label="Chat backend"
        >
          {PROVIDERS.map((key) => {
            const active = provider === key;
            return (
              <button
                key={key}
                className={cn(
                  "flex-1 rounded-full px-2 py-1 font-mono text-[10.5px] transition-colors",
                  active
                    ? "bg-card text-foreground shadow-[0_1px_2px_var(--shadow)]"
                    : "text-faint hover:text-foreground",
                )}
                onClick={() => selectProvider(key)}
                aria-pressed={active}
                title={PROVIDER_BLURBS[key]}
              >
                {PROVIDER_SHORT_LABELS[key]}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5">
          {cli ? (
            <>
              <Input
                className="h-7 flex-1 font-mono text-[11.5px]"
                value={cliModel}
                onChange={(e) => updateCli("model", e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") e.stopPropagation();
                }}
                placeholder={`model — blank for the ${PROVIDER_LABELS[cli]} default`}
                list={`${cli}-model-suggestions`}
                spellCheck={false}
                aria-label="Model"
              />
              <datalist id={`${cli}-model-suggestions`}>
                {MODEL_SUGGESTIONS[cli].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          ) : (
            <Select value={model} onValueChange={(next) => next && updateSettings({ model: next })} disabled={models.length === 0}>
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
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => void (cli ? refreshCliStatus() : refreshModels())}
            disabled={checking}
            aria-label={cli ? "Re-check the CLI" : "Reload models"}
          >
            <RefreshCw className={cn(checking && "animate-spin")} />
          </Button>
        </div>

        {cli && <CliStatusLine provider={cli} status={cliStatus} />}

        {/* The schema context sent with every message. The summary makes the
            failure mode ("0 with columns") visible; expanding shows the exact
            DDL the model receives, so a wrong reply can be traced to its input
            rather than guessed at. */}
        <div className="flex flex-col gap-1">
          <button
            className="flex items-center gap-1.5 font-mono text-[9.5px] tracking-[0.1em] text-faint uppercase transition-colors hover:text-muted-foreground"
            onClick={() => setShowContext((open) => !open)}
            aria-expanded={showContext}
          >
            {showContext ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span>context</span>
            <span
              className={cn(
                "normal-case tracking-normal",
                tables.length > 0 && tablesWithColumns === 0 ? "text-destructive/80" : "text-muted-foreground",
              )}
            >
              {tables.length} table{tables.length === 1 ? "" : "s"} · {tablesWithColumns} with columns
            </span>
          </button>
          {showContext && (
            <pre className="max-h-[180px] overflow-auto rounded-md border border-hairline bg-background px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre text-muted-foreground">
              {schemaContext}
            </pre>
          )}
          {tables.length > 0 && tablesWithColumns === 0 && (
            <p className="font-mono text-[10px] leading-relaxed text-destructive/80">
              No column metadata loaded — the model only sees table names and will guess columns. Reload tables from the rail.
            </p>
          )}
        </div>

        {showSettings && !cli && (
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
              Models run locally through Ollama — nothing leaves this machine.
            </p>
          </div>
        )}

        {showSettings && cli && (
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[9.5px] tracking-[0.1em] text-faint uppercase">
              {PROVIDER_LABELS[cli]} path
            </label>
            <Input
              className="h-7 font-mono text-[11px]"
              value={cliBinary}
              onChange={(e) => updateCli("binary", e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setShowSettings(false);
                }
              }}
              placeholder={cliStatus?.path || `leave blank to find \`${cli}\` automatically`}
              spellCheck={false}
              aria-label={`${PROVIDER_LABELS[cli]} path`}
            />
            <p className="text-[10.5px] leading-relaxed text-faint">
              Artemis runs your installed {PROVIDER_LABELS[cli]} and reads its reply, so the
              answer comes from the subscription that CLI is already signed in
              with. No API key is stored, and it is given no tools — every SQL
              statement still lands in the editor for you to run.
            </p>
          </div>
        )}

        {modelsError && !cli && (
          <p className="font-mono text-[11px] leading-relaxed text-destructive/90">{modelsError}</p>
        )}
      </div>

      {/* The conversation. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport className="px-3 py-3">
            <MessageScrollerContent className="gap-5">
              {turns.length === 0 && <EmptyState provider={provider} ready={backendReady} />}
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
          placeholder={
            backendReady
              ? "Ask for a query or report…"
              : cli
                ? `Install the ${PROVIDER_LABELS[cli]} to start`
                : "Pick a model to start"
          }
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

/// What the look-up found. Three states worth telling apart: still looking,
/// found (with the version, so a stale CLI is visible), and not found — the
/// last of which is guidance, not an error, because installing the CLI is
/// the fix and the user has not done anything wrong.
function CliStatusLine({ provider, status }: { provider: CliProvider; status: AgentStatus | null }) {
  if (!status) {
    return (
      <p className="font-mono text-[10px] leading-relaxed text-faint">
        looking for {provider}…
      </p>
    );
  }
  if (!status.installed) {
    // The shell's own words: "not found" and "could not be run" are
    // different problems, and only one of them is fixed by installing.
    return (
      <p className="font-mono text-[10px] leading-relaxed text-destructive/80">
        {status.message || `${provider} is unavailable`}
      </p>
    );
  }
  return (
    <p className="font-mono text-[10px] leading-relaxed text-faint" title={status.path}>
      {status.version || provider} · signed in through the CLI
    </p>
  );
}

function EmptyState({ provider, ready }: { provider: Provider; ready: boolean }) {
  const cli = isCliProvider(provider) ? provider : null;
  const blurb = ready
    ? "Describe the query or report you want. SQL answers get a Send to editor button so you review and run them yourself."
    : cli
      ? `${INSTALL_HINTS[cli]} ${LOGIN_HINTS[cli]} Artemis uses that login — there is no API key to enter.`
      : "This chat runs a local model through Ollama. Choose one above to begin.";
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Bot className="size-6 text-faint" />
      <p className="text-[12.5px] font-medium text-foreground">
        {ready ? "Ask about your data" : cli ? `Set up the ${PROVIDER_LABELS[cli]}` : "Pick a model to start"}
      </p>
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{blurb}</p>
    </div>
  );
}

function ChatTurn({ turn, onSendToEditor }: { turn: Turn; onSendToEditor: (sql: string) => void }) {
  // A probe's result: the model saw the rows, the human sees this receipt.
  if (turn.kind === "probe-result") {
    return (
      <Marker variant="default">
        <MarkerContent className="font-mono text-[10.5px] text-muted-foreground">
          🔍 {turn.content}
        </MarkerContent>
      </Marker>
    );
  }

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
            {turn.note && (
              <p className="font-mono text-[10.5px] leading-relaxed text-destructive/90">
                ⚠ reply incomplete: {turn.note}
              </p>
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
