// Artemis - a Postgres database GUI.
//
// The app core: Model, Msg, update, and the pure helpers they call -
// plain TypeScript in the app-core subset, compiled to native Zig at
// build time (no JS runtime ships in the binary). The view lives in
// app.native and binds this model by its own field names exactly as
// written here (`section` binds as `{section}`).
//
// The loop: edit here -> `native dev --core` for instant logic checks
// under node -> `native dev` to run the real app. `native check`
// verifies this file and the markup together.

import { Cmd, asciiBytes } from "@native-sdk/core";
import {
  type TextEditState,
  type TextInputEvent,
  containsIgnoreCase,
} from "@native-sdk/core/text";
import {
  MAX_RESULT_ROWS,
  MAX_TABS,
  NAME_CAPACITY,
  PAGE_SIZE,
  SQL_CAPACITY,
  URL_CAPACITY,
  type BrowserRow,
  type ColumnRef,
  type ConnectionRow,
  type CellRec,
  type DisplayCell,
  type RowKey,
  type FilterOp,
  type FilterOpRow,
  type FilterRow,
  type QueryTab,
  type SavedQuery,
  type SidebarIcon,
  type StagedEdit,
  type TableRef,
} from "./types.ts";
import {
  applyDraftEdit,
  bytesConcat,
  identQuoted,
  bytesEqual,
  draftFrom,
  emptyDraft,
  sqlQuoted,
  stripFinalNewline,
  unitSeparator,
  recordSeparator,
} from "./bytes.ts";
import {
  DB_PATH,
  dbDeleteSql,
  dbInitListSql,
  dbInsertSql,
  dbUpdateSql,
  parseConnectionRows,
  parseSavedRows,
  sqDeleteSql,
  sqInitListSql,
  sqInsertSql,
} from "./db.ts";
import {
  TABLES_SQL,
  commitSql,
  dataSql,
  parseColumns,
  rowCells,
  rowKeyOf,
  opLabel,
  opTakesValue,
  parsePkCols,
  parseTableRows,
  stagedHas,
  stagedValueFor,
  wrapPaged,
  pkSql,
} from "./pg.ts";

export type Section = "connection" | "query";

export interface Model {
  readonly section: Section;
  readonly sidebar_open: boolean;
  /// Saved connections, mirrored from the SQLite table.
  readonly connections: readonly ConnectionRow[];
  /// The connection the Query workspace targets (0 = none).
  readonly active_id: number;
  /// The record the form is editing (0 = the form adds a new one).
  readonly editing_id: number;
  readonly name_draft: TextEditState;
  readonly url_draft: TextEditState;
  /// True while a connections-database operation is in flight.
  readonly db_busy: boolean;
  /// User-visible shell/runtime error; empty means no error banner.
  readonly shell_error: Uint8Array;
  /// The connected database's tables (loaded when a connection activates).
  readonly tables: readonly TableRef[];
  readonly tables_busy: boolean;
  /// Saved queries, mirrored from the SQLite table.
  readonly saved_queries: readonly SavedQuery[];
  /// True once the saved-queries table has been initialized at boot.
  readonly sq_booted: boolean;
  /// Save-query dialog state.
  readonly save_query_open: boolean;
  readonly save_name_draft: TextEditState;
  /// Query tabs (session-only; never empty).
  readonly tabs: readonly QueryTab[];
  readonly active_tab_id: number;
  readonly next_tab_id: number;
  /// The tab whose query is in flight (0 = idle; one at a time).
  readonly running_tab_id: number;
  /// The tab awaiting close confirmation (0 = none).
  readonly closing_tab_id: number;
  /// Filter-builder draft (applies to the active tab's table).
  readonly filter_column: Uint8Array;
  readonly filter_op: FilterOp;
  readonly filter_value: TextEditState;
  readonly filter_column_open: boolean;
  readonly filter_op_open: boolean;
  readonly next_filter_id: number;
  /// Inline cell editor position (-1 = closed) and draft.
  readonly edit_row: number;
  readonly edit_col: number;
  readonly cell_draft: TextEditState;
  /// Staged-changes review dialog.
  readonly review_open: boolean;
  /// Transient "committed" confirmation, cleared on the next edit.
  readonly commit_ok: boolean;
  readonly next_staged_id: number;
}

export type Msg =
  | { readonly kind: "select_connection" }
  | { readonly kind: "select_query" }
  | { readonly kind: "toggle_sidebar" }
  | { readonly kind: "name_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "url_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "save_connection" }
  | { readonly kind: "new_connection" }
  | { readonly kind: "edit_connection"; readonly id: number }
  | { readonly kind: "delete_connection"; readonly id: number }
  | { readonly kind: "activate_connection"; readonly id: number }
  | { readonly kind: "clear_error" }
  | { readonly kind: "env_database_url"; readonly value: Uint8Array }
  | { readonly kind: "dir_ready" }
  | { readonly kind: "dir_failed"; readonly reason: Uint8Array }
  | { readonly kind: "db_loaded"; readonly code: number; readonly out: Uint8Array }
  | { readonly kind: "db_failed"; readonly reason: Uint8Array }
  | { readonly kind: "reload_tables" }
  | { readonly kind: "select_table"; readonly id: number }
  | { readonly kind: "tables_loaded"; readonly code: number; readonly out: Uint8Array }
  | { readonly kind: "pg_failed"; readonly reason: Uint8Array }
  | { readonly kind: "new_tab" }
  | { readonly kind: "select_tab"; readonly id: number }
  | { readonly kind: "close_tab"; readonly id: number }
  | { readonly kind: "confirm_close_tab" }
  | { readonly kind: "cancel_close_tab" }
  | { readonly kind: "editor_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "run_query" }
  | { readonly kind: "stop_query" }
  | { readonly kind: "next_page" }
  | { readonly kind: "prev_page" }
  | { readonly kind: "query_loaded"; readonly code: number; readonly out: Uint8Array }
  | { readonly kind: "query_failed"; readonly reason: Uint8Array }
  | { readonly kind: "sq_loaded"; readonly code: number; readonly out: Uint8Array }
  | { readonly kind: "open_save_query" }
  | { readonly kind: "cancel_save_query" }
  | { readonly kind: "confirm_save_query" }
  | { readonly kind: "save_name_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "load_saved"; readonly id: number }
  | { readonly kind: "delete_saved"; readonly id: number }
  | { readonly kind: "begin_edit"; readonly code: number }
  | { readonly kind: "cell_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "stage_edit" }
  | { readonly kind: "cancel_edit" }
  | { readonly kind: "unstage"; readonly id: number }
  | { readonly kind: "discard_staged" }
  | { readonly kind: "open_review" }
  | { readonly kind: "close_review" }
  | { readonly kind: "commit_staged" }
  | { readonly kind: "commit_loaded"; readonly code: number; readonly out: Uint8Array }
  | { readonly kind: "pk_loaded"; readonly code: number; readonly out: Uint8Array }
  | { readonly kind: "toggle_filter_column" }
  | { readonly kind: "dismiss_filter_column" }
  | { readonly kind: "pick_filter_column"; readonly name: Uint8Array }
  | { readonly kind: "toggle_filter_op" }
  | { readonly kind: "dismiss_filter_op" }
  | { readonly kind: "pick_filter_op"; readonly op: FilterOp }
  | { readonly kind: "filter_value_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "add_filter" }
  | { readonly kind: "remove_filter"; readonly id: number }
  | { readonly kind: "clear_filters" }
;

/// DATABASE_URL present at launch prefills the connection-string draft -
/// the host dispatches it as an ordinary Msg right after boot.
export const envMsgs = [{ env: "DATABASE_URL", msg: "env_database_url" }] as const;

/// Host-dispatched arms and update-only state - never bound in markup;
/// this list keeps `native check`'s unbound-state lint honest about that.
export const viewUnbound = [
  "name_draft",
  "url_draft",
  "editing_id",
  "tables",
  "next_tab_id",
  "running_tab_id",
  "closing_tab_id",
  "filter_column",
  "filter_op",
  "filter_value",
  "next_filter_id",
  "sq_booted",
  "save_name_draft",
  "sq_loaded",
  "cell_draft",
  "next_staged_id",
  "commit_loaded",
  "pk_loaded",
  "env_database_url",
  "dir_ready",
  "dir_failed",
  "db_loaded",
  "db_failed",
  "tables_loaded",
  "query_loaded",
  "query_failed",
  "pg_failed",
] as const;

// ==================================================================
// Data access - the one place SQLite lives.
//
// Connections persist in a local SQLite database (.artemis/artemis.db)
// driven through the system `sqlite3` CLI via Cmd.spawn. Every statement
// batch ends with LIST_SQL, so each operation's exit delivers the fresh
// row set and `db_loaded` is the single reload path. Output rows are
// framed with the ASCII unit/record separators so values containing
// newlines or pipes cannot corrupt parsing.
// ==================================================================

// ==================================================================
// Postgres access - the one place psql lives.
//
// The connected database is read through the PostgreSQL client CLI
// (`psql <url> -X -q -A -F <US> -R <RS> -P footer=off -v ON_ERROR_STOP=1
// -c <sql>`) via Cmd.spawn, with the same unit/record-separator framing
// the SQLite layer uses. The first output record is always the header
// row; parsers consume or skip it accordingly.
// ==================================================================

/// The active connection's URL ("" when none is active).
function activeUrl(model: Model): Uint8Array {
  for (let i = 0; i < model.connections.length; i++) {
    if (model.connections[i].id === model.active_id) return model.connections[i].url;
  }
  return new Uint8Array(0);
}

function tableById(model: Model, id: number): TableRef {
  for (let i = 0; i < model.tables.length; i++) {
    if (model.tables[i].id === id) return model.tables[i];
  }
  return { id: 0, schema: new Uint8Array(0), name: new Uint8Array(0) };
}

// ==================================================================
// Model helpers
// ==================================================================

function freshTab(id: number): QueryTab {
  return {
    id: id,
    title: asciiBytes(`Query ${id}`),
    icon: asciiBytes("terminal"),
    editor: emptyDraft(),
    dirty: false,
    running: false,
    table_id: 0,
    filters: [],
    base_sql: new Uint8Array(0),
    page: 0,
    cols: [],
    cells: [],
    row_keys: [],
    row_count: 0,
    has_next: false,
    staged: [],
    pk_cols: new Uint8Array(0),
  };
}

function tabById(model: Model, id: number): QueryTab {
  for (let i = 0; i < model.tabs.length; i++) {
    if (model.tabs[i].id === id) return model.tabs[i];
  }
  return freshTab(0);
}

/// A tab list with `updated` replacing the tab sharing its id.
function tabsWith(tabs: readonly QueryTab[], updated: QueryTab): readonly QueryTab[] {
  const out: QueryTab[] = [];
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].id === updated.id) {
      out.push(updated);
    } else {
      out.push(tabs[i]);
    }
  }
  return out;
}


/// One page of psql output as the model's flat result shape: columns,
/// row keys, and row-major cells. `keyed` results (table views) carry
/// each row's ctid in field 0.
function parsePage(out: Uint8Array, keyed: boolean, cap: number): PageResult {
  const lines = stripFinalNewline(out).split(recordSeparator());
  if (lines.length === 0 || lines[0].length === 0) {
    return { cols: [], cells: [], keys: [], rows: 0, has_next: false };
  }
  const cols = parseColumns(lines[0], keyed);
  const cells: CellRec[] = [];
  const keys: RowKey[] = [];
  let rows = 0;
  let hasNext = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    if (rows >= cap) {
      hasNext = true;
      break;
    }
    const row_cells = rowCells(lines[i], keyed, rows, cols.length);
    for (let j = 0; j < row_cells.length; j++) cells.push(row_cells[j]);
    keys.push(rowKeyOf(lines[i], keyed));
    rows += 1;
  }
  return { cols: cols, cells: cells, keys: keys, rows: rows, has_next: hasNext };
}

interface PageResult {
  readonly cols: readonly ColumnRef[];
  readonly cells: readonly CellRec[];
  readonly keys: readonly RowKey[];
  readonly rows: number;
  readonly has_next: boolean;
}

export function initialModel(): Model | [Model, Cmd<Msg>] {
  const model: Model = {
    section: "connection",
    sidebar_open: true,
    connections: [],
    active_id: 0,
    editing_id: 0,
    name_draft: emptyDraft(),
    url_draft: emptyDraft(),
    db_busy: true,
    shell_error: new Uint8Array(0),
    tables: [],
    tables_busy: false,
    saved_queries: [],
    sq_booted: false,
    save_query_open: false,
    save_name_draft: emptyDraft(),
    tabs: [freshTab(1)],
    active_tab_id: 1,
    next_tab_id: 2,
    running_tab_id: 0,
    closing_tab_id: 0,
    filter_column: new Uint8Array(0),
    filter_op: "eq",
    filter_value: emptyDraft(),
    filter_column_open: false,
    filter_op_open: false,
    next_filter_id: 1,
    edit_row: -1,
    edit_col: 0,
    cell_draft: emptyDraft(),
    review_open: false,
    commit_ok: false,
    next_staged_id: 1,
  };
  // Boot: ensure the data directory exists (writeFile creates parents),
  // then dir_ready initializes SQLite and loads the saved connections.
  return [
    model,
    Cmd.writeFile(asciiBytes(".artemis/.keep"), new Uint8Array(0), {
      key: "data_dir",
      ok: "dir_ready",
      err: "dir_failed",
    }),
  ];
}

// ------------------------------------------------- derived view bindings

export function chevronIcon(model: Model): SidebarIcon {
  return model.sidebar_open ? "chevron-left" : "chevron-right";
}

export function nameDraft(model: Model): Uint8Array {
  return model.name_draft.text;
}

export function urlDraft(model: Model): Uint8Array {
  return model.url_draft.text;
}

export function isEditing(model: Model): boolean {
  return model.editing_id > 0;
}

export function connectionCount(model: Model): number {
  return model.connections.length;
}

export function hasActive(model: Model): boolean {
  return model.active_id > 0;
}

export function activeName(model: Model): Uint8Array {
  for (let i = 0; i < model.connections.length; i++) {
    if (model.connections[i].id === model.active_id) return model.connections[i].name;
  }
  return new Uint8Array(0);
}

export function saveName(model: Model): Uint8Array {
  return model.save_name_draft.text;
}

export function hasError(model: Model): boolean {
  return model.shell_error.length > 0;
}

/// The database browser's sidebar lines: schema headers + their tables.
export function browserRows(model: Model): readonly BrowserRow[] {
  const rows: BrowserRow[] = [];
  for (let i = 0; i < model.tables.length; i++) {
    const table = model.tables[i];
    if (i === 0 || !bytesEqual(model.tables[i - 1].schema, table.schema)) {
      rows.push({ key: 1000000 + i, id: 0, header: true, label: table.schema.toUpperCase() });
    }
    rows.push({ key: table.id, id: table.id, header: false, label: table.name });
  }
  return rows;
}

// Active-tab projections: the markup always renders the active tab.

export function activeEditor(model: Model): Uint8Array {
  return tabById(model, model.active_tab_id).editor.text;
}

export function activeRunning(model: Model): boolean {
  return tabById(model, model.active_tab_id).running;
}

export function anyRunning(model: Model): boolean {
  return model.running_tab_id > 0;
}

/// The active tab's cells with staged edits overlaid, in row-major
/// order — one flat list the grid lays out `activeColCount` per row.
export function activeCells(model: Model): readonly DisplayCell[] {
  const tab = tabById(model, model.active_tab_id);
  const out: DisplayCell[] = [];
  for (let i = 0; i < tab.cells.length; i++) {
    const cell = tab.cells[i];
    let key: Uint8Array = new Uint8Array(0);
    for (let r = 0; r < tab.row_keys.length; r++) {
      if (r === cell.row) key = tab.row_keys[r].key;
    }
    out.push({
      code: i,
      text: stagedValueFor(tab.staged, key, cell.col, cell.text),
      dirty: stagedHas(tab.staged, key, cell.col),
    });
  }
  return out;
}

export function stagedCount(model: Model): number {
  return tabById(model, model.active_tab_id).staged.length;
}

export function hasStaged(model: Model): boolean {
  return stagedCount(model) > 0;
}

export function activeStaged(model: Model): readonly StagedEdit[] {
  return tabById(model, model.active_tab_id).staged;
}

export function cellDraft(model: Model): Uint8Array {
  return model.cell_draft.text;
}

export function editingCell(model: Model): boolean {
  return model.edit_row >= 0;
}

export function editingColumn(model: Model): Uint8Array {
  const tab = tabById(model, model.active_tab_id);
  for (let i = 0; i < tab.cols.length; i++) {
    if (i === model.edit_col) return tab.cols[i].name;
  }
  return new Uint8Array(0);
}

export function activeColCount(model: Model): number {
  return tabById(model, model.active_tab_id).cols.length;
}

export function activeTableId(model: Model): number {
  return tabById(model, model.active_tab_id).table_id;
}

export function browsingTable(model: Model): boolean {
  return activeTableId(model) > 0;
}

export function pageStart(model: Model): number {
  const tab = tabById(model, model.active_tab_id);
  if (tab.row_count === 0) return 0;
  return tab.page * PAGE_SIZE + 1;
}

export function pageEnd(model: Model): number {
  const tab = tabById(model, model.active_tab_id);
  return tab.page * PAGE_SIZE + tab.row_count;
}

export function canPrev(model: Model): boolean {
  const tab = tabById(model, model.active_tab_id);
  return tab.page > 0 && !tab.running && model.running_tab_id === 0;
}

export function canNext(model: Model): boolean {
  const tab = tabById(model, model.active_tab_id);
  return tab.has_next && !tab.running && model.running_tab_id === 0;
}

export function canRun(model: Model): boolean {
  return model.running_tab_id === 0 && model.active_id > 0;
}

export function canAddTab(model: Model): boolean {
  return model.tabs.length < MAX_TABS;
}

export function closingTab(model: Model): boolean {
  return model.closing_tab_id > 0;
}

export function gridEmpty(model: Model): boolean {
  const tab = tabById(model, model.active_tab_id);
  return tab.cols.length > 0 && !tab.running && tab.row_count === 0;
}

/// Whether the active tab's result is paginated (table browse, or a
/// free-form SELECT the runner wrapped with LIMIT/OFFSET).
export function paged(model: Model): boolean {
  const tab = tabById(model, model.active_tab_id);
  return tab.table_id > 0 || tab.base_sql.length > 0;
}

// Filter-builder projections.

export function activeFilters(model: Model): readonly FilterRow[] {
  return tabById(model, model.active_tab_id).filters;
}

export function hasFilters(model: Model): boolean {
  return activeFilters(model).length > 0;
}

export function activeColumns(model: Model): readonly ColumnRef[] {
  return tabById(model, model.active_tab_id).cols;
}

export function filterColumn(model: Model): Uint8Array {
  return model.filter_column;
}

export function filterOpText(model: Model): Uint8Array {
  return opLabel(model.filter_op);
}

export function filterValue(model: Model): Uint8Array {
  return model.filter_value.text;
}

export function filterOps(model: Model): readonly FilterOpRow[] {
  const out: FilterOpRow[] = [];
  out.push({ op: "eq", label: opLabel("eq") });
  out.push({ op: "ne", label: opLabel("ne") });
  out.push({ op: "gt", label: opLabel("gt") });
  out.push({ op: "lt", label: opLabel("lt") });
  out.push({ op: "gte", label: opLabel("gte") });
  out.push({ op: "lte", label: opLabel("lte") });
  out.push({ op: "contains", label: opLabel("contains") });
  out.push({ op: "is_null", label: opLabel("is_null") });
  out.push({ op: "not_null", label: opLabel("not_null") });
  return out;
}

export function hasResult(model: Model): boolean {
  return tabById(model, model.active_tab_id).cols.length > 0;
}

// --------------------------------------------------------------- update

/// Remove a tab: activate a neighbor, never leave zero tabs, and drop
/// the in-flight marker if the closed tab owned it (the result for a
/// closed tab is discarded on arrival).
function withTabRemoved(model: Model, id: number): Model {
  const kept: QueryTab[] = [];
  for (let i = 0; i < model.tabs.length; i++) {
    if (model.tabs[i].id !== id) kept.push(model.tabs[i]);
  }
  let next_id = model.next_tab_id;
  if (kept.length === 0) {
    kept.push(freshTab(next_id));
    next_id += 1;
  }
  let active = model.active_tab_id;
  if (active === id) active = kept[kept.length - 1].id;
  let running = model.running_tab_id;
  if (running === id) running = 0;
  return {
    ...model,
    tabs: kept,
    active_tab_id: active,
    next_tab_id: next_id,
    running_tab_id: running,
    closing_tab_id: 0,
  };
}

/// Open the inline cell editor on the active table view's cell at flat
/// index `code`, seeding the draft with the value currently shown.
function beginEditAt(model: Model, code: number): Model {
  const tab = tabById(model, model.active_tab_id);
  if (tab.id === 0 || tab.table_id === 0 || tab.running || model.running_tab_id !== 0) return model;
  for (let i = 0; i < tab.cells.length; i++) {
    if (i !== code) continue;
    const cell = tab.cells[i];
    let key: Uint8Array = new Uint8Array(0);
    for (let r = 0; r < tab.row_keys.length; r++) {
      if (r === cell.row) key = tab.row_keys[r].key;
    }
    return {
      ...model,
      edit_row: cell.row,
      edit_col: cell.col,
      cell_draft: draftFrom(stagedValueFor(tab.staged, key, cell.col, cell.text)),
      commit_ok: false,
    };
  }
  return model;
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "select_connection":
      return { ...model, section: "connection" };
    case "select_query":
      return { ...model, section: "query" };
    case "toggle_sidebar":
      return { ...model, sidebar_open: !model.sidebar_open };
    case "name_edit":
      return { ...model, name_draft: applyDraftEdit(model.name_draft, msg.edit, NAME_CAPACITY) };
    case "url_edit":
      return { ...model, url_draft: applyDraftEdit(model.url_draft, msg.edit, URL_CAPACITY) };
    case "save_connection": {
      const name = model.name_draft.text.trim();
      const url = model.url_draft.text.trim();
      if (name.length === 0 || url.length === 0) {
        return {
          ...model,
          shell_error: asciiBytes("A connection needs both a name and a postgres:// URL."),
        };
      }
      let sql = dbInsertSql(name, url);
      if (model.editing_id > 0) sql = dbUpdateSql(model.editing_id, name, url);
      return [
        {
          ...model,
          db_busy: true,
          editing_id: 0,
          name_draft: emptyDraft(),
          url_draft: emptyDraft(),
          shell_error: new Uint8Array(0),
        },
        Cmd.spawn(
          [asciiBytes("sqlite3"), asciiBytes("-batch"), asciiBytes("-separator"), unitSeparator(), asciiBytes("-newline"), recordSeparator(), DB_PATH, sql],
          { collect: true, exit: "db_loaded", err: "db_failed" },
        ),
      ];
    }
    case "new_connection":
      return { ...model, editing_id: 0, name_draft: emptyDraft(), url_draft: emptyDraft() };
    case "edit_connection": {
      for (let i = 0; i < model.connections.length; i++) {
        const row = model.connections[i];
        if (row.id === msg.id) {
          return {
            ...model,
            editing_id: msg.id,
            name_draft: draftFrom(row.name),
            url_draft: draftFrom(row.url),
          };
        }
      }
      return model;
    }
    case "delete_connection": {
      let active = model.active_id;
      let tables = model.tables;
      if (active === msg.id) {
        active = 0;
        tables = [];
      }
      let editing = model.editing_id;
      let name = model.name_draft;
      let url = model.url_draft;
      if (editing === msg.id) {
        editing = 0;
        name = emptyDraft();
        url = emptyDraft();
      }
      return [
        {
          ...model,
          db_busy: true,
          active_id: active,
          editing_id: editing,
          name_draft: name,
          url_draft: url,
          tables: tables,
        },
        Cmd.spawn(
          [asciiBytes("sqlite3"), asciiBytes("-batch"), asciiBytes("-separator"), unitSeparator(), asciiBytes("-newline"), recordSeparator(), DB_PATH, dbDeleteSql(msg.id)],
          { collect: true, exit: "db_loaded", err: "db_failed" },
        ),
      ];
    }
    case "activate_connection": {
      let url: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < model.connections.length; i++) {
        if (model.connections[i].id === msg.id) url = model.connections[i].url;
      }
      if (url.length === 0) return { ...model, active_id: msg.id };
      // Connecting: jump to the query workspace and load the catalog.
      return [
        { ...model, active_id: msg.id, section: "query", tables: [], tables_busy: true },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), TABLES_SQL],
          { collect: true, exit: "tables_loaded", err: "pg_failed" },
        ),
      ];
    }
    case "clear_error":
      return { ...model, shell_error: new Uint8Array(0) };
    case "env_database_url": {
      // Prefill the form's URL draft only - saved records always win.
      const text = msg.value.trim();
      if (text.length === 0 || model.url_draft.text.length > 0) return model;
      return { ...model, url_draft: draftFrom(text) };
    }
    case "dir_ready":
      return [
        { ...model, db_busy: true },
        Cmd.spawn(
          [asciiBytes("sqlite3"), asciiBytes("-batch"), asciiBytes("-separator"), unitSeparator(), asciiBytes("-newline"), recordSeparator(), DB_PATH, dbInitListSql()],
          { collect: true, exit: "db_loaded", err: "db_failed" },
        ),
      ];
    case "dir_failed":
      return {
        ...model,
        db_busy: false,
        shell_error: asciiBytes("Could not create the .artemis data directory."),
      };
    case "db_loaded": {
      if (msg.code !== 0) {
        return {
          ...model,
          db_busy: false,
          shell_error: asciiBytes("The connections database reported an error (sqlite3 exited nonzero)."),
        };
      }
      const rows = parseConnectionRows(msg.out);
      // An active connection that no longer exists is cleared, not dangled.
      let active = 0;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].id === model.active_id) active = model.active_id;
      }
      const next: Model = { ...model, db_busy: false, connections: rows, active_id: active };
      // First success also initializes and loads the saved-queries table.
      if (!model.sq_booted) {
        return [
          { ...next, sq_booted: true },
          Cmd.spawn(
            [asciiBytes("sqlite3"), asciiBytes("-batch"), asciiBytes("-separator"), unitSeparator(), asciiBytes("-newline"), recordSeparator(), DB_PATH, sqInitListSql()],
            { collect: true, exit: "sq_loaded", err: "db_failed" },
          ),
        ];
      }
      return next;
    }
    case "db_failed":
      return {
        ...model,
        db_busy: false,
        shell_error: asciiBytes("Could not run sqlite3 - the connections database is unavailable."),
      };
    case "reload_tables": {
      const url = activeUrl(model);
      if (url.length === 0) return model;
      return [
        { ...model, tables_busy: true },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), TABLES_SQL],
          { collect: true, exit: "tables_loaded", err: "pg_failed" },
        ),
      ];
    }
    case "tables_loaded": {
      if (msg.code !== 0) {
        return {
          ...model,
          tables_busy: false,
          shell_error: asciiBytes("Could not load tables - check the connection string and that the server is reachable."),
        };
      }
      return { ...model, tables_busy: false, tables: parseTableRows(msg.out) };
    }
    case "pg_failed": {
      // The keyed spawn rejects a second query while one is live.
      if (containsIgnoreCase(msg.reason, asciiBytes("rejected"))) {
        return { ...model, tables_busy: false, shell_error: asciiBytes("A query is already running - stop it or wait for it to finish.") };
      }
      return {
        ...model,
        tables_busy: false,
        shell_error: asciiBytes("Could not run psql - install the PostgreSQL client tools to browse databases."),
      };
    }
    case "new_tab": {
      if (model.tabs.length >= MAX_TABS) return model;
      const tab = freshTab(model.next_tab_id);
      const tabs: QueryTab[] = [];
      for (let i = 0; i < model.tabs.length; i++) tabs.push(model.tabs[i]);
      tabs.push(tab);
      return { ...model, tabs: tabs, active_tab_id: tab.id, next_tab_id: model.next_tab_id + 1 };
    }
    case "select_tab": {
      const tab = tabById(model, msg.id);
      if (tab.id === 0) return model;
      return { ...model, active_tab_id: msg.id, edit_row: -1 };
    }
    case "close_tab": {
      const tab = tabById(model, msg.id);
      if (tab.id === 0) return model;
      // Unsaved query text prompts before closing.
      if (tab.dirty && tab.editor.text.trim().length > 0) {
        return { ...model, closing_tab_id: msg.id };
      }
      if (model.running_tab_id === msg.id) {
        return [withTabRemoved(model, msg.id), Cmd.cancel("query")];
      }
      return withTabRemoved(model, msg.id);
    }
    case "confirm_close_tab": {
      const id = model.closing_tab_id;
      if (id === 0) return model;
      if (model.running_tab_id === id) {
        return [withTabRemoved(model, id), Cmd.cancel("query")];
      }
      return withTabRemoved(model, id);
    }
    case "cancel_close_tab":
      return { ...model, closing_tab_id: 0 };
    case "editor_edit": {
      const tab = tabById(model, model.active_tab_id);
      if (tab.id === 0) return model;
      const editor = applyDraftEdit(tab.editor, msg.edit, SQL_CAPACITY);
      return { ...model, tabs: tabsWith(model.tabs, { ...tab, editor: editor, dirty: true }) };
    }
    case "run_query": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      if (tab.id === 0 || model.running_tab_id !== 0) return model;
      if (url.length === 0) {
        return { ...model, shell_error: asciiBytes("No active connection - choose one in the Connections section.") };
      }
      const sql = tab.editor.text.trim();
      if (sql.length === 0) {
        return { ...model, shell_error: asciiBytes("The editor is empty - write a query first.") };
      }
      // A SELECT without a LIMIT always paginates: keep the unwrapped
      // query and run it wrapped in LIMIT/OFFSET; anything else (an
      // explicit LIMIT, DML, multi-statement) runs exactly as written.
      const lower = sql.toLowerCase();
      const paginate =
        (lower.startsWith(asciiBytes("select")) || lower.startsWith(asciiBytes("with"))) &&
        !containsIgnoreCase(sql, asciiBytes("limit"));
      let base: Uint8Array = new Uint8Array(0);
      let exec = sql;
      if (paginate) {
        base = sql;
        if (base.endsWith(asciiBytes(";"))) base = base.subarray(0, base.length - 1).trim();
        exec = wrapPaged(base, 0);
      }
      // A free-form run leaves table-browse mode.
      return [
        {
          ...model,
          running_tab_id: tab.id,
          shell_error: new Uint8Array(0),
          tabs: tabsWith(model.tabs, {
            ...tab,
            running: true,
            dirty: false,
            table_id: 0,
            filters: [],
            base_sql: base,
            page: 0,
          }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), exec],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
    case "stop_query": {
      if (model.running_tab_id === 0) return model;
      return [model, Cmd.cancel("query")];
    }
    case "select_table": {
      const url = activeUrl(model);
      const table = tableById(model, msg.id);
      if (url.length === 0 || table.id === 0 || model.running_tab_id !== 0) return model;
      // A tab already browsing this table just comes forward.
      for (let i = 0; i < model.tabs.length; i++) {
        if (model.tabs[i].table_id === msg.id) {
          return { ...model, active_tab_id: model.tabs[i].id, edit_row: -1 };
        }
      }
      // Otherwise reuse a pristine query tab, or open a new one.
      const active = tabById(model, model.active_tab_id);
      let target = active;
      let tabs = model.tabs;
      let next_id = model.next_tab_id;
      const pristine =
        active.table_id === 0 && active.cols.length === 0 && active.editor.text.trim().length === 0;
      if (!pristine) {
        if (model.tabs.length >= MAX_TABS) {
          return { ...model, shell_error: asciiBytes("Tab limit reached - close a tab to open this table.") };
        }
        target = freshTab(next_id);
        next_id += 1;
        const grown: QueryTab[] = [];
        for (let i = 0; i < model.tabs.length; i++) grown.push(model.tabs[i]);
        grown.push(target);
        tabs = grown;
      }
      // Discover the primary key first; pk_loaded then loads the data
      // ordered by it (ctid when the table has none).
      return [
        {
          ...model,
          running_tab_id: target.id,
          active_tab_id: target.id,
          next_tab_id: next_id,
          filter_column: new Uint8Array(0),
          filter_value: emptyDraft(),
          tabs: tabsWith(tabs, {
            ...target,
            title: table.name,
            icon: asciiBytes("file-text"),
            editor: emptyDraft(),
            dirty: false,
            running: true,
            table_id: msg.id,
            filters: [],
            base_sql: new Uint8Array(0),
            page: 0,
            pk_cols: new Uint8Array(0),
            staged: [],
          }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), pkSql(table.schema, table.name)],
          { key: "query", collect: true, exit: "pk_loaded", err: "query_failed" },
        ),
      ];
    }
    case "next_page": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      const table = tableById(model, tab.table_id);
      const pagedTab = table.id !== 0 || tab.base_sql.length > 0;
      if (url.length === 0 || !pagedTab || !tab.has_next || model.running_tab_id !== 0) return model;
      const page = tab.page + 1;
      let sql = wrapPaged(tab.base_sql, page * PAGE_SIZE);
      let editor = tab.editor;
      if (table.id !== 0) {
        sql = dataSql(table.schema, table.name, tab.filters, tab.pk_cols, page * PAGE_SIZE);
        editor = draftFrom(sql);
      }
      return [
        {
          ...model,
          running_tab_id: tab.id,
          tabs: tabsWith(model.tabs, { ...tab, editor: editor, running: true, page: page }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
    case "prev_page": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      const table = tableById(model, tab.table_id);
      const pagedTab = table.id !== 0 || tab.base_sql.length > 0;
      if (url.length === 0 || !pagedTab || tab.page === 0 || model.running_tab_id !== 0) return model;
      const page = tab.page - 1;
      let sql = wrapPaged(tab.base_sql, page * PAGE_SIZE);
      let editor = tab.editor;
      if (table.id !== 0) {
        sql = dataSql(table.schema, table.name, tab.filters, tab.pk_cols, page * PAGE_SIZE);
        editor = draftFrom(sql);
      }
      return [
        {
          ...model,
          running_tab_id: tab.id,
          tabs: tabsWith(model.tabs, { ...tab, editor: editor, running: true, page: page }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
    case "query_loaded": {
      const tab = tabById(model, model.running_tab_id);
      if (tab.id === 0) return { ...model, running_tab_id: 0 };
      if (msg.code !== 0) {
        return {
          ...model,
          running_tab_id: 0,
          tabs: tabsWith(model.tabs, { ...tab, running: false }),
          shell_error: asciiBytes("The query failed on the server - check the SQL and try again."),
        };
      }
      const keyed = tab.table_id > 0;
      const pagedTab = tab.table_id > 0 || tab.base_sql.length > 0;
      let cap = MAX_RESULT_ROWS;
      if (pagedTab) cap = PAGE_SIZE;
      const page = parsePage(msg.out, keyed, cap);
      const updated: QueryTab = {
        ...tab,
        running: false,
        cols: page.cols,
        cells: page.cells,
        row_keys: page.keys,
        row_count: page.rows,
        has_next: page.has_next,
      };
      return { ...model, running_tab_id: 0, tabs: tabsWith(model.tabs, updated) };
    }
    case "query_failed": {
      const tab = tabById(model, model.running_tab_id);
      let tabs = model.tabs;
      if (tab.id !== 0) tabs = tabsWith(model.tabs, { ...tab, running: false });
      if (containsIgnoreCase(msg.reason, asciiBytes("cancelled"))) {
        return { ...model, running_tab_id: 0, tabs: tabs };
      }
      if (containsIgnoreCase(msg.reason, asciiBytes("rejected"))) {
        return {
          ...model,
          running_tab_id: 0,
          tabs: tabs,
          shell_error: asciiBytes("A query is already running - stop it or wait for it to finish."),
        };
      }
      return {
        ...model,
        running_tab_id: 0,
        tabs: tabs,
        shell_error: asciiBytes("Could not run psql - install the PostgreSQL client tools to run queries."),
      };
    }
    case "sq_loaded": {
      if (msg.code !== 0) {
        return {
          ...model,
          shell_error: asciiBytes("The saved-queries database reported an error (sqlite3 exited nonzero)."),
        };
      }
      return { ...model, saved_queries: parseSavedRows(msg.out) };
    }
    case "open_save_query": {
      const tab = tabById(model, model.active_tab_id);
      if (tab.id === 0 || tab.table_id > 0) return model;
      if (tab.editor.text.trim().length === 0) {
        return { ...model, shell_error: asciiBytes("The editor is empty - write a query before saving.") };
      }
      return { ...model, save_query_open: true, save_name_draft: draftFrom(tab.title) };
    }
    case "cancel_save_query":
      return { ...model, save_query_open: false };
    case "save_name_edit":
      return { ...model, save_name_draft: applyDraftEdit(model.save_name_draft, msg.edit, NAME_CAPACITY) };
    case "confirm_save_query": {
      const tab = tabById(model, model.active_tab_id);
      const name = model.save_name_draft.text.trim();
      const sql = tab.editor.text.trim();
      if (name.length === 0) {
        return { ...model, shell_error: asciiBytes("Give the query a name to save it.") };
      }
      if (tab.id === 0 || sql.length === 0) return { ...model, save_query_open: false };
      return [
        {
          ...model,
          save_query_open: false,
          shell_error: new Uint8Array(0),
          tabs: tabsWith(model.tabs, { ...tab, title: name }),
        },
        Cmd.spawn(
          [asciiBytes("sqlite3"), asciiBytes("-batch"), asciiBytes("-separator"), unitSeparator(), asciiBytes("-newline"), recordSeparator(), DB_PATH, sqInsertSql(name, sql)],
          { collect: true, exit: "sq_loaded", err: "db_failed" },
        ),
      ];
    }
    case "load_saved": {
      let saved: SavedQuery = { id: 0, name: new Uint8Array(0), sql: new Uint8Array(0) };
      for (let i = 0; i < model.saved_queries.length; i++) {
        if (model.saved_queries[i].id === msg.id) saved = model.saved_queries[i];
      }
      if (saved.id === 0) return model;
      // Reuse a pristine query tab, or open a new one.
      const active = tabById(model, model.active_tab_id);
      let target = active;
      let tabs = model.tabs;
      let next_id = model.next_tab_id;
      const pristine =
        active.table_id === 0 && active.cols.length === 0 && active.editor.text.trim().length === 0;
      if (!pristine) {
        if (model.tabs.length >= MAX_TABS) {
          return { ...model, shell_error: asciiBytes("Tab limit reached - close a tab to open this query.") };
        }
        target = freshTab(next_id);
        next_id += 1;
        const grown: QueryTab[] = [];
        for (let i = 0; i < model.tabs.length; i++) grown.push(model.tabs[i]);
        grown.push(target);
        tabs = grown;
      }
      return {
        ...model,
        active_tab_id: target.id,
        next_tab_id: next_id,
        tabs: tabsWith(tabs, {
          ...target,
          title: saved.name,
          icon: asciiBytes("terminal"),
          editor: draftFrom(saved.sql),
          dirty: false,
          table_id: 0,
          filters: [],
          base_sql: new Uint8Array(0),
          page: 0,
        }),
      };
    }
    case "delete_saved": {
      for (let i = 0; i < model.saved_queries.length; i++) {
        const row = model.saved_queries[i];
        if (row.id === msg.id) {
          return [
            model,
            Cmd.spawn(
              [asciiBytes("sqlite3"), asciiBytes("-batch"), asciiBytes("-separator"), unitSeparator(), asciiBytes("-newline"), recordSeparator(), DB_PATH, sqDeleteSql(row.id)],
              { collect: true, exit: "sq_loaded", err: "db_failed" },
            ),
          ];
        }
      }
      return model;
    }
    case "begin_edit":
      return beginEditAt(model, msg.code);
    case "cancel_edit":
      return { ...model, edit_row: -1 };
    case "cell_edit":
      return { ...model, cell_draft: applyDraftEdit(model.cell_draft, msg.edit, URL_CAPACITY) };
    case "stage_edit": {
      const tab = tabById(model, model.active_tab_id);
      if (tab.id === 0 || tab.table_id === 0 || model.edit_row < 0) return model;
      const col = model.edit_col;
      let rowKey: Uint8Array = new Uint8Array(0);
      let found = false;
      for (let i = 0; i < tab.row_keys.length; i++) {
        if (i === model.edit_row) {
          rowKey = tab.row_keys[i].key;
          found = true;
        }
      }
      if (!found) return { ...model, edit_row: -1 };
      let oldValue: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < tab.cells.length; i++) {
        const cell = tab.cells[i];
        if (cell.row === model.edit_row && cell.col === col) oldValue = cell.text;
      }
      const newValue = model.cell_draft.text;
      // Drop any prior staged edit for this cell, then re-add if the
      // value actually differs from the database's.
      const kept: StagedEdit[] = [];
      for (let j = 0; j < tab.staged.length; j++) {
        const s = tab.staged[j];
        if (s.col_index === col && bytesEqual(s.key, rowKey)) continue;
        kept.push(s);
      }
      let next_id = model.next_staged_id;
      if (!bytesEqual(oldValue, newValue)) {
        let column: Uint8Array = new Uint8Array(0);
        for (let h = 0; h < tab.cols.length; h++) {
          if (h === col) column = tab.cols[h].name;
        }
        // Address the row by primary key when every pk column is
        // visible in the result; ctid otherwise.
        let where = bytesConcat([asciiBytes("ctid = "), sqlQuoted(rowKey)]);
        if (tab.pk_cols.length > 0) {
          const names = tab.pk_cols.split(unitSeparator());
          const parts: Uint8Array[] = [];
          let resolved = true;
          for (let n = 0; n < names.length; n++) {
            let idx = -1;
            for (let h = 0; h < tab.cols.length; h++) {
              if (bytesEqual(tab.cols[h].name, names[n])) idx = h;
            }
            if (idx < 0) {
              resolved = false;
            } else {
              if (parts.length > 0) parts.push(asciiBytes(" AND "));
              parts.push(identQuoted(names[n]));
              parts.push(asciiBytes(" = "));
              let pkValue: Uint8Array = new Uint8Array(0);
              for (let ci = 0; ci < tab.cells.length; ci++) {
                const pc = tab.cells[ci];
                if (pc.row === model.edit_row && pc.col === idx) pkValue = pc.text;
              }
              parts.push(sqlQuoted(pkValue));
            }
          }
          if (resolved && parts.length > 0) where = bytesConcat(parts);
        }
        kept.push({
          id: next_id,
          key: rowKey,
          column: column,
          col_index: col,
          old_value: oldValue,
          new_value: newValue,
          label: bytesConcat([column, asciiBytes(": "), oldValue, asciiBytes(" -> "), newValue]),
          where_sql: where,
        });
        next_id += 1;
      }
      return {
        ...model,
        edit_row: -1,
        next_staged_id: next_id,
        commit_ok: false,
        tabs: tabsWith(model.tabs, { ...tab, staged: kept }),
      };
    }
    case "unstage": {
      const tab = tabById(model, model.active_tab_id);
      if (tab.id === 0) return model;
      const kept: StagedEdit[] = [];
      for (let i = 0; i < tab.staged.length; i++) {
        if (tab.staged[i].id !== msg.id) kept.push(tab.staged[i]);
      }
      let review = model.review_open;
      if (kept.length === 0) review = false;
      return { ...model, review_open: review, tabs: tabsWith(model.tabs, { ...tab, staged: kept }) };
    }
    case "discard_staged": {
      const tab = tabById(model, model.active_tab_id);
      if (tab.id === 0) return model;
      return {
        ...model,
        review_open: false,
        edit_row: -1,
        commit_ok: false,
        tabs: tabsWith(model.tabs, { ...tab, staged: [] }),
      };
    }
    case "open_review":
      return { ...model, review_open: true };
    case "close_review":
      return { ...model, review_open: false };
    case "commit_staged": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      const table = tableById(model, tab.table_id);
      if (url.length === 0 || table.id === 0 || tab.staged.length === 0 || model.running_tab_id !== 0) {
        return model;
      }
      const sql = commitSql(table.schema, table.name, tab.staged, tab.filters, tab.pk_cols, tab.page * PAGE_SIZE);
      return [
        {
          ...model,
          running_tab_id: tab.id,
          review_open: false,
          edit_row: -1,
          commit_ok: false,
          tabs: tabsWith(model.tabs, { ...tab, running: true }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "commit_loaded", err: "query_failed" },
        ),
      ];
    }
    case "pk_loaded": {
      const tab = tabById(model, model.running_tab_id);
      const table = tableById(model, tab.table_id);
      const url = activeUrl(model);
      if (tab.id === 0 || table.id === 0 || url.length === 0) {
        return { ...model, running_tab_id: 0 };
      }
      // A failed pk probe degrades to ctid addressing, never an error.
      let pk: Uint8Array = new Uint8Array(0);
      if (msg.code === 0) pk = parsePkCols(msg.out);
      const sql = dataSql(table.schema, table.name, tab.filters, pk, tab.page * PAGE_SIZE);
      return [
        {
          ...model,
          tabs: tabsWith(model.tabs, { ...tab, pk_cols: pk, editor: draftFrom(sql) }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
    case "commit_loaded": {
      const tab = tabById(model, model.running_tab_id);
      if (tab.id === 0) return { ...model, running_tab_id: 0 };
      if (msg.code !== 0) {
        // The transaction rolled back: nothing was written, and every
        // staged change is kept for review.
        return {
          ...model,
          running_tab_id: 0,
          tabs: tabsWith(model.tabs, { ...tab, running: false }),
          shell_error: asciiBytes("Commit failed - the database rejected the staged changes; nothing was written. Review the staged values and try again."),
        };
      }
      const page = parsePage(msg.out, true, PAGE_SIZE);
      return {
        ...model,
        running_tab_id: 0,
        commit_ok: true,
        shell_error: new Uint8Array(0),
        tabs: tabsWith(model.tabs, {
          ...tab,
          running: false,
          staged: [],
          cols: page.cols,
          cells: page.cells,
          row_keys: page.keys,
          row_count: page.rows,
          has_next: page.has_next,
        }),
      };
    }
    case "toggle_filter_column":
      return { ...model, filter_column_open: !model.filter_column_open, filter_op_open: false };
    case "dismiss_filter_column":
      return { ...model, filter_column_open: false };
    case "pick_filter_column":
      return { ...model, filter_column: msg.name, filter_column_open: false };
    case "toggle_filter_op":
      return { ...model, filter_op_open: !model.filter_op_open, filter_column_open: false };
    case "dismiss_filter_op":
      return { ...model, filter_op_open: false };
    case "pick_filter_op":
      return { ...model, filter_op: msg.op, filter_op_open: false };
    case "filter_value_edit":
      return { ...model, filter_value: applyDraftEdit(model.filter_value, msg.edit, URL_CAPACITY) };
    case "add_filter": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      const table = tableById(model, tab.table_id);
      if (url.length === 0 || table.id === 0 || model.running_tab_id !== 0) return model;
      if (model.filter_column.length === 0) {
        return { ...model, shell_error: asciiBytes("Pick a column to filter on first.") };
      }
      const value = model.filter_value.text.trim();
      if (opTakesValue(model.filter_op) && value.length === 0) {
        return { ...model, shell_error: asciiBytes("This filter operator needs a value.") };
      }
      let label = bytesConcat([model.filter_column, asciiBytes(" "), opLabel(model.filter_op)]);
      if (opTakesValue(model.filter_op)) {
        label = bytesConcat([label, asciiBytes(" "), value]);
      }
      const filter: FilterRow = {
        id: model.next_filter_id,
        column: model.filter_column,
        op: model.filter_op,
        value: value,
        label: label,
      };
      const filters: FilterRow[] = [];
      for (let i = 0; i < tab.filters.length; i++) filters.push(tab.filters[i]);
      filters.push(filter);
      const sql = dataSql(table.schema, table.name, filters, tab.pk_cols, 0);
      return [
        {
          ...model,
          running_tab_id: tab.id,
          next_filter_id: model.next_filter_id + 1,
          filter_value: emptyDraft(),
          shell_error: new Uint8Array(0),
          tabs: tabsWith(model.tabs, {
            ...tab,
            editor: draftFrom(sql),
            dirty: false,
            running: true,
            filters: filters,
            page: 0,
          }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
    case "remove_filter": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      const table = tableById(model, tab.table_id);
      if (url.length === 0 || table.id === 0 || model.running_tab_id !== 0) return model;
      const filters: FilterRow[] = [];
      for (let i = 0; i < tab.filters.length; i++) {
        if (tab.filters[i].id !== msg.id) filters.push(tab.filters[i]);
      }
      const sql = dataSql(table.schema, table.name, filters, tab.pk_cols, 0);
      return [
        {
          ...model,
          running_tab_id: tab.id,
          tabs: tabsWith(model.tabs, {
            ...tab,
            editor: draftFrom(sql),
            dirty: false,
            running: true,
            filters: filters,
            page: 0,
          }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
    case "clear_filters": {
      const url = activeUrl(model);
      const tab = tabById(model, model.active_tab_id);
      const table = tableById(model, tab.table_id);
      if (url.length === 0 || table.id === 0 || model.running_tab_id !== 0) return model;
      if (tab.filters.length === 0) return model;
      const sql = dataSql(table.schema, table.name, [], tab.pk_cols, 0);
      return [
        {
          ...model,
          running_tab_id: tab.id,
          tabs: tabsWith(model.tabs, {
            ...tab,
            editor: draftFrom(sql),
            dirty: false,
            running: true,
            filters: [],
            page: 0,
          }),
        },
        Cmd.spawn(
          [asciiBytes("psql"), url, asciiBytes("-X"), asciiBytes("-q"), asciiBytes("-A"), asciiBytes("-F"), unitSeparator(), asciiBytes("-R"), recordSeparator(), asciiBytes("-P"), asciiBytes("footer=off"), asciiBytes("-v"), asciiBytes("ON_ERROR_STOP=1"), asciiBytes("-c"), sql],
          { key: "query", collect: true, exit: "query_loaded", err: "query_failed" },
        ),
      ];
    }
  }
}
