// Query tabs.
//
// A tab is a whole workspace document: its own statement, its own result,
// its own page position and its own staged edits. Sharing any of those
// across tabs is what would let a commit land against the rows another tab
// is showing, so the state is per-tab by construction rather than by
// discipline.

import type { Page } from "./parse";
import type { Filter, StagedEdit } from "./sql";
import type { TableRef } from "./parse";

export const EMPTY_PAGE: Page = { cols: [], rows: [], keys: [], hasNext: false };

/// What produced a tab's current result, so paging and commit know how to
/// re-run it.
export type Source =
  | { kind: "none" }
  | { kind: "table"; table: TableRef; pkCols: string[]; filters: Filter[] }
  | { kind: "sql"; sql: string };

export interface QueryTab {
  id: number;
  /// Display name. Follows the opened table, or the saved query's name.
  name: string;
  sql: string;
  source: Source;
  page: Page;
  pageIndex: number;
  staged: StagedEdit[];
  /// Set when the tab came from (or was written to) a saved query, so Save
  /// updates in place instead of creating duplicates.
  savedId: number;
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
    staged: [],
    savedId: 0,
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
