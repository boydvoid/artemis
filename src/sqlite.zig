// Native SQLite, linked in — no `sqlite3` binary required.
//
// The app used to shell out to the `sqlite3` CLI for both the user's
// SQLite connections and its own store. That made a core feature depend on
// a tool the user may not have installed, and a `.app` launched from Finder
// often cannot find it anyway (launchd hands it a minimal PATH). macOS ships
// libsqlite3 as a guaranteed OS component, so we link it and call the C API
// directly. Nothing to locate, nothing to install.
//
// The output is byte-compatible with what `sqlite3 -header -separator <US>
// -newline <RS> -nullvalue <0x01>` produced, so the TypeScript parser is
// untouched: record 0 is the header, fields are US-separated, records are
// RS-separated, and a NULL field is the 0x01 marker (distinct from an empty
// string). One deliberate improvement over the CLI: the header row is
// emitted even for a zero-row result — the CLI printed nothing, which is
// what made an empty table render without its columns.

const std = @import("std");

// Framing bytes, matching the constants in main.zig. Kept local so this
// module has no dependency on the caller beyond the linked library.
const US: u8 = 0x1f; // field separator
const RS: u8 = 0x1e; // record separator
const NULL_MARK: u8 = 0x01; // SQL NULL (distinct from empty string)

// ---- libsqlite3 C API (only what we use, declared by hand so there is no
// header-path or @cImport dependency).

const Sqlite3 = opaque {};
const Stmt = opaque {};

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_NULL: c_int = 5;

const SQLITE_OPEN_READWRITE: c_int = 0x00000002;
const SQLITE_OPEN_CREATE: c_int = 0x00000004;

extern fn sqlite3_open_v2(filename: [*:0]const u8, ppDb: *?*Sqlite3, flags: c_int, zVfs: ?[*:0]const u8) c_int;
extern fn sqlite3_close_v2(db: ?*Sqlite3) c_int;
extern fn sqlite3_prepare_v2(db: ?*Sqlite3, zSql: [*]const u8, nByte: c_int, ppStmt: *?*Stmt, pzTail: *?[*]const u8) c_int;
extern fn sqlite3_step(stmt: ?*Stmt) c_int;
extern fn sqlite3_finalize(stmt: ?*Stmt) c_int;
extern fn sqlite3_column_count(stmt: ?*Stmt) c_int;
extern fn sqlite3_column_name(stmt: ?*Stmt, n: c_int) ?[*:0]const u8;
extern fn sqlite3_column_type(stmt: ?*Stmt, n: c_int) c_int;
extern fn sqlite3_column_text(stmt: ?*Stmt, n: c_int) ?[*]const u8;
extern fn sqlite3_column_bytes(stmt: ?*Stmt, n: c_int) c_int;
extern fn sqlite3_errmsg(db: ?*Sqlite3) ?[*:0]const u8;

/// The same shape `runDb`/`runStore` already build an ExecResult from:
/// framed stdout, a process-style exit code (0 = success, non-zero carries
/// the SQLite result code), and an error message. All slices live in the
/// arena passed to `exec`.
pub const Result = struct {
    out: []const u8,
    code: i32,
    err: []const u8,
};

/// Run every statement in `sql` against the database at `db_path`, framing
/// any rows the way the parser expects. Stops at the first failing
/// statement (like the CLI's `-bail`): closing the connection then rolls
/// back any transaction the batch left open, so a half-applied commit is
/// never persisted.
///
/// `emit_header` chooses whether record 0 is a header row of column names:
/// the grid path (`db.exec`) wants it (so an empty result still reports its
/// columns), while the store path parses raw rows and would mistake a
/// header for data — it inherits the header-less CLI framing it was built
/// against.
pub fn exec(arena: std.mem.Allocator, db_path: []const u8, sql: []const u8, emit_header: bool) Result {
    const path_z = arena.dupeZ(u8, db_path) catch return oom();

    var db: ?*Sqlite3 = null;
    const open_rc = sqlite3_open_v2(path_z.ptr, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, null);
    defer _ = sqlite3_close_v2(db);
    if (open_rc != SQLITE_OK) {
        return .{ .out = "", .code = open_rc, .err = errMsg(arena, db) };
    }

    var out: std.ArrayList(u8) = .empty;

    // `prepare_v2` compiles one statement and hands back a pointer to the
    // rest through `tail`; walk the buffer statement by statement so a
    // multi-statement batch (a commit, a script) runs in full.
    var remaining = sql;
    while (remaining.len > 0) {
        var stmt: ?*Stmt = null;
        var tail: ?[*]const u8 = null;
        const rc = sqlite3_prepare_v2(db, remaining.ptr, @intCast(remaining.len), &stmt, &tail);
        if (rc != SQLITE_OK) {
            return .{ .out = out.items, .code = rc, .err = errMsg(arena, db) };
        }
        const consumed = if (tail) |t| @intFromPtr(t) - @intFromPtr(remaining.ptr) else remaining.len;
        remaining = remaining[consumed..];

        // A trailing whitespace or comment tail compiles to no statement.
        const s = stmt orelse continue;
        defer _ = sqlite3_finalize(s);

        const ncol = sqlite3_column_count(s);
        // The header goes out before the first step, so a query with zero
        // rows still reports its columns (the CLI's omission is the bug we
        // are fixing). A non-query (INSERT/UPDATE/…) has no columns and
        // emits nothing, matching the CLI.
        if (emit_header and ncol > 0) {
            var i: c_int = 0;
            while (i < ncol) : (i += 1) {
                if (i > 0) out.append(arena, US) catch return oom();
                if (sqlite3_column_name(s, i)) |name| {
                    out.appendSlice(arena, std.mem.span(name)) catch return oom();
                }
            }
            out.append(arena, RS) catch return oom();
        }

        while (true) {
            const step_rc = sqlite3_step(s);
            if (step_rc == SQLITE_ROW) {
                var i: c_int = 0;
                while (i < ncol) : (i += 1) {
                    if (i > 0) out.append(arena, US) catch return oom();
                    if (sqlite3_column_type(s, i) == SQLITE_NULL) {
                        out.append(arena, NULL_MARK) catch return oom();
                    } else if (sqlite3_column_text(s, i)) |ptr| {
                        const len: usize = @intCast(sqlite3_column_bytes(s, i));
                        out.appendSlice(arena, ptr[0..len]) catch return oom();
                    }
                }
                out.append(arena, RS) catch return oom();
            } else if (step_rc == SQLITE_DONE) {
                break;
            } else {
                return .{ .out = out.items, .code = step_rc, .err = errMsg(arena, db) };
            }
        }
    }

    return .{ .out = out.items, .code = 0, .err = "" };
}

/// SQLite's error string is only valid until the next call on the handle,
/// so copy it into the arena before the deferred close frees it.
fn errMsg(arena: std.mem.Allocator, db: ?*Sqlite3) []const u8 {
    const msg = sqlite3_errmsg(db) orelse return "sqlite error";
    return arena.dupe(u8, std.mem.span(msg)) catch "sqlite error";
}

fn oom() Result {
    return .{ .out = "", .code = -1, .err = "out of memory" };
}
