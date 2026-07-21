import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Save, Trash2, X } from "lucide-react";
import Connections from "@/components/Connections";
import DataGrid from "@/components/DataGrid";
import QueryBuilder from "@/components/QueryBuilder";
import SqlEditor from "@/components/SqlEditor";
import TabStrip from "@/components/TabStrip";
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
import { bridgeAvailable, exec } from "@/lib/bridge";
import { setCompletionSchema } from "@/lib/monaco";
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
import { hydrateTab, loadSession, saveSession, storeTab } from "@/lib/session";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  TABLES_SQL,
  commitSql,
  dataSql,
  emptyQuery,
  isPageable,
  pkSql,
  plainSql,
  rowPredicate,
  wrapPaged,
  type Sort,
  type TableQuery,
} from "@/lib/sql";
import { freshTab, tabById, withTab, type QueryTab } from "@/lib/tabs";

/// Editor pane sizing. The default is deliberately roomy — this is where you
/// write, and four lines was cramped for anything with a join in it.
const DEFAULT_EDITOR_HEIGHT = 180;
const MIN_EDITOR_HEIGHT = 56;
const MIN_GRID_HEIGHT = 140;

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
  const [saveName, setSaveName] = useState<string | null>(null);
  // Lives here, not in Editor: moving to a table tab unmounts the editor, and
  // coming back should not throw away the size you chose.
  const [editorHeight, setEditorHeight] = useState(DEFAULT_EDITOR_HEIGHT);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /// Session restore bookkeeping. `booted` gates saving so the empty first
  /// render cannot overwrite the session we are about to load.
  const [booted, setBooted] = useState(false);
  const connectionSeenRef = useRef(false);

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

        const known = rows.some((c) => c.id === activeConn);
        if (known) setActiveId(activeConn);

        // Restore the workspace only for the connection it was built against.
        // The tabs name tables in one specific database; against another they
        // would be a list of things that may not exist.
        const session = loadSession();
        if (known && session && session.connectionId === activeConn) {
          setTabs(session.tabs.map(hydrateTab));
          setActiveTabId(session.activeTabId);
          setNextTabId(session.nextTabId);
          setEditorHeight(session.editorHeight);
          setScreen(session.screen);
        }
      } catch (storeError) {
        if (!cancelled) {
          setError(storeError instanceof Error ? storeError.message : String(storeError));
        }
      } finally {
        // Until boot has had its say, the state on screen is the empty
        // default — saving it would overwrite the session we came to load.
        if (!cancelled) setBooted(true);
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
    // The first connection of a session is not a switch — it is either the one
    // restored from the session or the one just picked on the home screen, and
    // in both cases the tabs already describe it. Resetting here would throw
    // away the very workspace boot just restored.
    if (connectionSeenRef.current) {
      setTabs((prev) =>
        // Page size is a view preference like the statement text, not data that
        // belonged to the old database — both survive the switch.
        prev.map((t) => ({
          ...freshTab(t.id, t.name),
          sql: t.sql,
          savedId: t.savedId,
          pageSize: t.pageSize,
        })),
      );
    }
    connectionSeenRef.current = true;
    void loadTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Autocomplete reads the schema we already loaded for the rail, plus the
  // columns of whatever the active tab last returned.
  useEffect(() => {
    setCompletionSchema(tables, tab.page.cols);
  }, [tables, tab.page.cols]);

  // Persist the workspace. The timer debounces: `tabs` changes on every
  // keystroke in the editor, and localStorage writes are synchronous.
  useEffect(() => {
    if (!booted) return;
    const timer = setTimeout(() => {
      saveSession({
        version: 1,
        connectionId: activeId,
        screen,
        tabs: tabs.map(storeTab),
        activeTabId,
        nextTabId,
        editorHeight,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [booted, activeId, screen, tabs, activeTabId, nextTabId, editorHeight]);

  // A restored tab carries a query but no rows — results are not persisted.
  // Run it the first time you actually look at it, which covers the active tab
  // at startup and the others as you reach them, without firing every tab's
  // query at once. A source with no columns only ever means "restored, not yet
  // run": switching connections clears the source outright.
  useEffect(() => {
    if (!active || tab.source.kind === "none" || tab.page.cols.length > 0) return;
    void goToPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, activeTabId, tab.source.kind]);

  async function openTable(table: TableRef) {
    // Already open? Go to it. Clicking a table twice should not produce two
    // of it, and the one you have may be carrying filters and staged edits.
    const open = tabs.find(
      (t) => t.source.kind === "table" && t.source.table.id === table.id,
    );
    if (open) {
      setActiveTabId(open.id);
      setSaveName(null);
      return;
    }

    const pkResult = await run(pkSql(table.schema, table.name));
    // No primary key is fine — orderSql falls back to ctid.
    const pkCols = pkResult === null ? [] : parsePkCols(pkResult.out);
    // Taking over the tab in front of you inherits its page size; a brand new
    // tab starts at the default. Deciding this before the query is what keeps
    // the tab's pageSize and the rows it is holding from disagreeing.
    const pristine =
      tab.source.kind === "none" && tab.sql.trim().length === 0 && tab.savedId === 0;
    const size = pristine ? tab.pageSize : DEFAULT_PAGE_SIZE;

    const query = emptyQuery();
    const statement = dataSql(table.schema, table.name, query, pkCols, 0, size);
    const result = await run(statement);
    if (result === null) return;

    // The opening page is unprojected, so its columns are the table's whole
    // set — the one chance to capture it before the builder starts hiding.
    const page = parsePage(result.out, true, size);

    const loaded = {
      name: table.name,
      sql: statement,
      source: { kind: "table" as const, table, pkCols, columns: page.cols, query },
      page,
      pageIndex: 0,
      pageSize: size,
      staged: [],
      status: `${table.schema}.${table.name}`,
      elapsed: result.ms,
    };

    // Take over the tab in front of you only when it is untouched. A table is
    // its own document now — opening one must not eat a query you were
    // writing, or the filters on the table already there.
    if (pristine) {
      patchTab(loaded);
      return;
    }

    const created: QueryTab = { ...freshTab(nextTabId), ...loaded };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
    setNextTabId((n) => n + 1);
    setSaveName(null);
  }

  /// Re-run the current table at page 0 under a new query. Every part of the
  /// query changes which rows land on which page, so the old page index is
  /// meaningless.
  ///
  /// `keepStaged` is for re-ordering. A staged edit carries the WHERE that
  /// addressed its row, resolved when it was staged, so it commits correctly
  /// no matter where the row sits afterwards — and a sort is one click, far
  /// too casual a gesture to throw away pending edits. Changing predicates or
  /// columns still clears them: a filter can drop the row from the result
  /// entirely, and hiding a column invalidates the staged column index.
  async function applyQuery(next: TableQuery, keepStaged = false) {
    if (tab.source.kind !== "table") return;
    const { table, pkCols, columns } = tab.source;
    const statement = dataSql(
      table.schema,
      table.name,
      next,
      pkCols,
      0,
      tab.pageSize,
      columns,
    );
    const result = await run(statement);
    if (result === null) return;
    patchTab({
      sql: statement,
      source: { kind: "table", table, pkCols, columns, query: next },
      page: parsePage(result.out, true, tab.pageSize),
      pageIndex: 0,
      staged: keepStaged ? tab.staged : [],
      elapsed: result.ms,
    });
  }

  /// Header click cycles that column asc → desc → unsorted. A plain click
  /// sorts by it alone; shift-click folds it into the existing sort so a
  /// second key can be added without a separate control.
  function toggleSort(column: string, additive: boolean) {
    if (tab.source.kind !== "table") return;
    const current = tab.source.query.sort;
    const existing = current.find((entry) => entry.column === column);

    let next: Sort[];
    if (!existing) {
      next = additive ? [...current, { column, dir: "asc" }] : [{ column, dir: "asc" }];
    } else if (existing.dir === "asc") {
      const flipped: Sort = { column, dir: "desc" };
      next = additive
        ? current.map((entry) => (entry.column === column ? flipped : entry))
        : [flipped];
    } else {
      next = additive ? current.filter((entry) => entry.column !== column) : [];
    }

    void applyQuery({ ...tab.source.query, sort: next }, true);
  }

  async function runEditor() {
    const statement = tab.sql.trim();
    if (statement.length === 0) return;
    const pageable = isPageable(statement);
    const result = await run(pageable ? wrapPaged(statement, 0, tab.pageSize) : statement);
    if (result === null) return;
    patchTab({
      source: pageable ? { kind: "sql", sql: statement } : { kind: "none" },
      page: parsePage(result.out, false, tab.pageSize),
      pageIndex: 0,
      staged: [],
      status: pageable ? "query" : "query (single run)",
      elapsed: result.ms,
    });
  }

  /// Move to a page, optionally resizing it. Changing the size goes through
  /// here rather than a path of its own: the offset is a function of the size,
  /// so the two have to be decided together or the page lands in the wrong
  /// place. A resize always lands on page 0 for the same reason.
  async function goToPage(next: number, size = tab.pageSize) {
    if (next < 0) return;
    const source = tab.source;
    if (source.kind === "none") {
      patchTab({ pageSize: size });
      return;
    }
    const offset = next * size;
    const statement =
      source.kind === "table"
        ? dataSql(
            source.table.schema,
            source.table.name,
            source.query,
            source.pkCols,
            offset,
            size,
            source.columns,
          )
        : wrapPaged(source.sql, offset, size);
    const result = await run(statement);
    if (result === null) return;
    patchTab({
      page: parsePage(result.out, source.kind === "table", size),
      pageIndex: next,
      pageSize: size,
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
      tab.source.query,
      tab.source.pkCols,
      tab.pageIndex * tab.pageSize,
      tab.pageSize,
      tab.source.columns,
    );
    const result = await run(statement);
    // A failed commit leaves the batch intact so nothing is silently lost;
    // the transaction rolled back, so the database is untouched.
    if (result === null) return;
    const count = tab.staged.length;
    patchTab({
      staged: [],
      page: parsePage(result.out, true, tab.pageSize),
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

  /// Hand the builder's statement to a fresh query tab. The builder stops
  /// short of joins and aggregates by design; this is the way past it, and
  /// the table tab it came from is left untouched.
  function editAsSql(query: TableQuery) {
    if (tab.source.kind !== "table") return;
    const { table, pkCols, columns } = tab.source;
    const created: QueryTab = {
      ...freshTab(nextTabId, table.name),
      sql: plainSql(table.schema, table.name, query, pkCols, columns),
    };
    setTabs((prev) => [...prev, created]);
    setActiveTabId(created.id);
    setNextTabId((n) => n + 1);
    setSaveName(null);
  }

  const stagedRowCount = new Set(tab.staged.map((e) => e.key)).size;
  const firstRow = tab.pageIndex * tab.pageSize + (tab.page.rows.length > 0 ? 1 : 0);
  const lastRow = tab.pageIndex * tab.pageSize + tab.page.rows.length;

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
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
        />

        {/* What a tab is decides what it shows: a table you opened is browsed
            through its filters, a query tab is written as SQL. There is no
            mode to switch — the two never applied to the same document. */}
        {tab.source.kind !== "table" ? (
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
            height={editorHeight}
            setHeight={setEditorHeight}
          />
        ) : (
          <QueryBuilder
            // Per tab: the half-built predicate you left on one table should
            // not reappear on the next one.
            key={tab.id}
            columns={tab.source.columns}
            query={tab.source.query}
            busy={busy}
            onApply={(next) => void applyQuery(next)}
            onEditAsSql={editAsSql}
            buildSql={(q) =>
              tab.source.kind === "table"
                ? plainSql(
                    tab.source.table.schema,
                    tab.source.table.name,
                    q,
                    tab.source.pkCols,
                    tab.source.columns,
                  )
                : ""
            }
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
          sort={tab.source.kind === "table" ? tab.source.query.sort : []}
          onSort={tab.source.kind === "table" ? toggleSort : undefined}
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
            <span className="flex items-center gap-0.5">
              <Select
                value={String(tab.pageSize)}
                onValueChange={(next) => next && void goToPage(0, Number(next))}
                disabled={busy}
              >
                <SelectTrigger
                  size="sm"
                  className="h-5 w-[78px] border-none font-mono text-[11px] text-faint"
                  aria-label="Rows per page"
                >
                  <SelectValue>{(value) => `${value} rows`}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem
                      key={size}
                      value={String(size)}
                      className="font-mono text-[11.5px]"
                    >
                      {size} rows
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
  height: number;
  setHeight: (v: number) => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Same shape as the grid's column resize: the drag lives on window so the
  // pointer can leave the 7px handle without dropping it.
  const setHeightRef = useRef(props.setHeight);
  setHeightRef.current = props.setHeight;

  useEffect(() => {
    function onMove(event: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      // The grid needs to keep a usable amount of room no matter how far the
      // drag goes, so the ceiling comes from the pane we live in.
      const pane = sectionRef.current?.parentElement;
      const ceiling = pane
        ? pane.clientHeight - MIN_GRID_HEIGHT
        : Number.POSITIVE_INFINITY;
      const wanted = drag.startHeight + (event.clientY - drag.startY);
      setHeightRef.current(
        Math.max(MIN_EDITOR_HEIGHT, Math.min(ceiling, wanted)),
      );
    }
    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.classList.remove("resizing-row");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function startResize(event: React.MouseEvent) {
    event.preventDefault();
    dragRef.current = { startY: event.clientY, startHeight: props.height };
    document.body.classList.add("resizing-row");
  }

  return (
    <section
      ref={sectionRef}
      className="relative flex flex-none flex-col gap-2 border-b border-border p-3"
    >
      <div className="flex items-stretch gap-2.5">
        <SqlEditor
          className="flex-1"
          style={{ height: props.height }}
          value={props.sql}
          onChange={props.setSql}
          onRun={props.onRun}
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

      <div
        className="row-resize"
        onMouseDown={startResize}
        onDoubleClick={() => props.setHeight(DEFAULT_EDITOR_HEIGHT)}
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="horizontal"
      />
    </section>
  );
}
