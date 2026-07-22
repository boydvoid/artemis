# Artemis

A desktop database browser — PostgreSQL and SQLite. React in the system
WebView, Zig native shell, no Electron.

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

Workspace sessions (open tabs, filters, sort, page sizes) live separately
in the WebView's localStorage, one entry per connection under
`artemis:session:<id>`; deleting a connection deletes its session. They
hold no credentials and no query results; clearing the WebView's data
resets the workspaces but touches nothing in SQLite.

## Architecture

The native side is the app. The web layer is its client: it renders and
holds view state, and everything with a claim to being the app's *data* —
connections, saved queries, the active connection — goes through the
bridge. The one deliberate exception is the workspace session (which tabs
are open and what each was looking at): that is window shape, not data, so
it lives in WebView localStorage (`frontend/src/lib/session.ts`) and losing
it costs a re-open of a table, nothing more.

```
React  ──  db.exec    { url, sql, driver }  ──▶  psql / sqlite3  (a connected database)
       ──  store.exec  { sql }               ──▶  sqlite3         (the app's own state)
       ◀──  { ok, code, out, err, truncated }  ───────────────────┘
```

Both commands share one contract: send SQL, get raw framed stdout back, and
a failing statement is *data* (`ok:false` plus stderr), not a bridge fault.

`db.exec` speaks to more than one engine. A connection's dialect is a pure
function of its URL — `sqlite:<path>` is SQLite, anything else Postgres — so
adding SQLite needed no schema change; the `url` column already said it. The
web layer sends a `driver` and `main.zig` routes it to `psql` or `sqlite3`,
each invoked with flags that produce the **same** framing (US fields, RS
records, `0x01` for NULL, a header record), so the TypeScript parser is
engine-blind. What little SQL genuinely differs — the row-identity token
(`ctid` / `rowid`), the catalog and primary-key queries, and the `contains`
operator (`ILIKE` vs `CAST … LIKE`) — comes from a small `Dialect`
(`frontend/src/lib/db/`); the builders in `sql.ts` are one shared body.

Queries run **off the loop thread**: `db.exec` and `store.exec` are async
bridge handlers, so a slow query never freezes the window. The handler
copies the request and spawns a worker; the worker runs the subprocess and
nudges the platform loop, which completes the bridge response on the loop
thread — the only thread the WebView may be spoken to from.

A result too large for one bridge response (the SDK caps a response at
1 MiB) is stashed native-side and delivered in pieces: the first reply
carries a `more` handle, and `frontend/src/lib/bridge.ts` pulls the rest
through `db.chunk` before handing callers one complete result. Callers
never see the seam. The end of the line is an 8 MiB stdout cap, reported
honestly as `truncated`.

`store.exec` reads and writes the same SQLite schema the canvas app used —
`connections`, `saved_queries`, plus an additive `app_state` key/value table
for things like the selected connection. The store lives in the OS
application-data directory (macOS:
`~/Library/Application Support/artemis/artemis.db`) rather than a
CWD-relative path, because the app is launched from several places and a
relative path would silently create a different, empty database in each.
Set `ARTEMIS_DB` to point it elsewhere — that is how you share one file
with the canvas app, which still uses its own `legacy/.artemis/artemis.db`.

`out` is raw client stdout in unit/record-separator framing
(`-A -F <US> -R <RS>` for psql, `-separator/-newline` for sqlite3), with a
`0x01` NULL marker so SQL `NULL` is finally distinguishable from an empty
string. All parsing happens in TypeScript (`frontend/src/lib/parse.ts`),
all SQL construction in `frontend/src/lib/sql.ts` (parameterized by the
dialect). `src/main.zig` builds no SQL and interprets no results; it is a
pipe that picks a client.

The bridge is deny-by-default: only `db.exec` and `store.exec` are
registered, each reachable only from the origins listed in `main.zig`.

### Layout

| Path | Role |
| --- | --- |
| `src/main.zig` | shell + the `db.exec` and `store.exec` handlers |
| `frontend/src/lib/bridge.ts` | the one seam to native |
| `frontend/src/lib/db/` | dialects: what differs per engine, and URL→dialect |
| `frontend/src/lib/sql.ts` | SQL construction (dialect-parameterized), predicate tree, pagination |
| `frontend/src/lib/parse.ts` | framed-output parsing (engine-blind) |
| `frontend/src/lib/store.ts` | app state via `store.exec` (SQLite) |
| `frontend/src/lib/session.ts` | workspace restore (localStorage — the one exception) |
| `frontend/src/lib/pgurl.ts` | connection URL ⇄ fields conversion |
| `frontend/src/lib/monaco.ts` | Monaco setup: theme, SQL completions, keyword upcasing |
| `frontend/src/lib/tabs.ts` | the query-tab model |
| `frontend/src/components/DataGrid.tsx` | the results grid, incl. header sorting |
| `frontend/src/components/QueryBuilder.tsx` | predicates + column picker for table tabs |
| `frontend/src/components/SqlEditor.tsx` | the Monaco wrapper |
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
A connection can be entered either as a URL or through a **Fields** editor
(host, port, database, user, password, ssl mode) — the fields build the
same URL, percent-encoding a password whose `@`, `:` or `/` would otherwise
silently change what the URL means. Only the URL is stored.

**Workspace** is the tabbed editor, query builder, results grid and table
browser. The rail header shows the active connection and is the way back
home. Switching to a *different* connection clears sources and results but
keeps statement text and page-size preferences.

**Every connection remembers its own workspace** — tabs, filters, hidden
columns, sort and page sizes. Reopening the app restores the remembered
connection's workspace, and switching connections swaps whole workspaces:
the outgoing one is saved, the incoming one restored, so tabs never bleed
between databases and nothing typed is lost — it waits in the connection it
belongs to. The active tab re-runs when you land on it; others re-run when
you switch to them. Results and staged edits are never restored: a cached
page presented as current is worse than an empty grid, and a staged edit
committed after a restart could overwrite someone else's change. With no
session to restore, launching lands on Home.

## Working

Connections (add, open, delete, persisted), table browser with filter,
Monaco SQL editor, a query builder on table tabs, keyed table views ordered
by primary key (ctid fallback), column-header sorting, OFFSET pagination
with a probe row and a page-size picker (25/50/100/250, per tab), a
best-effort total row count in the footer next to the pager, psql
errors surfaced verbatim, session restore on reopen, and a results grid
with real per-column min-widths, horizontal scroll, a pinned header and row
gutter, and drag-resizable columns (double-click a divider to reset).
Clicking a row opens an inspector panel with every value at full length —
long values in resizable textareas, a copy button per field — since the
grid itself truncates by column width. On table views the panel's fields
edit in place: blur stages the change into the same batch as a grid cell
edit, shown amber until Commit, and typing `NULL` back into a staged field
un-stages it. Escape closes the panel (or just the field draft while
editing one).

### SQL editor

Query tabs get a Monaco editor: Postgres highlighting, ⌘↵ to run,
autocomplete fed by the connection's table list plus the active result's
columns, and keywords upper-cased as you finish typing them (the tokenizer
decides what is a keyword, so `select` inside a string, comment or quoted
identifier is left alone). The editor pane is resizable by dragging its
bottom edge; double-click the divider to reset. Monaco is bundled, not
CDN-loaded — the WebView may be offline.

### Editing

Double-click a cell in a table view to edit it; Enter stages, Escape
cancels. Staged cells show amber until committed — nothing reaches the
database before **Commit**. The staged banner's **Review** opens a
right-side panel listing every pending edit grouped by row, each showing
the database value → an editable field, with a control to remove it (which
is just staging the original value back). It shares the right edge with the
row inspector — opening one closes the other.

Commit sends one transaction: all edits to a row collapse into a single
UPDATE, so a multi-column change lands together. Rows are addressed by
primary key when every pk column is on screen, by `ctid` otherwise, and
the predicate always uses the row's *original* values so editing a key
column still matches. The page select rides the same round trip, so the
grid refreshes from the database rather than from local state — which
matters because UPDATE rewrites rows and their ctids change.

A failed commit rolls back and keeps the batch staged, so nothing is
silently lost. Staged edits are dropped when you change page, predicates
or columns, since they address rows that may no longer be in the set —
but they **survive re-sorting**: each edit carries the WHERE that
addresses its row, resolved when it was staged, so it commits correctly
no matter where sorting moves the row. They are also not persisted across
an app restart, deliberately.

Editing is only offered for keyed table views: a join or an expression
has no single row to write back to.

`NULL` and empty string are distinct: a NULL cell shows a dimmed marker,
an empty string shows an empty cell. Editing a NULL cell opens the text
`NULL`, and committing the literal text `NULL` sets the column NULL — the
convention inherited from the native app, now round-trip coherent. It
still means you cannot store the four characters "NULL".

### Query builder

A table tab shows a query builder instead of the SQL editor: a predicate
tree, a column picker, and a live preview of the SQL it produces. Edits
are local until **Apply**; **Edit as SQL** hands the statement (without
the ctid/paging plumbing) to a fresh query tab when the builder runs out
of road — it stops short of joins and aggregates by design, because those
would break row addressing and with it inline editing.

Conditions nest in `and`/`or` groups, so `a AND (b OR c)` is expressible;
operators are `=`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `is null`,
`is not null`. `contains` is `::text ILIKE '%value%'` (case-insensitive,
works on non-text columns); the ordering operators compare in the column's
own type, so `qty > 50` on an integer column is numeric, not
lexicographic. The whole predicate is applied **server-side** in the
table's WHERE clause, so it narrows the real result set — pagination and
row numbers stay honest — and it rides the commit statement's trailing
select, so a row edited out of the filtered set disappears after commit.

The column picker hides columns from the select list (the full column set
is remembered, so a hidden column can always be brought back). Hiding
every column reads as hiding none.

### Sorting

Click a column header to sort by it — asc, desc, then unsorted; shift-click
adds a column to the existing sort, with precedence numbers on the headers.
Ordering is server-side (whole table, not the loaded page), and the primary
key always trails the chosen sort as a tiebreaker, because OFFSET
pagination repeats or skips rows whenever the ordering leaves ties.
Headers are inert on query tabs: a free-form statement has no single table
to re-order and may carry its own ORDER BY.

### Tabs

A tab is a whole document: its own statement or table, result, page
position, page size and staged edits. Nothing is shared between tabs, so a
commit can never land against rows a different tab is showing.

What a tab *is* decides what it shows: a table opened from the rail gets
the query builder, a query tab gets the SQL editor — there is no mode to
switch. Clicking a table that is already open focuses its tab rather than
duplicating it; opening a new table takes over the tab in front of you
only if that tab is untouched, and otherwise opens its own. `+` opens a
blank query tab; the last tab cannot be closed. A tab with staged edits
shows an amber dot, and a filtered table tab carries its condition count
as a badge, so neither pending work nor a narrowed result is ever
invisible from the strip.

### Saved queries

**Save** names the current statement and writes it to `saved_queries` in
the SQLite store; the rail lists them. Opening one always gets its own new
tab rather than overwriting what is in front of you. A tab that came from a
saved query shows **Update** instead of Save and rewrites that row in place
rather than accumulating near-duplicates. Deleting a saved query leaves any
open tab intact, just no longer linked.

## Known limitations

- Results are capped at 8 MiB of client stdout per query; up to that they
  arrive whole (chunked across bridge responses when large), beyond it the
  query fails with a clear message.
- SQLite: an empty table shows a "No rows." state without its column headers —
  the `sqlite3` CLI prints no header for an empty result, unlike psql, so the
  columns are unknown until a row exists. Non-empty tables, filters, sort,
  paging, editing and counts all work.
- SQLite connections are a local file path (`sqlite:<path>`), typed in;
  there is no native file picker yet.
- A NULL marker byte (0x01) distinguishes SQL `NULL` from an empty string.
  A value that genuinely contains a literal 0x01 byte would be misread as
  NULL — the same class of assumption the US/RS framing already makes.
- The literal text `NULL` in a cell edit means SQL NULL, so the four
  characters "NULL" cannot be stored as a string.
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

Feel free to contribute — and fork as much as you want. It's MIT: take it,
bend it into the Postgres browser you actually wanted, no permission
needed. Issues and pull requests are just as welcome. Before opening a PR:

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
