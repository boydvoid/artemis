// Artemis web shell.
//
// The whole UI is React (frontend/), served from frontend/dist in
// production and from the Vite dev server under `zig build dev`. The
// native side owns exactly one capability the browser cannot have:
// running SQL through the PostgreSQL client CLI. React calls it as
//
//     await window.zero.invoke("db.exec", { url, sql })
//     -> { ok, code, out, err }
//
// `out` is raw psql stdout in the same unit/record-separator framing the
// native app used (-A -F <US> -R <RS>), so the TypeScript side keeps
// doing all parsing. This shell stays a dumb pipe on purpose: no SQL is
// built here, and no result is interpreted here.
//
// Queries run OFF the loop thread. `db.exec` and `store.exec` are async
// bridge handlers: the handler copies the request and spawns a worker,
// the worker runs the subprocess and queues the finished response, then
// nudges the platform loop (`services.wake`, the one service any thread
// may call). The loop thread drains the queue on `.effects_wake` and
// completes the bridge there — WebKit only tolerates being spoken to
// from the main thread, so the worker never touches the responder.
const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// psql stdout cap. A page is at most a few hundred rows, but a single
/// text column can be large; 8 MiB is far above any page. Results larger
/// than one bridge response are delivered in chunks (below), so this cap
/// is the honest end of the line, reported as `truncated`.
const max_stdout_bytes: usize = 8 * 1024 * 1024;
const max_stderr_bytes: usize = 64 * 1024;

/// One bridge response is capped at 1 MiB by the SDK (max_response_bytes),
/// and JSON escaping can grow a control byte to six (`US`). So the
/// budget is counted in ESCAPED bytes — 560 KiB of escaped `out` plus a
/// worst-case escaped stderr still fits the envelope. Anything larger is
/// stashed whole and the web layer pulls the rest through `db.chunk`.
const out_escaped_budget: usize = 560 * 1024;

const unit_separator = "\x1f";
const record_separator = "\x1e";

/// What psql prints for SQL NULL (`-P null=`). Text output cannot
/// otherwise distinguish NULL from the empty string — both print as
/// nothing — so NULL gets a marker from the same C0 range the field and
/// record separators already claim. The web layer maps it back; data
/// containing a literal 0x01 would confuse it, the same class of
/// assumption the framing itself already makes.
const null_marker = "\x01";

const ExecPayload = struct {
    url: []const u8,
    sql: []const u8,
    /// Which client to shell out to: "postgres" (psql) or "sqlite" (sqlite3).
    /// Defaults to postgres so a caller that omits it keeps the old behaviour.
    driver: []const u8 = "postgres",
};

const StorePayload = struct {
    sql: []const u8,
};

const ChunkPayload = struct {
    handle: u64,
    offset: u64,
};

/// Where the app's own state lives: saved connections and saved queries,
/// in the same SQLite schema the canvas app used.
///
/// Resolved to the OS application-data directory rather than a CWD-relative
/// path, because the app is launched from several places (`native dev` from
/// web/, the binary directly, a packaged bundle) and a relative path would
/// silently create a different, empty database in each. `ARTEMIS_DB`
/// overrides it — that is how you point this at a shared file.
fn resolveStorePath(env_map: *std.process.Environ.Map, buffer: []u8) []const u8 {
    if (env_map.get("ARTEMIS_DB")) |override| return override;

    const dir = native_sdk.app_dirs.resolveOne(
        .{ .name = "artemis" },
        native_sdk.app_dirs.currentPlatform(),
        .{
            .home = env_map.get("HOME"),
            .xdg_data_home = env_map.get("XDG_DATA_HOME"),
            .local_app_data = env_map.get("LOCALAPPDATA"),
            .app_data = env_map.get("APPDATA"),
        },
        .data,
        buffer,
    ) catch return ".artemis/artemis.db";

    // Append the filename in the same buffer, after the directory.
    const name = "/artemis.db";
    if (dir.len + name.len > buffer.len) return ".artemis/artemis.db";
    @memcpy(buffer[dir.len..][0..name.len], name);
    return buffer[0 .. dir.len + name.len];
}

const More = struct {
    handle: u64,
    next: u64,
    total: u64,
};

const ExecResult = struct {
    ok: bool,
    code: i32,
    out: []const u8,
    err: []const u8,
    truncated: bool = false,
    /// Present when the result did not fit one response: the rest is
    /// stashed under `handle` and fetched through `db.chunk`.
    more: ?More = null,
};

const ChunkResult = struct {
    ok: bool,
    data: []const u8,
    next: u64,
    done: bool,
};

/// Tiny spin lock over `std.atomic.Mutex` (0.16 has no blocking thread
/// mutex outside `Io`). Every guarded section here is a bounded copy or a
/// slot scan — microseconds worst case, never I/O.
const SpinMutex = struct {
    inner: std.atomic.Mutex = .unlocked,

    fn lock(self: *SpinMutex) void {
        while (!self.inner.tryLock()) std.atomic.spinLoopHint();
    }

    fn unlock(self: *SpinMutex) void {
        self.inner.unlock();
    }
};

/// How many raw bytes of `data` fit in `budget` once JSON-escaped.
/// Control bytes cost 6 (`\u00XX`), quote and backslash cost 2, the rest
/// cost 1 — an upper bound, so the fit can only be conservative. The cut
/// backs off any UTF-8 continuation bytes so a chunk never splits a
/// codepoint: std.json refuses to emit invalid UTF-8, and the web layer
/// decodes each chunk independently before concatenating.
fn escapedFit(data: []const u8, budget: usize) usize {
    var cost: usize = 0;
    var index: usize = 0;
    while (index < data.len) : (index += 1) {
        const byte = data[index];
        const step: usize = if (byte == '"' or byte == '\\') 2 else if (byte < 0x20) 6 else 1;
        if (cost + step > budget) break;
        cost += step;
    }
    var end = index;
    while (end > 0 and end < data.len and (data[end] & 0xC0) == 0x80) end -= 1;
    return end;
}

/// Results too large for one response, keyed by handle, waiting for the
/// web layer to pull the rest. Written by worker threads, read and freed
/// by the loop thread (`db.chunk`), so every touch holds the mutex, and
/// all data is page_allocator-owned — the one allocator guaranteed safe
/// across threads.
const Stash = struct {
    const capacity = 4;
    const Entry = struct {
        handle: u64 = 0,
        data: []u8 = &.{},
    };

    mutex: SpinMutex = .{},
    entries: [capacity]Entry = [_]Entry{ .{}, .{}, .{}, .{} },
    next_handle: u64 = 1,

    /// Stash a copy of `data`. When every slot is taken the oldest handle
    /// is evicted — its reader, if any still exists, gets an honest
    /// `ok:false` from `db.chunk` rather than silently missing bytes.
    fn put(self: *Stash, data: []const u8) !u64 {
        const copy = try std.heap.page_allocator.dupe(u8, data);
        self.mutex.lock();
        defer self.mutex.unlock();

        var slot: *Entry = &self.entries[0];
        for (&self.entries) |*entry| {
            if (entry.handle == 0) {
                slot = entry;
                break;
            }
            if (entry.handle < slot.handle) slot = entry;
        }
        if (slot.handle != 0) std.heap.page_allocator.free(slot.data);

        const handle = self.next_handle;
        self.next_handle += 1;
        slot.* = .{ .handle = handle, .data = copy };
        return handle;
    }

    /// One chunk from `offset`, freeing the entry when the read reaches
    /// the end. `ok:false` means the handle is gone (evicted or already
    /// finished) — the web layer must not pretend the result completed.
    fn read(self: *Stash, handle: u64, offset: u64, output: []u8) anyerror![]const u8 {
        self.mutex.lock();
        defer self.mutex.unlock();

        const entry = for (&self.entries) |*candidate| {
            if (candidate.handle == handle) break candidate;
        } else {
            return writeJson(output, ChunkResult{ .ok = false, .data = "", .next = 0, .done = true });
        };

        const data = entry.data;
        const start: usize = @min(@as(usize, @intCast(offset)), data.len);
        const fit = escapedFit(data[start..], out_escaped_budget);
        const end = start + fit;
        const done = end >= data.len;
        const response = try writeJson(output, ChunkResult{
            .ok = true,
            .data = data[start..end],
            .next = end,
            .done = done,
        });
        if (done) {
            std.heap.page_allocator.free(entry.data);
            entry.* = .{};
        }
        return response;
    }
};

/// A finished query waiting for the loop thread. The worker prebuilds the
/// whole response envelope so the drain does nothing but hand bytes over.
const Completion = struct {
    responder: native_sdk.bridge.AsyncResponder,
    response: []u8,
};

const CompletionQueue = struct {
    /// Matches the SDK's async response slot count — there can never be
    /// more in-flight bridge calls than that.
    const capacity = 64;

    mutex: SpinMutex = .{},
    entries: [capacity]?Completion = [_]?Completion{null} ** capacity,

    fn push(self: *CompletionQueue, completion: Completion) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (&self.entries) |*entry| {
            if (entry.* == null) {
                entry.* = completion;
                return;
            }
        }
        return error.CompletionQueueFull;
    }

    /// Move everything out under the lock, respond outside it: responding
    /// walks into platform code, and holding an app mutex across that is
    /// how deadlocks are built.
    fn drain(self: *CompletionQueue) void {
        var pending: [capacity]Completion = undefined;
        var count: usize = 0;
        self.mutex.lock();
        for (&self.entries) |*entry| {
            if (entry.*) |completion| {
                pending[count] = completion;
                count += 1;
                entry.* = null;
            }
        }
        self.mutex.unlock();

        for (pending[0..count]) |completion| {
            completion.responder.respond(completion.response) catch |err| {
                std.debug.print("artemis: bridge respond failed: {s}\n", .{@errorName(err)});
            };
            std.heap.page_allocator.free(completion.response);
        }
    }
};

const JobKind = enum { db, store };

/// Everything a worker needs, copied out of the invocation — the request
/// bytes belong to the platform and die when the handler returns. Owned by
/// page_allocator because it is allocated on the loop thread and freed on
/// the worker.
const Job = struct {
    context: *Context,
    kind: JobKind,
    responder: native_sdk.bridge.AsyncResponder,
    id_storage: [native_sdk.bridge.max_id_bytes]u8 = undefined,
    id_len: usize = 0,
    url: []u8 = &.{},
    sql: []u8 = &.{},
    /// A `db` job against SQLite rather than Postgres. `store` jobs are always
    /// SQLite and ignore this.
    db_sqlite: bool = false,

    fn id(self: *const Job) []const u8 {
        return self.id_storage[0..self.id_len];
    }

    fn destroy(self: *Job) void {
        const allocator = std.heap.page_allocator;
        if (self.url.len > 0) allocator.free(self.url);
        if (self.sql.len > 0) allocator.free(self.sql);
        allocator.destroy(self);
    }
};

fn writeJson(output: []u8, value: anytype) anyerror![]const u8 {
    var writer = std.Io.Writer.fixed(output);
    try std.json.Stringify.value(value, .{}, &writer);
    return writer.buffered();
}

const Context = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    store_path: []const u8,

    completions: CompletionQueue = .{},
    stash: Stash = .{},

    /// Platform services captured at start, as raw fn pointers so this file
    /// need not name the PlatformServices type. `services_context` is the one
    /// context every service fn takes; `wake_fn` is the cross-thread nudge,
    /// `open_dialog_fn` the native file picker.
    services_context: ?*anyopaque = null,
    wake_fn: ?*const fn (?*anyopaque) anyerror!void = null,
    open_dialog_fn: ?*const fn (
        ?*anyopaque,
        native_sdk.OpenDialogOptions,
        []u8,
    ) anyerror!native_sdk.OpenDialogResult = null,

    fn wake(self: *Context) void {
        const wake_fn = self.wake_fn orelse return;
        wake_fn(self.services_context) catch {};
    }

    // ---- async entry points (loop thread; must return fast)

    fn execStart(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
        const self: *Context = @ptrCast(@alignCast(context));
        self.startJob(.db, invocation, responder);
    }

    fn storeStart(context: *anyopaque, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) anyerror!void {
        const self: *Context = @ptrCast(@alignCast(context));
        self.startJob(.store, invocation, responder);
    }

    fn startJob(self: *Context, kind: JobKind, invocation: native_sdk.bridge.Invocation, responder: native_sdk.bridge.AsyncResponder) void {
        const request_id = invocation.request.id;

        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        var url: []const u8 = "";
        var sql: []const u8 = "";
        var db_sqlite = false;
        switch (kind) {
            .db => {
                const parsed = std.json.parseFromSliceLeaky(
                    ExecPayload,
                    arena,
                    invocation.request.payload,
                    .{ .ignore_unknown_fields = true },
                ) catch return respondError(responder, request_id, "invalid payload");
                if (parsed.url.len == 0) return respondError(responder, request_id, "missing url");
                if (parsed.sql.len == 0) return respondError(responder, request_id, "missing sql");
                url = parsed.url;
                sql = parsed.sql;
                db_sqlite = std.mem.eql(u8, parsed.driver, "sqlite");
            },
            .store => {
                const parsed = std.json.parseFromSliceLeaky(
                    StorePayload,
                    arena,
                    invocation.request.payload,
                    .{ .ignore_unknown_fields = true },
                ) catch return respondError(responder, request_id, "invalid payload");
                if (parsed.sql.len == 0) return respondError(responder, request_id, "missing sql");
                sql = parsed.sql;
            },
        }

        const allocator = std.heap.page_allocator;
        const job = allocator.create(Job) catch return respondError(responder, request_id, "out of memory");
        job.* = .{ .context = self, .kind = kind, .responder = responder, .db_sqlite = db_sqlite };
        job.id_len = @min(request_id.len, job.id_storage.len);
        @memcpy(job.id_storage[0..job.id_len], request_id[0..job.id_len]);
        job.url = if (url.len > 0) allocator.dupe(u8, url) catch return failJob(job, "out of memory") else &.{};
        job.sql = allocator.dupe(u8, sql) catch return failJob(job, "out of memory");

        const thread = std.Thread.spawn(.{}, workerMain, .{job}) catch return failJob(job, "could not start a worker thread");
        thread.detach();
    }

    /// A malformed or unstartable call answers inline: the handler runs on
    /// the loop thread, where talking to the WebView is allowed.
    fn respondError(responder: native_sdk.bridge.AsyncResponder, request_id: []const u8, message: []const u8) void {
        var buffer: [1024]u8 = undefined;
        const result = writeJson(&buffer, ExecResult{
            .ok = false,
            .code = -1,
            .out = "",
            .err = message,
        }) catch return;
        responder.success(request_id, result) catch {};
    }

    fn failJob(job: *Job, message: []const u8) void {
        const responder = job.responder;
        var id_storage: [native_sdk.bridge.max_id_bytes]u8 = undefined;
        const id_len = job.id_len;
        @memcpy(id_storage[0..id_len], job.id_storage[0..id_len]);
        job.destroy();
        respondError(responder, id_storage[0..id_len], message);
    }

    // ---- worker thread

    fn workerMain(job: *Job) void {
        const allocator = std.heap.page_allocator;
        var arena_state = std.heap.ArenaAllocator.init(allocator);

        const result = switch (job.kind) {
            .db => runDb(job, arena_state.allocator()),
            .store => runStore(job, arena_state.allocator()),
        };

        const envelope = buildEnvelope(arena_state.allocator(), job.id(), result) catch {
            arena_state.deinit();
            job.destroy();
            return;
        };
        const owned = allocator.dupe(u8, envelope) catch {
            arena_state.deinit();
            job.destroy();
            return;
        };
        arena_state.deinit();

        // The responder and context outlive the job (the responder is a
        // value handle onto an SDK slot); copy them out before freeing it.
        const responder = job.responder;
        const context = job.context;
        job.destroy();

        context.completions.push(.{ .responder = responder, .response = owned }) catch {
            allocator.free(owned);
            return;
        };
        context.wake();
    }

    fn runDb(job: *Job, arena: std.mem.Allocator) ExecResult {
        // Same framing for both clients — US fields, RS records, 0x01 for
        // NULL, a header record — so the TypeScript parser needs no branch.
        // sqlite3: -header to always emit the header, -bail so a failed
        // UPDATE in the commit batch stops before COMMIT (leaving the open
        // transaction to roll back on exit), matching psql's ON_ERROR_STOP.
        const psql_argv = [_][]const u8{
            "psql",             job.url,           "-X",
            "-q",               "-A",              "-F",
            unit_separator,     "-R",              record_separator,
            "-P",               "footer=off",      "-P",
            "null=" ++ null_marker, "-v",          "ON_ERROR_STOP=1",
            "-c",               job.sql,
        };
        // The URL is `sqlite:<path>`; sqlite3 wants the bare path.
        const sqlite_prefix = "sqlite:";
        const path = if (std.mem.startsWith(u8, job.url, sqlite_prefix))
            job.url[sqlite_prefix.len..]
        else
            job.url;
        const sqlite_argv = [_][]const u8{
            "sqlite3",      "-batch",          "-bail",
            "-header",      "-separator",      unit_separator,
            "-newline",     record_separator,  "-nullvalue",
            null_marker,    path,              job.sql,
        };

        const argv: []const []const u8 = if (job.db_sqlite) &sqlite_argv else &psql_argv;
        const missing = if (job.db_sqlite)
            "Could not run sqlite3 - install the SQLite command line tools."
        else
            "Could not run psql - install the PostgreSQL client tools.";

        const started_ms = native_sdk.monotonicMs();
        const run = std.process.run(arena, job.context.io, .{
            .argv = argv,
            .stdout_limit = .limited(max_stdout_bytes),
            .stderr_limit = .limited(max_stderr_bytes),
        }) catch |err| {
            return .{
                .ok = false,
                .code = -1,
                .out = "",
                .err = switch (err) {
                    error.FileNotFound => missing,
                    error.StreamTooLong => "Result exceeds the 8 MiB cap - narrow the query.",
                    else => @errorName(err),
                },
            };
        };
        const spawn_ms = native_sdk.monotonicMs() -| started_ms;

        const exited = run.term == .exited;
        const code: i32 = if (exited) @intCast(run.term.exited) else -1;
        std.debug.print("db.exec[{s}]: {d}ms code={d} stdout={d}B stderr={d}B\n", .{
            if (job.db_sqlite) "sqlite" else "psql",
            spawn_ms,
            code,
            run.stdout.len,
            run.stderr.len,
        });

        const fit = escapedFit(run.stdout, out_escaped_budget);
        if (fit >= run.stdout.len) {
            return .{
                .ok = exited and code == 0,
                .code = code,
                .out = run.stdout,
                .err = run.stderr,
            };
        }

        // Too big for one response: stash the whole thing and send the
        // first chunk with a handle for the rest. Only a failed stash
        // falls back to honest truncation.
        const handle = job.context.stash.put(run.stdout) catch 0;
        return .{
            .ok = exited and code == 0,
            .code = code,
            .out = run.stdout[0..fit],
            .err = run.stderr,
            .truncated = handle == 0,
            .more = if (handle == 0) null else .{
                .handle = handle,
                .next = fit,
                .total = run.stdout.len,
            },
        };
    }

    /// The app's own state, through `sqlite3`. Same contract as `db.exec`:
    /// the web layer sends SQL, gets framed stdout back, and a failing
    /// statement is data rather than a bridge fault.
    fn runStore(job: *Job, arena: std.mem.Allocator) ExecResult {
        // sqlite3 creates the database file but not its directory.
        if (std.fs.path.dirname(job.context.store_path)) |dir| {
            std.Io.Dir.cwd().createDirPath(job.context.io, dir) catch {};
        }

        const run = std.process.run(arena, job.context.io, .{
            .argv = &.{
                "sqlite3",
                "-batch",
                "-separator",
                unit_separator,
                "-newline",
                record_separator,
                job.context.store_path,
                job.sql,
            },
            .stdout_limit = .limited(max_stdout_bytes),
            .stderr_limit = .limited(max_stderr_bytes),
        }) catch |err| {
            return .{
                .ok = false,
                .code = -1,
                .out = "",
                .err = switch (err) {
                    error.FileNotFound => "Could not run sqlite3 - install the SQLite command line tools.",
                    else => @errorName(err),
                },
            };
        };

        const exited = run.term == .exited;
        const code: i32 = if (exited) @intCast(run.term.exited) else -1;
        return .{
            .ok = exited and code == 0,
            .code = code,
            .out = run.stdout,
            .err = run.stderr,
        };
    }

    fn buildEnvelope(arena: std.mem.Allocator, request_id: []const u8, result: ExecResult) ![]const u8 {
        const result_buffer = try arena.alloc(u8, native_sdk.bridge.max_result_bytes);
        const result_json = try writeJson(result_buffer, result);
        const envelope_buffer = try arena.alloc(u8, native_sdk.bridge.max_response_bytes);
        return native_sdk.bridge.writeSuccessResponse(envelope_buffer, request_id, result_json);
    }

    // ---- sync entry point (loop thread; memory only, no subprocess)

    fn chunkRead(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *Context = @ptrCast(@alignCast(context));

        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();

        const parsed = std.json.parseFromSliceLeaky(
            ChunkPayload,
            arena_state.allocator(),
            invocation.request.payload,
            .{ .ignore_unknown_fields = true },
        ) catch return error.InvalidPayload;

        return self.stash.read(parsed.handle, parsed.offset, output);
    }

    /// Open the native file picker for a SQLite database and return the chosen
    /// path. Sync (loop thread) because the panel is a modal that blocks the
    /// UI by design — which is exactly what an async worker must never do.
    /// Cancel, or a platform with no picker, answers `{ "path": null }`.
    fn pickFile(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *Context = @ptrCast(@alignCast(context));
        _ = invocation;

        const open_fn = self.open_dialog_fn orelse
            return writeJson(output, .{ .path = @as(?[]const u8, null) });

        const filters = [_]native_sdk.FileFilter{
            .{ .name = "SQLite database", .extensions = &.{ "db", "sqlite", "sqlite3", "db3" } },
        };
        var path_buffer: [std.fs.max_path_bytes]u8 = undefined;
        const result = open_fn(self.services_context, .{
            .title = "Choose a SQLite database",
            .filters = &filters,
        }, &path_buffer) catch
            return writeJson(output, .{ .path = @as(?[]const u8, null) });

        // Single-selection: `paths` is one path with no separator.
        const chosen: ?[]const u8 = if (result.count > 0 and result.paths.len > 0) result.paths else null;
        return writeJson(output, .{ .path = chosen });
    }
};

const App = struct {
    env_map: *std.process.Environ.Map,
    bridge_context: *Context,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "artemis",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .start_fn = start,
            .event_fn = onEvent,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }

    /// Capture the platform's thread-safe wake service, so workers can
    /// nudge the loop when a query finishes.
    fn start(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        const services = runtime.options.platform.services;
        self.bridge_context.services_context = services.context;
        self.bridge_context.wake_fn = services.wake_fn;
        self.bridge_context.open_dialog_fn = services.show_open_dialog_fn;
    }

    /// `.effects_wake` is the contract: a worker called `wake`, so there
    /// is at least one finished query to hand to the WebView.
    fn onEvent(context: *anyopaque, runtime: *native_sdk.Runtime, event: native_sdk.Event) anyerror!void {
        _ = runtime;
        const self: *@This() = @ptrCast(@alignCast(context));
        switch (event) {
            .effects_wake => self.bridge_context.completions.drain(),
            else => {},
        }
    }
};

/// Must match app.zon's allowed_origins and the dev URL. 5199 rather than
/// Vite's default 5173, which other projects routinely occupy.
const dev_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5199" };

/// Deny-by-default: the bridge is off unless a command is named here, and
/// `db.exec` is reachable only from our own chrome and the dev server.
const bridge_commands = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = "db.exec", .origins = &dev_origins },
    .{ .name = "db.chunk", .origins = &dev_origins },
    .{ .name = "store.exec", .origins = &dev_origins },
    .{ .name = "dialog.pickFile", .origins = &dev_origins },
};

pub fn main(init: std.process.Init) !void {
    var store_path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const store_path = resolveStorePath(init.environ_map, &store_path_buffer);
    std.debug.print("artemis: store {s}\n", .{store_path});

    var context = Context{
        .gpa = init.gpa,
        .io = init.io,
        .store_path = store_path,
    };
    var app = App{ .env_map = init.environ_map, .bridge_context = &context };

    const sync_handlers = [_]native_sdk.BridgeHandler{
        .{ .name = "db.chunk", .context = &context, .invoke_fn = Context.chunkRead },
        .{ .name = "dialog.pickFile", .context = &context, .invoke_fn = Context.pickFile },
    };
    const async_handlers = [_]native_sdk.bridge.AsyncHandler{
        .{ .name = "db.exec", .context = &context, .invoke_fn = Context.execStart },
        .{ .name = "store.exec", .context = &context, .invoke_fn = Context.storeStart },
    };
    const dispatcher = native_sdk.BridgeDispatcher{
        .policy = .{ .enabled = true, .commands = &bridge_commands },
        .registry = .{ .handlers = &sync_handlers },
        .async_registry = .{ .handlers = &async_handlers },
    };

    try runner.runWithOptions(app.app(), .{
        .app_name = "Artemis",
        .window_title = "Artemis",
        .bundle_id = "dev.native_sdk.artemis",
        .icon_path = "assets/icon.png",
        .bridge = dispatcher,
        .security = .{
            .navigation = .{ .allowed_origins = &dev_origins },
        },
    }, init);
}
