// Query tabs.
//
// A tab is a whole workspace document: its own statement, its own result,
// its own page position and its own staged edits. Sharing any of those
// across tabs is what would let a commit land against the rows another tab
// is showing, so the state is per-tab by construction rather than by
// discipline.

import type { Page } from "./parse";
import { DEFAULT_PAGE_SIZE } from "./sql";
import type { StagedEdit, TableQuery } from "./sql";
import type { TableRef } from "./parse";

export const EMPTY_PAGE: Page = { cols: [], rows: [], keys: [], hasNext: false };

/// What produced a tab's current result, so paging and commit know how to
/// re-run it.
export type Source =
  | { kind: "none" }
  /// `columns` is the table's full column set, captured on open. The builder
  /// needs it to offer a column it is currently hiding — the last page only
  /// knows about the ones it selected.
  | {
      kind: "table";
      table: TableRef;
      pkCols: string[];
      columns: string[];
      query: TableQuery;
    }
  | { kind: "sql"; sql: string };

export interface QueryTab {
  id: number;
  /// Display name. Follows the opened table, or the saved query's name.
  name: string;
  sql: string;
  source: Source;
  page: Page;
  pageIndex: number;
  /// Whether this tab's source has actually been run this session. A restored
  /// tab has a source but no result yet; false is what triggers the one-time
  /// re-run on arrival. NOT a proxy for "has rows" — an empty result (a table
  /// with no rows) is still loaded, and confusing the two loops the re-run.
  loaded: boolean;
  /// Rows per page, per tab. A single global would leave every other tab's
  /// pageIndex pointing at an offset computed under the old size, so their
  /// loaded rows would silently stop matching their page number.
  pageSize: number;
  staged: StagedEdit[];
  /// Set when the tab came from (or was written to) a saved query, so Save
  /// updates in place instead of creating duplicates.
  savedId: number;
  /// Total rows the current source matches, from a best-effort count query.
  /// null while unknown (still counting, count failed, or single-run).
  total: number | null;
  /// The count statement `total` answers. A late count only lands if the tab
  /// still asks the same question — this is what keeps a slow count from a
  /// superseded query off the footer.
  countKey: string;
  status: string;
  elapsed: number;
}

export function freshTab(id: number, name = `Query ${id}`): QueryTab {
  return {
    id,
    name,
    sql: "",
    source: { kind: "none" },
    page: EMPTY_PAGE,
    pageIndex: 0,
    loaded: false,
    pageSize: DEFAULT_PAGE_SIZE,
    staged: [],
    savedId: 0,
    total: null,
    countKey: "",
    status: "",
    elapsed: 0,
  };
}

export function tabById(tabs: readonly QueryTab[], id: number): QueryTab | null {
  return tabs.find((t) => t.id === id) ?? null;
}

/// Replace one tab, leaving the rest untouched.
export function withTab(
  tabs: readonly QueryTab[],
  id: number,
  patch: Partial<QueryTab>,
): QueryTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
}
