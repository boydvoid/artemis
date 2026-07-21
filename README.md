# Artemis

A desktop Postgres browser. React in the system WebView, Zig native shell,
no Electron.

Browse tables, run SQL, filter and edit rows. Built around a data grid that
does the thing every terminal client makes hard: **wide tables stay
readable** — real per-column widths, horizontal scroll, pinned header and
row gutter, drag-resizable columns.

> **Status: early.** It works and is used daily, but it is young. See
> [Limitations](#known-limitations) before trusting it with production data.

![Artemis](docs/screenshot.png)

## Requirements

| | | |
|---|---|---|
| **macOS or Linux** | | Windows is untested |
| **[Native SDK CLI](https://native-sdk.dev)** | `npm i -g @native-sdk/cli` | provides `native`, and Zig 0.16 |
| **`psql`** | PostgreSQL client tools | how queries actually run |
| **`sqlite3`** | usually preinstalled on macOS | stores your connections |
| **Node 20+** | | builds the frontend |

Check the first two with `native doctor`.

## Quick start

```sh
git clone https://github.com/boydvoid/artemis.git
cd artemis
npm install --prefix frontend
native dev
```

That starts the Vite dev server and opens the app. Add a connection on the
home screen — e.g. `postgres://user:password@localhost:5432/postgres` — and
pick it to start browsing.

For a production build instead:

```sh
native build && ./zig-out/bin/artemis
```

### If the build cannot find the SDK

`build.zig` resolves the Native SDK at
`/opt/homebrew/lib/node_modules/@native-sdk/cli` (a Homebrew-installed
global npm prefix). If yours lives elsewhere — which it will on Linux, or
with nvm — point at it explicitly:

```sh
native build -Dnative-sdk-path="$(npm root -g)/@native-sdk/cli"
```

### Dev server port

Pinned to **5199**, not Vite's default 5173. `native dev` waits for the dev
URL to answer, so another project's server on 5173 would report "ready" and
the shell would load *its* app instead. The port appears in `app.zon`,
`frontend/vite.config.js` and `src/main.zig` — keep the three in lockstep.

## Where your data lives

Saved connections and queries go in a local SQLite file:

- macOS — `~/Library/Application Support/artemis/artemis.db`
- Linux — `$XDG_DATA_HOME/artemis/artemis.db`

Override with `ARTEMIS_DB=/path/to/file`.

**Connection strings are stored in plain text**, including passwords. The
file lives outside the repo and is gitignored, but treat it like any other
credential store.

## Architecture

The native side is the app. The web layer is its client: it renders and
holds view state, but **owns no durable state of its own** — no
localStorage, no IndexedDB, no cookies. Everything persistent goes through
the bridge.

```
React  ──  window.zero.invoke("db.exec",    { url, sql })  ──▶  psql     (a connected database)
       ──  window.zero.invoke("store.exec", { sql })       ──▶  sqlite3  (the app's own state)
       ◀──  { ok, code, out, err, truncated }  ─────────────────┘
```

Both commands share one contract: send SQL, get raw framed stdout back, and
a failing statement is *data* (`ok:false` plus stderr), not a bridge fault.

`store.exec` reads and writes the same SQLite schema the canvas app used —
`connections`, `saved_queries`, plus an additive `app_state` key/value table
for things like the selected connection. The store lives in the OS
application-data directory (macOS:
`~/Library/Application Support/artemis/artemis.db`) rather than a
CWD-relative path, because the app is launched from several places and a
relative path would silently create a different, empty database in each.
Set `ARTEMIS_DB` to point it elsewhere — that is how you share one file
with the canvas app, which still uses its own `legacy/.artemis/artemis.db`.

`out` is raw psql stdout in unit/record-separator framing
(`-A -F <US> -R <RS>`), the same format the native app used. All parsing
happens in TypeScript (`frontend/src/lib/parse.ts`), all SQL construction
in `frontend/src/lib/sql.ts` — both ported from `legacy/src/pg.ts` and
`legacy/src/core.ts`. `src/main.zig` builds no SQL and interprets no results;
it is a pipe.

The bridge is deny-by-default: only `db.exec` and `store.exec` are
registered, each reachable only from the origins listed in `main.zig`.

### Layout

| Path | Role |
| --- | --- |
| `src/main.zig` | shell + the `db.exec` and `store.exec` handlers |
| `frontend/src/lib/bridge.ts` | the one seam to native |
| `frontend/src/lib/sql.ts` | SQL construction, quoting, pagination |
| `frontend/src/lib/parse.ts` | psql framed-output parsing |
| `frontend/src/lib/store.ts` | app state via `store.exec` (SQLite) |
| `frontend/src/components/DataGrid.tsx` | the results grid |
| `frontend/src/components/Connections.tsx` | the home screen |
| `frontend/src/App.tsx` | app state, routing and composition |

Typecheck with `./frontend/node_modules/.bin/tsc -p frontend/tsconfig.json`.

### Styling

Tailwind v4 (CSS-first, via `@tailwindcss/vite`) plus shadcn/ui. Components
live in `frontend/src/components/ui/` and are ours to edit — add more with
`npx shadcn@latest add <name>` from `frontend/`. This shadcn release builds
on **Base UI**, not Radix, so `onValueChange` can emit `null` and component
props follow Base UI's shapes.

The theme is dark-only (a tool you stare at for hours): the palette lives
in `frontend/src/index.css` as shadcn CSS variables, with `--primary` set to
the phosphor amber that signals "this is the live one" — active connection,
staged edit, primary action. `<html class="dark">` is fixed, not toggled.

The grid is deliberately **not** shadcn's Table: sticky header, sticky row
gutter, `table-layout: fixed` and drag-resizable columns are not things it
does. Its structural rules live in `index.css` under `.grid-table`; the rest
is utility classes.

## Screens

**Home** is the connections list: add, open, or delete a saved connection.
Opening one enters the workspace; the remembered active connection is
marked but is not auto-opened, so launching always lands here.

**Workspace** is the tabbed editor, results grid and table browser. The rail
header shows the active connection and is the way back home — returning
keeps the connection active, so re-entering does not re-run the catalog
query. Switching to a *different* connection clears the tables and grid and
reloads.

## Working

Connections (add, open, delete, persisted), table browser with filter,
SQL editor (⌘↵ to run), keyed table views ordered by primary key (ctid
fallback), OFFSET pagination with a probe row, psql errors surfaced
verbatim, and a results grid with real per-column min-widths, horizontal
scroll, a pinned header and row gutter, and drag-resizable columns
(double-click a divider to reset).

### Editing

Double-click a cell in a table view to edit it; Enter stages, Escape
cancels. Staged cells show amber until committed — nothing reaches the
database before **Commit**.

Commit sends one transaction: all edits to a row collapse into a single
UPDATE, so a multi-column change lands together. Rows are addressed by
primary key when every pk column is on screen, by `ctid` otherwise, and
the predicate always uses the row's *original* values so editing a key
column still matches. The page select rides the same round trip, so the
grid refreshes from the database rather than from local state — which
matters because UPDATE rewrites rows and their ctids change.

A failed commit rolls back and keeps the batch staged, so nothing is
silently lost. Staged edits are dropped when you change page, table, or
query, since they address rows that are no longer on screen.

Editing is only offered for keyed table views: a join or an expression
has no single row to write back to.

The literal text `NULL` sets a column NULL (inherited from the native
app), which means you cannot store the four characters "NULL".

### Filters

Table views carry a filter bar: pick a column and operator, add a value,
and the filter becomes a chip. Operators are `=`, `!=`, `>`, `<`, `>=`,
`<=`, `contains`, `is null`, `is not null`; valueless operators hide the
value input.

Filters AND together and are applied **server-side** in the table's WHERE
clause, so they narrow the real result set — pagination and row numbers
stay honest rather than describing a set the client already fetched. They
also ride the commit statement's trailing select, so a row edited out of
the filtered set correctly disappears after commit.

`contains` is `::text ILIKE '%value%'` (case-insensitive, works on
non-text columns). The ordering operators compare in the column's own
type, so `qty > 50` on an integer column is numeric, not lexicographic.

Changing filters resets to page 0 and drops staged edits, since both
address rows that may no longer be in the set.

### Tabs

A query tab is a whole document: its own statement, result, page position
and staged edits. Nothing is shared between tabs, so a commit can never
land against rows a different tab is showing. Opening a table renames the
tab after it; `+` opens a blank one; the last tab cannot be closed. A tab
with staged edits shows an amber dot, so closing one never silently drops
pending work.

**Filters** is pinned at the end of the strip, past a divider, because it
is a different kind of thing: a panel mode, not a document. It edits the
*active* query tab's filters and carries that tab's filter count as a
badge. It is disabled unless the active tab is a table view.

### Saved queries

**Save** names the current statement and writes it to `saved_queries` in
the SQLite store; the rail lists them. Opening one always gets its own new
tab rather than overwriting what is in front of you. A tab that came from a
saved query shows **Update** instead of Save and rewrites that row in place
rather than accumulating near-duplicates. Deleting a saved query leaves any
open tab intact, just no longer linked.

## Known limitations

- Bridge handlers dispatch **synchronously** on the loop thread, so a slow
  query blocks the window until psql returns. The fix is the SDK's async
  bridge registry (`AsyncHandler` in `bridge/root.zig`).
- Results are capped at ~700 KB per query at the bridge; over that the
  response comes back with `truncated: true` and the UI says so.
- psql's text format cannot distinguish SQL `NULL` from an empty string —
  both arrive as an empty field. The grid renders both as `NULL`. This
  ambiguity is inherited from the native app; only a real driver
  (`node-postgres`) or a JSON-returning query would remove it.
- Connection strings are stored in plaintext in the SQLite file, as they
  were in the canvas app.

## legacy/

The original UI, before the rewrite: a native-canvas app built on the
Native SDK's markup layer. It is kept because its `src/pg.ts` and
`src/core.ts` are where this app's SQL construction and psql parsing were
ported from.

It still builds (`cd legacy && native build`), though its `build.zig.zon`
uses a relative SDK path that assumes the Homebrew location. It keeps its
own `.artemis/artemis.db` and shares nothing with the current app.

The canvas grid divided the pane width by the column count, so a 26-column
table gave each column 67pt and elided every value, with no way to reach
the columns past the edge — the SDK canvas has no horizontal scrolling.
That is the whole reason this project moved to a WebView.

## Contributing

Issues and pull requests welcome. Before opening a PR:

```sh
./frontend/node_modules/.bin/tsc -p frontend/tsconfig.json   # typecheck
npm --prefix frontend run build                              # frontend
native build                                                 # shell
```

There is no test suite yet — that is the most useful contribution
available.

## License

MIT — see [LICENSE](LICENSE).

## Diagnostics

- `NATIVE_SDK_LOG_DIR` overrides the platform log directory.
- `NATIVE_SDK_LOG_FORMAT=text|jsonl` chooses the persistent log format.
- `db.exec` logs `code=/stdout=/stderr=` byte counts to stderr on every
  query — run the binary with stderr captured to see them.
