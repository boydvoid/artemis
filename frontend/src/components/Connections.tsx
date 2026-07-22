// The home screen: pick a database, or add one.
//
// Connections used to share the left rail with the table list, which meant
// the rail carried two unrelated jobs and the thing you do first was the
// thing with least room. This screen is the app's entry point; choosing a
// connection is what opens the workspace.

import { useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import Logo from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bridgeAvailable, pickSqliteFile } from "@/lib/bridge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  EMPTY_FIELDS,
  SSL_MODES,
  buildUrl,
  parseUrl,
  type ConnectionFields,
} from "@/lib/pgurl";
import { DB_KINDS, connectionKind, type DbKind } from "@/lib/db";
import type { Connection } from "@/lib/store";

/// A connection URL for one engine. SQLite is `sqlite:<path>`; Postgres keeps
/// whatever the URL/fields editor built.
function urlForEngine(engine: DbKind, value: string): string {
  if (engine === "sqlite") return value.length > 0 ? `sqlite:${value}` : "";
  return value;
}

function sqlitePathOf(url: string): string {
  return url.startsWith("sqlite:") ? url.slice("sqlite:".length) : "";
}

interface Props {
  connections: Connection[];
  activeId: number;
  busy: boolean;
  draftName: string;
  draftUrl: string;
  setDraftName: (v: string) => void;
  setDraftUrl: (v: string) => void;
  onAdd: () => void;
  onOpen: (id: number) => void;
  onRemove: (id: number) => void;
}

export default function Connections(props: Props) {
  // The URL in `props.draftUrl` stays the single value being edited; the field
  // editor writes through to it on every change. That is what lets Add stay
  // ignorant of which mode you typed in.
  const [mode, setMode] = useState<"url" | "fields">("url");
  const [fields, setFields] = useState<ConnectionFields>(EMPTY_FIELDS);
  // Which engine the new connection is for. Switching starts the draft over —
  // a Postgres URL means nothing to SQLite and vice versa.
  const [engine, setEngine] = useState<DbKind>("postgres");

  // The native file picker fills the path in. Only offered inside the shell —
  // a plain browser tab has no picker, so the typed path stays the way in.
  async function browseSqlite() {
    const path = await pickSqliteFile();
    if (path) props.setDraftUrl(urlForEngine("sqlite", path));
  }

  function switchEngine(next: DbKind) {
    if (next === engine) return;
    setEngine(next);
    setMode("url");
    setFields(EMPTY_FIELDS);
    props.setDraftUrl("");
  }

  function showFields() {
    // Carry over whatever is already in the URL box. A URL we cannot parse
    // leaves the fields alone rather than blanking them with a bad guess.
    setFields(parseUrl(props.draftUrl) ?? EMPTY_FIELDS);
    setMode("fields");
  }

  function setField(key: keyof ConnectionFields, value: string) {
    const next = { ...fields, [key]: value };
    setFields(next);
    props.setDraftUrl(buildUrl(next));
  }

  const kinds = new Set(props.connections.map((c) => connectionKind(c.url)));

  return (
    <div className="home-surface flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[820px] px-8 py-12">
        <header className="home-rise mb-8 flex items-end justify-between border-b border-hairline pb-5">
          <div className="flex items-center gap-3.5">
            <Logo className="h-7 w-auto text-amber" />
            <div>
              <h1 className="text-[16px] font-semibold tracking-[0.2em]">ARTEMIS</h1>
              <p className="mt-0.5 font-mono text-[11px] tracking-[0.05em] text-muted-foreground">
                Database browser
              </p>
            </div>
          </div>
          <div className="hidden flex-col items-end gap-1 font-mono text-[10px] tracking-[0.12em] text-faint uppercase sm:flex">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-1.5 rounded-full bg-amber shadow-[0_0_6px_var(--ring)]" />
              online
            </span>
            <span>
              {props.connections.length} conn · {kinds.size || 0} engine
              {kinds.size === 1 ? "" : "s"}
            </span>
          </div>
        </header>

        <Panel
          label="Connections"
          meta={`${props.connections.length} saved`}
          className="home-rise"
          style={{ animationDelay: "60ms" }}
        >
          {props.connections.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-[12.5px] text-muted-foreground">No connections yet.</p>
              <p className="mt-1 font-mono text-[11px] text-faint">
                Add one below to get started.
              </p>
            </div>
          ) : (
            <ul className="list-none divide-y divide-hairline p-0">
              {props.connections.map((c, i) => {
                const isActive = c.id === props.activeId;
                const delay = `${140 + i * 55}ms`;
                return (
                  <li key={c.id} className="home-rise" style={{ animationDelay: delay }}>
                    <div
                      className={cn(
                        "group relative flex cursor-pointer items-stretch transition-colors",
                        isActive
                          ? "bg-amber/[0.045] shadow-[inset_2px_0_0_var(--amber)]"
                          : "hover:bg-accent/40",
                      )}
                      onClick={() => props.onOpen(c.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          props.onOpen(c.id);
                        }
                      }}
                    >
                      {/* Signal rail: a status LED (amber = live) over a
                          patch-panel channel number. */}
                      <div className="flex w-[52px] flex-none flex-col items-center justify-center gap-1.5 border-r border-hairline">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            isActive ? "led-live" : "border border-faint",
                          )}
                          style={isActive ? { animationDelay: delay } : undefined}
                          aria-hidden
                        />
                        <span className="font-mono text-[9px] tracking-[0.1em] text-faint">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                      </div>

                      <div className="min-w-0 flex-1 py-3 pl-4 pr-2">
                        <div className="flex items-center gap-2.5">
                          <span className="text-[14px] leading-none text-foreground">
                            {c.name}
                          </span>
                          <EngineTag kind={connectionKind(c.url)} />
                          <span className="flex-1" />
                          {isActive ? (
                            <span className="font-mono text-[9.5px] tracking-[0.16em] text-amber uppercase">
                              live
                            </span>
                          ) : (
                            <span className="font-mono text-[10px] tracking-[0.1em] text-faint opacity-0 transition-opacity group-hover:opacity-100">
                              open ▸
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 overflow-hidden font-mono text-[11px] whitespace-nowrap text-faint [mask-image:linear-gradient(90deg,#000_calc(100%-40px),transparent)]">
                          {c.url}
                        </div>
                      </div>

                      <div className="flex flex-none items-center pr-2">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onRemove(c.id);
                          }}
                          disabled={props.busy}
                          aria-label={`Delete ${c.name}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel
          label="Add connection"
          className="home-rise mt-6"
          style={{ animationDelay: "120ms" }}
          right={
            <div className="flex items-center gap-2">
              <Segment>
                {DB_KINDS.map((entry) => (
                  <ModeTab
                    key={entry.kind}
                    active={engine === entry.kind}
                    onClick={() => switchEngine(entry.kind)}
                  >
                    {entry.label}
                  </ModeTab>
                ))}
              </Segment>
              {/* URL vs field editor is a Postgres-only choice. */}
              {engine === "postgres" && (
                <Segment>
                  <ModeTab active={mode === "url"} onClick={() => setMode("url")}>
                    URL
                  </ModeTab>
                  <ModeTab active={mode === "fields"} onClick={showFields}>
                    Fields
                  </ModeTab>
                </Segment>
              )}
            </div>
          }
        >
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-end gap-2.5">
              <Field label="name" className="w-[180px] flex-none">
                <Input
                  className="h-8 font-mono text-[12px]"
                  value={props.draftName}
                  onChange={(e) => props.setDraftName(e.target.value)}
                  placeholder="my database"
                  aria-label="Connection name"
                />
              </Field>
              {engine === "postgres" && mode === "url" && (
                <Field label="connection string" className="flex-1">
                  <Input
                    className="h-8 font-mono text-[12px]"
                    value={props.draftUrl}
                    onChange={(e) => props.setDraftUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && props.onAdd()}
                    placeholder="postgres://user:password@localhost:5432/postgres"
                    aria-label="Connection string"
                  />
                </Field>
              )}
              {engine === "sqlite" && (
                <Field label="database file" className="flex-1">
                  <div className="flex h-8 items-center overflow-hidden rounded-md border border-input bg-transparent font-mono text-[12px] focus-within:border-ring dark:bg-input/30">
                    <span className="flex-none border-r border-hairline px-2 py-1.5 text-faint select-none">
                      sqlite:
                    </span>
                    <input
                      className="h-full min-w-0 flex-1 bg-transparent px-2 text-foreground outline-none placeholder:text-faint"
                      value={sqlitePathOf(props.draftUrl)}
                      onChange={(e) =>
                        props.setDraftUrl(urlForEngine("sqlite", e.target.value))
                      }
                      onKeyDown={(e) => e.key === "Enter" && props.onAdd()}
                      placeholder="/absolute/path/to/database.db"
                      aria-label="SQLite file path"
                    />
                    {bridgeAvailable() && (
                      <button
                        className="flex h-full flex-none items-center gap-1 border-l border-hairline px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-amber"
                        onClick={() => void browseSqlite()}
                        type="button"
                        aria-label="Browse for a SQLite file"
                      >
                        <FolderOpen className="size-3.5" />
                        Browse
                      </button>
                    )}
                  </div>
                </Field>
              )}
              {engine === "postgres" && mode === "fields" && <span className="flex-1" />}
              <Button onClick={props.onAdd} disabled={props.busy}>
                <Plus />
                Add
              </Button>
            </div>

            {mode === "fields" && (
              <>
                <div className="grid grid-cols-3 gap-2.5">
                <Field label="host">
                  <Input
                    className="h-8 font-mono text-[12px]"
                    value={fields.host}
                    onChange={(e) => setField("host", e.target.value)}
                    placeholder="localhost"
                    aria-label="Host"
                  />
                </Field>
                <Field label="port">
                  <Input
                    className="h-8 font-mono text-[12px]"
                    value={fields.port}
                    onChange={(e) => setField("port", e.target.value)}
                    placeholder="5432"
                    inputMode="numeric"
                    aria-label="Port"
                  />
                </Field>
                <Field label="database">
                  <Input
                    className="h-8 font-mono text-[12px]"
                    value={fields.database}
                    onChange={(e) => setField("database", e.target.value)}
                    placeholder="postgres"
                    aria-label="Database"
                  />
                </Field>
                <Field label="user">
                  <Input
                    className="h-8 font-mono text-[12px]"
                    value={fields.user}
                    onChange={(e) => setField("user", e.target.value)}
                    placeholder="postgres"
                    aria-label="User"
                  />
                </Field>
                <Field label="password">
                  <Input
                    className="h-8 font-mono text-[12px]"
                    type="password"
                    value={fields.password}
                    onChange={(e) => setField("password", e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && props.onAdd()}
                    aria-label="Password"
                  />
                </Field>
                <Field label="ssl mode">
                  <Select
                    value={fields.sslmode}
                    onValueChange={(next) => setField("sslmode", next ?? "")}
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-8 w-full font-mono text-[12px]"
                      aria-label="SSL mode"
                    >
                      <SelectValue>{(value) => (value ? String(value) : "default")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {SSL_MODES.map((value) => (
                        <SelectItem
                          key={value || "default"}
                          value={value}
                          className="font-mono text-[11.5px]"
                        >
                          {value || "default"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>

                {/* The URL these fields make. Shown because it is what
                    actually gets stored, and because it is where you can see a
                    password with an `@` in it come out correctly escaped. */}
                <div className="flex items-center gap-2 border-t border-hairline pt-2.5">
                  <span className="font-mono text-[9px] tracking-[0.14em] text-faint uppercase">
                    url
                  </span>
                  <p className="min-w-0 flex-1 overflow-x-auto font-mono text-[10.5px] whitespace-nowrap text-muted-foreground">
                    {props.draftUrl || (
                      <span className="text-faint">a host is needed to form a connection URL</span>
                    )}
                  </p>
                </div>
              </>
            )}
          </div>
        </Panel>

        <p className="mt-5 flex items-center gap-1.5 font-mono text-[10px] tracking-[0.06em] text-faint">
          <span className="text-muted-foreground">·</span>
          Stored locally in SQLite, in plain text.
        </p>
      </div>
    </div>
  );
}

/// A framed instrument panel: hairline border, a labelled header strip, and
/// registration ticks at the corners.
function Panel(props: {
  label: string;
  meta?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section
      className={cn("relative rounded-[3px] border border-border/70 bg-card/25", props.className)}
      style={props.style}
    >
      <RegTicks />
      <header className="flex items-center gap-3 border-b border-hairline px-4 py-2.5">
        <h2 className="font-mono text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {props.label}
        </h2>
        {props.meta && (
          <span className="font-mono text-[10px] tracking-[0.08em] text-faint">{props.meta}</span>
        )}
        <span className="flex-1" />
        {props.right}
      </header>
      {props.children}
    </section>
  );
}

/// Engineering crop marks just outside a panel's four corners.
function RegTicks() {
  return (
    <>
      <span className="reg-tick -top-1 -left-1 border-t border-l" />
      <span className="reg-tick -top-1 -right-1 border-t border-r" />
      <span className="reg-tick -bottom-1 -left-1 border-b border-l" />
      <span className="reg-tick -right-1 -bottom-1 border-r border-b" />
    </>
  );
}

/// A segmented control housing — the connected switch look.
function Segment(props: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-[3px] border border-hairline bg-background/50 p-0.5">
      {props.children}
    </div>
  );
}

/// The engine type tag on a connection strip. Monochrome — amber is reserved
/// for "this is the live one".
function EngineTag(props: { kind: DbKind }) {
  return (
    <span className="flex-none rounded-[2px] border border-hairline bg-background/60 px-1.5 py-px font-mono text-[9px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
      {props.kind === "sqlite" ? "SQLite" : "Postgres"}
    </span>
  );
}

function ModeTab(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        "rounded-[2px] px-2 py-1 font-mono text-[10px] tracking-[0.1em] uppercase transition-colors",
        props.active
          ? "bg-amber/15 text-amber"
          : "text-faint hover:bg-accent hover:text-foreground",
      )}
      onClick={props.onClick}
      aria-pressed={props.active}
    >
      {props.children}
    </button>
  );
}

function Field(props: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", props.className)}>
      <span className="font-mono text-[9px] tracking-[0.14em] text-faint uppercase">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}
