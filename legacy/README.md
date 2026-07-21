# Artemis

A Postgres database GUI, authored in TypeScript and markup (the
app-core subset, compiled to native code at build time; no JS runtime
ships in the binary). There is no Zig in this tree and nothing to
configure: the build detects `src/core.ts` and wires everything.

The core is modular:

- `src/core.ts` - the app contract: Model, Msg, initialModel, update,
  and the derived view bindings (these must live in the entry file -
  bindings resolve against it, and effect commands may only be built in
  update's own return path).
- `src/types.ts` - shared record types and tuning constants.
- `src/bytes.ts` - byte/draft utilities: separator framing, SQL quoting,
  text-draft helpers.
- `src/db.ts` - the SQLite layer (connections + saved queries).
- `src/pg.ts` - the Postgres layer (catalog, pk discovery, paged data,
  filters, grid parsing, staged-commit SQL).

The view is modular too - real component files with real `<import>`
elements, no generate step:

- `src/view.native` - the view root; imports its components.
- `src/components/*.native` - one `<template>` per file (the grid's
  header, data, and staged cell shapes).

That works because this app **owns its wiring**. The SDK's generated
TypeScript-core wiring passes `.markup = .{ source, watch_path, io }`
with no `.sources`, so an `<import>` resolves against an empty source
set and every frame fails with `MarkupImport`. `src/wiring.zig` is our
copy of that wiring with the import closure declared (`markup_sources`,
marked ARTEMIS in the file); `build.zig` hands it to `addApp` as a
custom `.main`, which makes the build skip core detection - the
documented escape hatch ("builds with a custom `main` entry declared
their core explicitly"), and the only way `src/core.ts` and a Zig
wiring can coexist. In exchange `build.zig` owns the two things the TS
path would have done: transpiling the core (exposed to the wiring as
the `core` module) and importing `app.zon`.

Two consequences worth knowing:

- **Adding a component means two edits**: create
  `src/components/<name>.native`, `<import>` it from `src/view.native`,
  and add its `@embedFile` entry to `markup_sources` in
  `src/wiring.zig`.
- **Hot reload got better**: the markup watch now arms (it never did
  under the generated wiring), so edits to `view.native` *and* its
  components reload in a running `native dev` without a rebuild.
- Keep `src/wiring.zig` in sync with the SDK's `ts_core_main.zig` on
  toolkit upgrades; the deltas are marked ARTEMIS.

## The loop

```sh
native dev --core   # fastest: run the core's logic under node -
                    # dispatch messages as JSON lines, watch the model
                    # and effect transcript (not a renderer)
native dev          # assemble the view, build, and run the real app
native check        # verify core.ts (subset checker) + markup + app.zon
native build        # ReleaseFast binary in zig-out/bin/
native test         # the app's test suite
```

Edit `src/core.ts` for behavior, `src/view.native` and `src/components/` for the view, and
`app.zon` for windows/identity/permissions. Markup binds the model's
field names exactly as core.ts wrote them (`tickCount` -> `{tickCount}`),
and exported single-model helpers bind as derived values (`{total}`).

## Try the core loop

```sh
printf '%s\n' \
  '{"kind":"connection_edit","edit":{"kind":"insert_text","text":{"$bytes":"postgres://bob@localhost:5432/dev"}}}' \
  '{"kind":"save_connection"}' | native dev --core
```

## Configuration & environment

- **Connections**: managed in the app's Connections section (add, edit,
  delete; press a row to make it the query target). Exporting
  `DATABASE_URL` before launch prefills the connection-string field
  (`envMsgs` in `src/core.ts`); saved records always win.
- **Local state**: saved connections persist in a local SQLite database at
  `.artemis/artemis.db`, relative to the process working directory (the
  repo root when launched via `native dev` or `./zig-out/bin/artemis` from
  this directory). The schema initializes automatically on first run via
  the system `sqlite3` CLI (ships with macOS); delete the file to reset.
  All SQLite access is encapsulated in the "Data access" section of
  `src/core.ts` - every operation is one `sqlite3` batch ending in a
  SELECT, so `db_loaded` is the single reload path.
- **Window state**: geometry is restored across launches
  (`restore_state = true` in `app.zon`); first launch centers a
  1100x720 window (min 720x480).
- **Database browsing**: activating a connection loads its schemas and
  tables (via the `psql` CLI - PostgreSQL client tools must be on PATH)
  into a browser sidebar in the Query workspace; selecting a table shows
  a paginated data grid (15 rows per page) that shows **all** of the
  table's columns. Results are stored as a flat, row-major cell list
  (the model tier holds arrays of flat records, not arrays-of-arrays)
  and laid out by the toolkit's grid widget at `columns=N`, so the
  column count is data, not a fixed set of model fields. Very wide
  tables are capped at `MAX_COLUMNS` (48) so a page still fits the
  view's 1024-widget budget.
- **Query builder**: while browsing a table, the filter row builds WHERE
  clauses without SQL - pick a column and operator (=, !=, >, <, >=, <=,
  contains, is null, is not null), enter a value, press Filter. Applied
  filters show as removable chips, combine with AND, re-run from page
  one, and the generated SQL always fills the editor. Values are
  SQL-quoted and identifiers double-quoted by the builder.
- **Editing table data**: in a table tab, click any cell to edit it
  in the edit bar above the grid; Enter (or Stage) stages the change
  locally (staged cells render in the warning color and the staged bar
  counts them). Nothing touches the
  database until Commit, which collapses each row's staged edits into
  one UPDATE, runs them all in one transaction, and refreshes the page.
  Rows are addressed by the table's primary key (discovered when the
  table opens; results are ORDER BY pk, so an edited row stays in place
  after commit); tables without a primary key fall back to ctid
  addressing and ordering. Review lists each change as
  "column: old -> new" with per-change
  unstage; Discard drops them all. A failed commit rolls back entirely,
  keeps every staged change, and surfaces an error banner. Typing the
  literal NULL sets the column NULL. Staged edits are per tab and keyed
  by row identity, so they survive paging. Free-form query results are
  read-only (no stable row identity).
- **Pagination is always on**: table browsing pages at 15 rows, and a
  free-form SELECT (or WITH) run without a LIMIT is automatically
  wrapped as a subquery with LIMIT/OFFSET and gets the same pager.
  Queries with an explicit LIMIT, DML, and multi-statement scripts run
  exactly as written (display capped at 50 rows).
- **Two view types per tab**: a *query tab* (terminal icon) is the SQL
  composer - write SQL, Run (or cmd+enter), Save; a *table tab*
  (document icon) opens when you click a table in the browser - it shows
  the generated SQL read-only with the filter builder and pager instead
  of an editor. Clicking a table focuses its existing tab if one is
  open, reuses a pristine query tab, or opens a new tab - it never
  overwrites query text you typed.
- **Saved queries**: Save in a query tab prompts for a name and stores
  the SQL in the local SQLite database (`saved_queries` table), so they
  survive restarts. They list under SAVED QUERIES in the browser rail:
  click to load into a tab, trash to delete.
- **Query tabs**: the Query workspace holds up to 8 tabs, each with its
  own editor/results/pagination state; the active tab is the highlighted
  one. Free-form results cap at 50 displayed rows. One query runs at a
  time (Run disables while one is in flight; Stop cancels it), but
  switching tabs stays live during a run and the result lands in the tab
  that started it. Closing a tab with unsaved (edited, un-run) query
  text asks for confirmation. Tabs themselves are session-only - saved
  queries and connections are the persistent state. All psql
  access is encapsulated in the "Postgres access" section of
  `src/core.ts`, using the same separator-framed output discipline as
  the SQLite layer.
- **Errors**: shell/runtime errors surface as a dismissible in-app banner
  (the `shell_error` model field), never silently. Handler errors are also
  recorded in the runtime's dispatch-error ring, visible in automation
  snapshots (`dispatch_errors=`).

## Verify a build boots

```sh
native build -Dautomation=true
./zig-out/bin/artemis &
native automate wait
native automate assert 'gpu_nonblank=true' 'role=button name="Save"'
native automate assert --absent 'error event='
```

## Editor support

Stock editor TypeScript just works: `package.json` and `tsconfig.json`
are the editor-and-versioning surface (the tsconfig mirrors the checker's
own options, so editor errors match `native check`), and
`node_modules/@native-sdk/core` is a CLI-managed copy of the SDK package
so `@native-sdk/core` resolves with full IntelliSense. Builds never read
any of it — delete node_modules and every `native` verb still works; the
next `native check`/`dev`/`build` puts it back. Running `npm install`
is optional for the same reason: the CLI materializes and refreshes the
package itself, and an install simply lands the identical content once
`@native-sdk/core` is on npm.

## Requirements

Node.js 22.15+ (on the 23 line: 23.5+) on PATH (the TypeScript-to-native
transpiler runs at build time; your shipped binary carries none of it).
