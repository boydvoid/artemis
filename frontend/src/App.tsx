import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Save, Trash2, X } from "lucide-react";
import Connections from "@/components/Connections";
import DataGrid from "@/components/DataGrid";
import FilterBar from "@/components/FilterBar";
import TabStrip from "@/components/TabStrip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bridgeAvailable, exec } from "@/lib/bridge";
import {
  addConnection as storeAdd,
  deleteConnection as storeDelete,
  deleteSavedQuery,
  loadActiveId,
  loadConnections,
  loadSavedQueries,
  saveActiveId,
  saveQuery,
  updateSavedQuery,
  type Connection,
  type SavedQuery,
} from "@/lib/store";
import { parsePage, parsePkCols, parseTables, type TableRef } from "@/lib/parse";
import {
  PAGE_SIZE,
  TABLES_SQL,
  commitSql,
  dataSql,
  isPageable,
  pkSql,
  rowPredicate,
  wrapPaged,
  type Filter,
} from "@/lib/sql";
import { freshTab, tabById, withTab, type QueryTab } from "@/lib/tabs";

export default function App() {
  // Connections are the home screen; picking one opens the workspace.
  const [screen, setScreen] = useState<"home" | "workspace">("home");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeId, setActiveId] = useState<number>(0);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");

  const [tables, setTables] = useState<TableRef[]>([]);
  const [tableFilter, setTableFilter] = useState("");
  const [saved, setSaved] = useState<SavedQuery[]>([]);

  const [tabs, setTabs] = useState<QueryTab[]>([freshTab(1)]);
  const [activeTabId, setActiveTabId] = useState(1);
  const [nextTabId, setNextTabId] = useState(2);
  const [panel, setPanel] = useState<"query" | "filters">("query");
  const [saveName, setSaveName] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const active = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );
  const tab = useMemo(() => tabById(tabs, activeTabId) ?? tabs[0], [tabs, activeTabId]);

  /// Staged values indexed for the grid: `${ctid}:${colIndex}`.
  const stagedMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const edit of tab.staged) map.set(`${edit.key}:${edit.colIndex}`, edit.value);
    return map;
  }, [tab.staged]);

  /// Patch the active tab. Every result, page move and staged edit goes
  /// through here, which is what keeps tabs from leaking into each other.
  const patchTab = useCallback(
    (patch: Partial<QueryTab>) => setTabs((prev) => withTab(prev, activeTabId, patch)),
    [activeTabId],
  );

  // Boot: the store is the source of truth, so the first render is empty
  // and the app fills in from the bridge.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rows, savedRows, activeConn] = await Promise.all([
          loadConnections(),
          loadSavedQueries(),
          loadActiveId(),
        ]);
        if (cancelled) return;
        setConnections(rows);
        setSaved(savedRows);
        if (rows.some((c) => c.id === activeConn)) setActiveId(activeConn);
      } catch (storeError) {
        if (!cancelled) {
          setError(storeError instanceof Error ? storeError.message : String(storeError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /// Every statement goes through here so timing, busy state and error
  /// reporting happen in exactly one place.
  const run = useCallback(
    async (statement: string): Promise<{ out: string; ms: number } | null> => {
      if (!active) {
        setError("No active connection.");
        return null;
      }
      const started = performance.now();
      setBusy(true);
      try {
        const result = await exec(active.url, statement);
        const ms = Math.round(performance.now() - started);
        if (!result.ok) {
          // psql's own message is far more useful than anything we could
          // synthesise, so surface it verbatim.
          setError(result.err.trim() || `psql exited with code ${result.code}`);
          return null;
        }
        setError("");
        return { out: result.out, ms };
      } finally {
        setBusy(false);
      }
    },
    [active],
  );

  const loadTables = useCallback(async () => {
    const result = await run(TABLES_SQL);
    if (result === null) {
      setTables([]);
      return;
    }
    setTables(parseTables(result.out));
  }, [run]);

  // Changing connection resets every tab: their results describe a database
  // that is no longer selected. The statement text is kept — that is the
  // user's writing, not the database's data.
  useEffect(() => {
    if (!active) {
      setTables([]);
      return;
    }
    setTabs((prev) =>
      prev.map((t) => ({ ...freshTab(t.id, t.name), sql: t.sql, savedId: t.savedId })),
    );
    void loadTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  async function openTable(table: TableRef) {
    const pkResult = await run(pkSql(table.schema, table.name));
    // No primary key is fine — orderSql falls back to ctid.
    const pkCols = pkResult === null ? [] : parsePkCols(pkResult.out);
    const statement = dataSql(table.schema, table.name, [], pkCols, 0);
    const result = await run(statement);
    if (result === null) return;
    patchTab({
      name: table.name,
      sql: statement,
      source: { kind: "table", table, pkCols, filters: [] },
      page: parsePage(result.out, true),
      pageIndex: 0,
      staged: [],
      status: `${table.schema}.${table.name}`,
      elapsed: result.ms,
    });
    setPanel("query");
  }

  /// Re-run the current table at page 0 under a new filter set. Filters
  /// change which rows exist, so the old page index is meaningless.
  async function applyFilters(next: Filter[]) {
    if (tab.source.kind !== "table") return;
    const { table, pkCols } = tab.source;
    const statement = dataSql(table.schema, table.name, next, pkCols, 0);
    const result = await run(statement);
    if (result === null) return;
    patchTab({
      sql: statement,
      source: { kind: "table", table, pkCols, filters: next },
      page: parsePage(result.out, true),
      pageIndex: 0,
      staged: [],
      elapsed: result.ms,
    });
  }

  async function runEditor() {
    const statement = tab.sql.trim();
    if (statement.length === 0) return;
    const pageable = isPageable(statement);
    const result = await run(pageable ? wrapPaged(statement, 0) : statement);
    if (result === null) return;
    patchTab({
      source: pageable ? { kind: "sql", sql: statement } : { kind: "none" },
      page: parsePage(result.out, false),
      pageIndex: 0,
      staged: [],
      status: pageable ? "query" : "query (single run)",
      elapsed: result.ms,
    });
    setPanel("query");
  }

  async function goToPage(next: number) {
    if (next < 0 || tab.source.kind === "none") return;
    const offset = next * PAGE_SIZE;
    const source = tab.source;
    const statement =
      source.kind === "table"
        ? dataSql(source.table.schema, source.table.name, source.filters, source.pkCols, offset)
        : wrapPaged(source.sql, offset);
    const result = await run(statement);
    if (result === null) return;
    patchTab({
      page: parsePage(result.out, source.kind === "table"),
      pageIndex: next,
      staged: [],
      elapsed: result.ms,
      ...(source.kind === "table" ? { sql: statement } : {}),
    });
  }

  /// Record an edit against the row's ORIGINAL values. Re-editing the same
  /// cell replaces its entry, and typing the database's own value back in
  /// removes it — so the batch only ever holds real changes.
  function stageEdit(rowIndex: number, colIndex: number, value: string) {
    if (tab.source.kind !== "table") return;
    const key = tab.page.keys[rowIndex] ?? "";
    if (key.length === 0) return;
    const source = tab.source;

    const rest = tab.staged.filter((e) => !(e.key === key && e.colIndex === colIndex));
    const unchanged = value === (tab.page.rows[rowIndex][colIndex] ?? "");
    patchTab({
      staged: unchanged
        ? rest
        : [
            ...rest,
            {
              key,
              column: tab.page.cols[colIndex],
              colIndex,
              value,
              where: rowPredicate(source.pkCols, tab.page.cols, tab.page.rows[rowIndex], key),
            },
          ],
    });
  }

  async function commitStaged() {
    if (tab.source.kind !== "table" || tab.staged.length === 0) return;
    const statement = commitSql(
      tab.source.table.schema,
      tab.source.table.name,
      tab.staged,
      tab.source.filters,
      tab.source.pkCols,
      tab.pageIndex * PAGE_SIZE,
    );
    const result = await run(statement);
    // A failed commit leaves the batch intact so nothing is silently lost;
    // the transaction rolled back, so the database is untouched.
    if (result === null) return;
    const count = tab.staged.length;
    patchTab({
      staged: [],
      page: parsePage(result.out, true),
      status: `committed ${count} edit${count === 1 ? "" : "s"}`,
      elapsed: result.ms,
    });
  }

  // ---- tabs

  function newTab() {
    const created = freshTab(nextTabId);
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
    setNextTabId((n) => n + 1);
    setPanel("query");
    setSaveName(null);
  }

  function closeTab(id: number) {
    setTabs((prev) => {
      if (prev.length === 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (id === activeTabId) setActiveTabId(next[next.length - 1].id);
      return next;
    });
  }

  function selectTab(id: number) {
    setActiveTabId(id);
    setPanel("query");
    setSaveName(null);
  }

  // ---- saved queries

  async function commitSave() {
    const name = (saveName ?? "").trim();
    const statement = tab.sql.trim();
    if (name.length === 0 || statement.length === 0) return;
    try {
      // A tab that came from a saved query updates it rather than piling up
      // near-duplicates.
      const rows =
        tab.savedId > 0
          ? await updateSavedQuery(tab.savedId, name, statement)
          : await saveQuery(name, statement);
      setSaved(rows);
      const match = rows.filter((q) => q.name === name).pop();
      patchTab({ name, savedId: match ? match.id : tab.savedId, status: "saved" });
      setSaveName(null);
    } catch (storeError) {
      setError(storeError instanceof Error ? storeError.message : String(storeError));
    }
  }

  /// Opening a saved query gets its own tab, so it never overwrites what is
  /// already in front of you.
  function openSaved(query: SavedQuery) {
    const created: QueryTab = {
      ...freshTab(nextTabId, query.name),
      sql: query.sql,
      savedId: query.id,
    };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
    setNextTabId((n) => n + 1);
    setPanel("query");
  }

  async function removeSaved(id: number) {
    try {
      setSaved(await deleteSavedQuery(id));
      // Tabs that pointed at it become plain unsaved tabs.
      setTabs((prev) => prev.map((t) => (t.savedId === id ? { ...t, savedId: 0 } : t)));
    } catch (storeError) {
      setError(storeError instanceof Error ? storeError.message : String(storeError));
    }
  }

  // ---- connections

  async function addConnection() {
    const name = draftName.trim();
    const url = draftUrl.trim();
    if (url.length === 0) return;
    try {
      const rows = await storeAdd(name || url, url);
      setConnections(rows);
      setDraftName("");
      setDraftUrl("");
      const added = rows.filter((c) => c.url === url).pop();
      if (added) openConnection(added.id);
    } catch (storeError) {
      setError(storeError instanceof Error ? storeError.message : String(storeError));
    }
  }

  async function removeConnection(id: number) {
    try {
      setConnections(await storeDelete(id));
      if (id === activeId) {
        selectConnection(0);
        setScreen("home");
      }
    } catch (storeError) {
      setError(storeError instanceof Error ? storeError.message : String(storeError));
    }
  }

  /// Selection is persisted like any other preference — through the bridge,
  /// never in the WebView.
  function selectConnection(id: number) {
    setActiveId(id);
    void saveActiveId(id);
  }

  /// Opening a connection is what enters the workspace.
  function openConnection(id: number) {
    selectConnection(id);
    setScreen("workspace");
  }

  const visibleTables = useMemo(() => {
    const needle = tableFilter.trim().toLowerCase();
    if (needle.length === 0) return tables;
    return tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(needle));
  }, [tables, tableFilter]);

  const filters = tab.source.kind === "table" ? tab.source.filters : [];
  const stagedRowCount = new Set(tab.staged.map((e) => e.key)).size;
  const firstRow = tab.pageIndex * PAGE_SIZE + (tab.page.rows.length > 0 ? 1 : 0);
  const lastRow = tab.pageIndex * PAGE_SIZE + tab.page.rows.length;

  if (screen === "home") {
    return (
      <Connections
        connections={connections}
        activeId={activeId}
        busy={busy}
        draftName={draftName}
        draftUrl={draftUrl}
        setDraftName={setDraftName}
        setDraftUrl={setDraftUrl}
        onAdd={() => void addConnection()}
        onOpen={openConnection}
        onRemove={(id) => void removeConnection(id)}
      />
    );
  }

  return (
    <div className="flex h-full">
      <Rail
        activeName={active ? active.name : ""}
        onHome={() => setScreen("home")}
        tables={visibleTables}
        tableFilter={tableFilter}
        setTableFilter={setTableFilter}
        onOpenTable={openTable}
        activeTableId={tab.source.kind === "table" ? tab.source.table.id : ""}
        onReload={loadTables}
        connected={!!active}
        saved={saved}
        onOpenSaved={openSaved}
        onRemoveSaved={(id) => void removeSaved(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <TabStrip
          tabs={tabs}
          activeTabId={activeTabId}
          panel={panel}
          filterCount={filters.length}
          filtersEnabled={tab.source.kind === "table"}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
          onShowFilters={() => setPanel("filters")}
        />

        {panel === "query" ? (
          <Editor
            sql={tab.sql}
            setSql={(v) => patchTab({ sql: v })}
            onRun={runEditor}
            busy={busy}
            disabled={!active}
            saveName={saveName}
            setSaveName={setSaveName}
            onStartSave={() => setSaveName(tab.name)}
            onCommitSave={() => void commitSave()}
            isSaved={tab.savedId > 0}
          />
        ) : (
          <FilterBar
            columns={tab.page.cols}
            filters={filters}
            busy={busy}
            onChange={(next) => void applyFilters(next)}
          />
        )}

        {error && (
          <div
            className="flex flex-none items-start gap-2.5 border-b border-destructive/30 bg-destructive/8 px-3 py-2"
            role="alert"
          >
            <span className="pt-0.5 font-mono text-[10px] tracking-[0.1em] text-destructive">
              error
            </span>
            <pre className="m-0 flex-1 font-mono text-[11.5px] break-words whitespace-pre-wrap text-destructive/90">
              {error}
            </pre>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setError("")}
              aria-label="Dismiss error"
            >
              <X />
            </Button>
          </div>
        )}

        {tab.staged.length > 0 && (
          <div className="flex flex-none items-center gap-2.5 border-b border-ring bg-amber/8 px-3 py-1.5 font-mono text-[11.5px]">
            <span className="text-amber">
              {tab.staged.length} staged edit{tab.staged.length === 1 ? "" : "s"}
            </span>
            <span className="text-muted-foreground">
              {stagedRowCount} row{stagedRowCount === 1 ? "" : "s"} · one transaction
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => patchTab({ staged: [] })}
              disabled={busy}
            >
              Discard
            </Button>
            <Button size="sm" onClick={() => void commitStaged()} disabled={busy}>
              Commit
            </Button>
          </div>
        )}

        <DataGrid
          page={tab.page}
          keyed={tab.source.kind === "table"}
          staged={stagedMap}
          editable={tab.source.kind === "table"}
          onStage={stageEdit}
        />

        <footer className="flex h-7 flex-none items-center gap-3 border-t border-border bg-card px-3 font-mono text-[11px] text-muted-foreground">
          <span
            className={cn(
              "size-1.5 flex-none rounded-full",
              active ? "bg-amber shadow-[0_0_6px_var(--ring)]" : "bg-faint",
            )}
          />
          <span>
            {active ? active.name : "not connected"}
            {tab.status && <span className="text-faint"> · {tab.status}</span>}
          </span>
          <span className="flex-1" />
          {tab.page.cols.length > 0 && (
            <>
              <span className="text-faint">
                {tab.page.cols.length} col{tab.page.cols.length === 1 ? "" : "s"}
              </span>
              <span className="text-faint">
                {firstRow}–{lastRow}
              </span>
            </>
          )}
          {tab.elapsed > 0 && <span className="text-faint">{tab.elapsed} ms</span>}
          {tab.source.kind !== "none" && (
            <span className="flex gap-0.5">
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={tab.pageIndex === 0 || busy}
                onClick={() => void goToPage(tab.pageIndex - 1)}
                aria-label="Previous page"
              >
                <ChevronLeft />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={!tab.page.hasNext || busy}
                onClick={() => void goToPage(tab.pageIndex + 1)}
                aria-label="Next page"
              >
                <ChevronRight />
              </Button>
            </span>
          )}
        </footer>
      </main>
    </div>
  );
}

interface RailProps {
  activeName: string;
  onHome: () => void;
  tables: TableRef[];
  tableFilter: string;
  setTableFilter: (v: string) => void;
  onOpenTable: (t: TableRef) => void;
  activeTableId: string;
  onReload: () => void;
  connected: boolean;
  saved: SavedQuery[];
  onOpenSaved: (q: SavedQuery) => void;
  onRemoveSaved: (id: number) => void;
}

function Rail(props: RailProps) {
  return (
    <aside className="flex w-[246px] flex-none flex-col overflow-hidden border-r border-border bg-card">
      {/* The rail header doubles as the way back to the connections
          screen — the active database is also the breadcrumb. */}
      <button
        className="group flex items-center gap-2 border-b border-border px-3 py-2.5 text-left hover:bg-accent"
        onClick={props.onHome}
        title="Back to connections"
      >
        <ChevronLeft className="size-3.5 flex-none text-muted-foreground transition-colors group-hover:text-amber" />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            Connection
          </span>
          <span className="block overflow-hidden text-[12.5px] text-ellipsis whitespace-nowrap text-amber">
            {props.activeName || "none"}
          </span>
        </span>
        {!bridgeAvailable() && (
          <span className="font-mono text-[10px] text-destructive">no bridge</span>
        )}
      </button>

      <section className="flex min-h-0 flex-1 flex-col p-3">
        <h2 className="mb-2 flex items-center justify-between text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Tables
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={props.onReload}
            disabled={!props.connected}
            aria-label="Reload tables"
          >
            <RefreshCw />
          </Button>
        </h2>
        <Input
          className="h-7 font-mono text-[11.5px]"
          value={props.tableFilter}
          onChange={(e) => props.setTableFilter(e.target.value)}
          placeholder="filter"
          aria-label="Filter tables"
        />
        <ul className="mt-1.5 min-h-0 flex-1 list-none overflow-y-auto p-0">
          {props.tables.map((t) => (
            <li
              key={t.id}
              className={cn(
                "flex cursor-pointer items-baseline gap-1.5 border-l-2 border-transparent px-2.5 py-1 font-mono text-[12px] whitespace-nowrap hover:bg-accent",
                t.id === props.activeTableId && "border-l-amber bg-accent text-amber",
              )}
              onClick={() => props.onOpenTable(t)}
              title={`${t.schema}.${t.name}`}
            >
              <span className="text-[10.5px] text-faint">{t.schema}</span>
              <span className="overflow-hidden text-ellipsis">{t.name}</span>
            </li>
          ))}
          {props.tables.length === 0 && (
            <li className="px-2.5 py-1.5 text-[11.5px] text-faint">
              {props.connected ? "No tables." : "Connect to browse."}
            </li>
          )}
        </ul>
      </section>

      {props.saved.length > 0 && (
        <section className="flex max-h-[220px] min-h-0 flex-col border-t border-border p-3">
          <h2 className="mb-2 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            Saved queries
          </h2>
          <ul className="min-h-0 list-none overflow-y-auto p-0">
            {props.saved.map((q) => (
              <li
                key={q.id}
                className="group flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 hover:bg-accent"
                onClick={() => props.onOpenSaved(q)}
                title={q.sql}
              >
                <Save className="size-3 flex-none text-faint" />
                <span className="flex-1 overflow-hidden text-[12px] text-ellipsis whitespace-nowrap">
                  {q.name}
                </span>
                <button
                  className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-amber"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onRemoveSaved(q.id);
                  }}
                  aria-label={`Delete ${q.name}`}
                >
                  <Trash2 className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function Editor(props: {
  sql: string;
  setSql: (v: string) => void;
  onRun: () => void;
  busy: boolean;
  disabled: boolean;
  saveName: string | null;
  setSaveName: (v: string | null) => void;
  onStartSave: () => void;
  onCommitSave: () => void;
  isSaved: boolean;
}) {
  // Cmd/Ctrl+Enter runs, matching every other SQL console.
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      props.onRun();
    }
  }

  return (
    <section className="flex flex-none flex-col gap-2 border-b border-border p-3">
      <div className="flex items-stretch gap-2.5">
        <textarea
          className="h-[78px] flex-1 resize-y rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[12.5px] leading-relaxed text-foreground outline-none placeholder:text-faint focus:border-ring"
          value={props.sql}
          onChange={(e) => props.setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="SELECT * FROM ..."
          aria-label="SQL editor"
        />
        <div className="flex flex-col items-center gap-1.5">
          <Button onClick={props.onRun} disabled={props.busy || props.disabled}>
            {props.busy ? "running" : "Run"}
          </Button>
          <kbd className="font-mono text-[10px] text-faint">⌘↵</kbd>
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onStartSave}
            disabled={props.sql.trim().length === 0}
            title={props.isSaved ? "Update saved query" : "Save query"}
          >
            <Save />
            {props.isSaved ? "Update" : "Save"}
          </Button>
        </div>
      </div>

      {props.saveName !== null && (
        <div className="flex items-center gap-2">
          <Input
            className="h-7 w-[240px] font-mono text-[11.5px]"
            value={props.saveName}
            onChange={(e) => props.setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onCommitSave();
              if (e.key === "Escape") props.setSaveName(null);
            }}
            placeholder="query name"
            aria-label="Saved query name"
            autoFocus
          />
          <Button size="sm" onClick={props.onCommitSave}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => props.setSaveName(null)}>
            Cancel
          </Button>
        </div>
      )}
    </section>
  );
}
