// Session restore.
//
// The one place this app keeps durable state outside the SQLite store. That
// store is shared with the native side and holds the app's DATA — connections
// and saved queries. What lives here is only the shape of the window: which
// tabs were open and what each one was looking at. It is per-WebView and
// disposable; losing it costs you a re-open of a table, nothing more.
//
// Two things are deliberately NOT saved:
//
//   - Results. They are the database's data, not the session's. A page cached
//     from last week would be presented as current, which is worse than an
//     empty grid; the active tab re-runs on open instead.
//
//   - Staged edits. They address a row by ctid and by a WHERE resolved from
//     the values that were on screen when the edit was made. Restoring one
//     after a restart and committing it could overwrite a change somebody
//     else made in between. Pending edits stay in memory, and closing the app
//     discards them.

import { freshTab, type QueryTab } from "./tabs";
import { reserveNodeIds } from "./sql";

/// One session per connection: a workspace describes tables in one specific
/// database, so each connection remembers its own and switching swaps whole
/// workspaces rather than bleeding tabs between databases.
function keyFor(connectionId: number): string {
  return `artemis:session:${connectionId}`;
}

/// The pre-per-connection slot. It holds exactly the cross-connection soup
/// this design replaces, so it is deleted on sight rather than migrated.
const LEGACY_KEY = "artemis:session";

/// Bumped when the shape below changes incompatibly. A mismatch drops the
/// session rather than trying to migrate half-understood data into the app.
const VERSION = 1;

/// The durable slice of a tab. Everything else is rebuilt by re-running.
type StoredTab = Pick<QueryTab, "id" | "name" | "sql" | "source" | "savedId" | "pageSize">;

export interface Session {
  version: number;
  /// Which connection these tabs describe. Tabs name tables in one specific
  /// database, so restoring them against a different one would show a
  /// workspace of things that may not exist.
  connectionId: number;
  screen: "home" | "workspace";
  tabs: StoredTab[];
  activeTabId: number;
  nextTabId: number;
  editorHeight: number;
}

export function saveSession(session: Session): void {
  if (session.connectionId <= 0) return;
  try {
    window.localStorage.removeItem(LEGACY_KEY);
    window.localStorage.setItem(keyFor(session.connectionId), JSON.stringify(session));
  } catch {
    // Full, or storage disabled. A lost session is not worth an error in the
    // user's face — they just get a fresh workspace next time.
  }
}

export function loadSession(connectionId: number): Session | null {
  if (connectionId <= 0) return null;
  try {
    window.localStorage.removeItem(LEGACY_KEY);
    const raw = window.localStorage.getItem(keyFor(connectionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    if (parsed.version !== VERSION) return null;
    // The key says which connection this is for; the field agreeing is the
    // sanity check that nothing wrote through the wrong key.
    if (parsed.connectionId !== connectionId) return null;
    if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/// Forget one connection's workspace — called when the connection itself is
/// deleted, so orphaned sessions do not accumulate in localStorage.
export function clearSession(connectionId: number): void {
  try {
    window.localStorage.removeItem(keyFor(connectionId));
  } catch {
    // Nothing to do; the next save overwrites it anyway.
  }
}

/// Turn a stored tab back into a whole one: the durable fields as saved, the
/// rest at their empty defaults so the tab reads as "not run yet".
export function hydrateTab(stored: StoredTab): QueryTab {
  const tab: QueryTab = {
    ...freshTab(stored.id, stored.name),
    sql: stored.sql ?? "",
    source: stored.source ?? { kind: "none" },
    savedId: stored.savedId ?? 0,
    pageSize: stored.pageSize ?? freshTab(stored.id).pageSize,
  };
  if (tab.source.kind === "table") reserveNodeIds(tab.source.query.where);
  return tab;
}

export function storeTab(tab: QueryTab): StoredTab {
  return {
    id: tab.id,
    name: tab.name,
    sql: tab.sql,
    source: tab.source,
    savedId: tab.savedId,
    pageSize: tab.pageSize,
  };
}
