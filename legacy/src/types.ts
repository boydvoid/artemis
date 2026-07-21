// Shared record types and tuning constants for the Artemis core.
//
// Every record here is plain data in the app-core subset; the Model and
// Msg unions that reference them stay in core.ts (the app contract the
// checker and bindings read).

import { type TextEditState } from "@native-sdk/core/text";

export const NAME_CAPACITY = 64;

export const URL_CAPACITY = 512;

/// SQL editor byte budget per tab.
export const SQL_CAPACITY = 4096;

/// Rows fetched per table-browse page (one extra probes for a next page).
export const PAGE_SIZE = 15;

/// Result-row cap for free-form queries.
export const MAX_RESULT_ROWS = 50;

/// Grid column cap. Columns are no longer a fixed set of model fields -
/// results carry any number - but a page still has to fit the view's
/// 1024-widget budget (columns x rows + chrome), so very wide tables
/// show their first MAX_COLUMNS columns.
export const MAX_COLUMNS = 48;

/// Tab-strip cap - keeps the strip inside the widget budget.
export const MAX_TABS = 8;

export type SidebarIcon = "chevron-left" | "chevron-right";

/// Filter operators the query builder offers.
export type FilterOp = "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "contains" | "is_null" | "not_null";

/// One saved connection record, as stored in SQLite.
export interface ConnectionRow {
  readonly id: number;
  readonly name: Uint8Array;
  readonly url: Uint8Array;
}

/// One table in the connected database's catalog.
export interface TableRef {
  readonly id: number;
  readonly schema: Uint8Array;
  readonly name: Uint8Array;
}

/// One sidebar browser line: a schema header or a selectable table.
export interface BrowserRow {
  readonly key: number;
  readonly id: number;
  readonly header: boolean;
  readonly label: Uint8Array;
}

/// One staged (uncommitted) cell edit, keyed by row ctid + column.
export interface StagedEdit {
  readonly id: number;
  readonly key: Uint8Array;
  readonly column: Uint8Array;
  readonly col_index: number;
  readonly old_value: Uint8Array;
  readonly new_value: Uint8Array;
  /// Prebuilt review line ("email: old -> new").
  readonly label: Uint8Array;
  /// Prebuilt row predicate: primary-key equality when the table has a
  /// primary key, ctid equality otherwise.
  readonly where_sql: Uint8Array;
}

/// One saved query, as stored in SQLite.
export interface SavedQuery {
  readonly id: number;
  readonly name: Uint8Array;
  readonly sql: Uint8Array;
}

/// One applied query-builder filter (a WHERE conjunct).
export interface FilterRow {
  readonly id: number;
  readonly column: Uint8Array;
  readonly op: FilterOp;
  readonly value: Uint8Array;
  /// Prebuilt display text for the filter chip ("email contains bob").
  readonly label: Uint8Array;
}

/// One operator row for the builder's operator picker.
export interface FilterOpRow {
  readonly op: FilterOp;
  readonly label: Uint8Array;
}

/// One column of the active result, for the builder's column picker.
export interface ColumnRef {
  readonly name: Uint8Array;
}

/// One query tab: its own editor, results, and browse/pagination state.
/// Tabs are session-only by design - they are not persisted across app
/// restarts (the connections database is the persistent state).
export interface QueryTab {
  readonly id: number;
  readonly title: Uint8Array;
  /// Tab-strip icon name: "terminal" (query view) or "file-text" (table view).
  readonly icon: Uint8Array;
  readonly editor: TextEditState;
  /// Edited since the last run - closing prompts for confirmation.
  readonly dirty: boolean;
  readonly running: boolean;
  /// Table-browse mode: the browsed table's id (0 = free-form query).
  readonly table_id: number;
  /// Query-builder filters (table-browse mode only).
  readonly filters: readonly FilterRow[];
  /// Free-form pagination: the unwrapped SELECT the pager re-wraps
  /// (empty = the query ran as written, no pager).
  readonly base_sql: Uint8Array;
  readonly page: number;
  /// Result columns, in order (empty until a query returns).
  readonly cols: readonly ColumnRef[];
  /// Result cells, row-major (row * cols.length + col).
  readonly cells: readonly CellRec[];
  /// Row identities, parallel to the page's rows.
  readonly row_keys: readonly RowKey[];
  readonly row_count: number;
  readonly has_next: boolean;
  /// Staged cell edits, uncommitted until the user commits them.
  readonly staged: readonly StagedEdit[];
  /// The table's primary-key column names (US-joined; empty = no pk,
  /// fall back to ctid ordering/addressing).
  readonly pk_cols: Uint8Array;
}


/// One result cell, stored flat in the model: the model tier holds
/// arrays of flat records, so a page is one row-major cell list rather
/// than an array-of-arrays (which it cannot store) or a fixed set of
/// numbered fields (which caps the column count).
export interface CellRec {
  readonly row: number;
  readonly col: number;
  readonly text: Uint8Array;
}

/// One result row's identity (Postgres ctid), parallel to the page's
/// rows; empty for free-form results, which are not editable.
export interface RowKey {
  readonly key: Uint8Array;
}

/// One rendered cell: the staged value overlaid on the stored one,
/// whether it carries a staged edit, and the flat index the single
/// `begin_edit` message uses to address it.
export interface DisplayCell {
  readonly code: number;
  readonly text: Uint8Array;
  readonly dirty: boolean;
}
