import {
  ArrowLeft,
  Bot,
  Check,
  Database,
  Play,
  Plus,
  RefreshCw,
  Save,
  SquareStack,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import type { Connection, SavedQuery } from "@/lib/store";
import type { TableRef } from "@/lib/parse";
import type { QueryTab } from "@/lib/tabs";

/// The ⌘K palette. It is a lens over the same actions the rest of the UI
/// exposes — jump to any table or saved query, switch tab or connection, run
/// the current query, manage staged edits — so nothing here is new behavior,
/// only a faster way to reach it. cmdk owns filtering and keyboard nav; each
/// item just runs its action and closes.

export interface CommandMenuActions {
  home: () => void;
  openConnection: (id: number) => void;
  openTable: (t: TableRef) => void;
  openSaved: (q: SavedQuery) => void;
  selectTab: (id: number) => void;
  newQuery: () => void;
  runQuery: () => void;
  reloadTables: () => void;
  closeTab: (id: number) => void;
  commit: () => void;
  discard: () => void;
  toggleChat: () => void;
}

interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  screen: "home" | "workspace";
  connections: Connection[];
  activeId: number;
  tables: TableRef[];
  saved: SavedQuery[];
  tabs: QueryTab[];
  activeTabId: number;
  hasStaged: boolean;
  /// True when the active tab is a query editor with a statement to run.
  canRun: boolean;
  actions: CommandMenuActions;
}

export default function CommandMenu(props: CommandMenuProps) {
  const { actions } = props;

  // Every selection closes the palette first, then acts — so an action that
  // itself opens something (a table, a connection) lands on a clean screen.
  const run = (fn: () => void) => () => {
    props.onOpenChange(false);
    fn();
  };

  const inWorkspace = props.screen === "workspace";
  const activeTab = props.tabs.find((t) => t.id === props.activeTabId);

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandInput placeholder="Search tables, queries, actions…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        {inWorkspace && (
          <CommandGroup heading="Actions">
            <CommandItem value="act:new-query" keywords={["new", "query", "tab", "editor"]} onSelect={run(actions.newQuery)}>
              <Plus />
              New query tab
              <CommandShortcut>⌘T</CommandShortcut>
            </CommandItem>
            {props.canRun && (
              <CommandItem value="act:run" keywords={["run", "execute", "query"]} onSelect={run(actions.runQuery)}>
                <Play />
                Run query
                <CommandShortcut>⌘↵</CommandShortcut>
              </CommandItem>
            )}
            <CommandItem value="act:reload" keywords={["reload", "refresh", "tables", "schema"]} onSelect={run(actions.reloadTables)}>
              <RefreshCw />
              Reload tables
            </CommandItem>
            <CommandItem value="act:chat" keywords={["chat", "ai", "ollama", "assistant", "ask"]} onSelect={run(actions.toggleChat)}>
              <Bot />
              Toggle AI chat
              <CommandShortcut>⌘J</CommandShortcut>
            </CommandItem>
            {props.hasStaged && (
              <>
                <CommandItem value="act:commit" keywords={["commit", "save", "edits", "apply"]} onSelect={run(actions.commit)}>
                  <Check />
                  Commit staged edits
                </CommandItem>
                <CommandItem value="act:discard" keywords={["discard", "revert", "edits", "cancel"]} onSelect={run(actions.discard)}>
                  <Trash2 />
                  Discard staged edits
                </CommandItem>
              </>
            )}
            {props.tabs.length > 1 && activeTab && (
              <CommandItem value="act:close-tab" keywords={["close", "tab"]} onSelect={run(() => actions.closeTab(props.activeTabId))}>
                <X />
                Close current tab
              </CommandItem>
            )}
            <CommandItem value="act:home" keywords={["home", "back", "connections", "disconnect"]} onSelect={run(actions.home)}>
              <ArrowLeft />
              Back to connections
            </CommandItem>
          </CommandGroup>
        )}

        {inWorkspace && props.tabs.length > 1 && (
          <CommandGroup heading="Open tabs">
            {props.tabs.map((t) => (
              <CommandItem
                key={t.id}
                value={`tab:${t.id}`}
                keywords={[t.name, "tab"]}
                onSelect={run(() => actions.selectTab(t.id))}
              >
                <SquareStack />
                <span className="truncate">{t.name}</span>
                {t.id === props.activeTabId && <CommandShortcut>current</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {inWorkspace && props.tables.length > 0 && (
          <CommandGroup heading="Tables">
            {props.tables.map((t) => (
              <CommandItem
                key={t.id}
                value={`tbl:${t.id}`}
                keywords={[t.name, t.schema, `${t.schema}.${t.name}`]}
                onSelect={run(() => actions.openTable(t))}
              >
                <Table2 />
                <span className="truncate">{t.name}</span>
                <span className="ml-auto font-mono text-[10.5px] text-faint">{t.schema}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {props.saved.length > 0 && (
          <CommandGroup heading="Saved queries">
            {props.saved.map((q) => (
              <CommandItem
                key={q.id}
                value={`sav:${q.id}`}
                keywords={[q.name, "saved", "query"]}
                onSelect={run(() => actions.openSaved(q))}
              >
                <Save />
                <span className="truncate">{q.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {props.connections.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Connections">
              {props.connections.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`con:${c.id}`}
                  keywords={[c.name, c.url, "connection", "switch"]}
                  onSelect={run(() => actions.openConnection(c.id))}
                >
                  <Database />
                  <span className="truncate">{c.name}</span>
                  {c.id === props.activeId && <CommandShortcut>active</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
