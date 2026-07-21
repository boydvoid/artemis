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
// Known limitation: bridge handlers dispatch synchronously on the loop
// thread, so a slow query blocks the window until psql returns. Moving
// to the async bridge registry is the fix when that starts to hurt.
const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// psql stdout cap. A page is 16 rows, but a single text column can be
/// large; 8 MiB is far above any page and far below the response cap.
const max_stdout_bytes: usize = 8 * 1024 * 1024;
const max_stderr_bytes: usize = 64 * 1024;

/// Bridge results are capped at 1 MiB by the dispatcher (max_result_bytes)
/// and JSON escaping only grows the payload, so never build a response we
/// know cannot be delivered. Reported honestly as `truncated`.
const max_out_bytes: usize = 700 * 1024;

const unit_separator = "\x1f";
const record_separator = "\x1e";

const ExecPayload = struct {
    url: []const u8,
    sql: []const u8,
};

const StorePayload = struct {
    sql: []const u8,
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

const ExecResult = struct {
    ok: bool,
    code: i32,
    out: []const u8,
    err: []const u8,
    truncated: bool = false,
};

const Context = struct {
    gpa: std.mem.Allocator,
    io: std.Io,
    store_path: []const u8,

    /// The app's own state, through `sqlite3`. Same contract as `db.exec`:
    /// the web layer sends SQL, gets framed stdout back, and a failing
    /// statement is data rather than a bridge fault.
    ///
    /// This is what keeps the web layer stateless — connections live here,
    /// not in the WebView.
    fn storeExec(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *Context = @ptrCast(@alignCast(context));

        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const parsed = std.json.parseFromSliceLeaky(
            StorePayload,
            arena,
            invocation.request.payload,
            .{ .ignore_unknown_fields = true },
        ) catch return error.InvalidPayload;
        if (parsed.sql.len == 0) return error.MissingSql;

        // sqlite3 creates the database file but not its directory.
        if (std.fs.path.dirname(self.store_path)) |dir| {
            std.Io.Dir.cwd().createDirPath(self.io, dir) catch {};
        }

        const run = std.process.run(arena, self.io, .{
            .argv = &.{
                "sqlite3",
                "-batch",
                "-separator",
                unit_separator,
                "-newline",
                record_separator,
                self.store_path,
                parsed.sql,
            },
            .stdout_limit = .limited(max_stdout_bytes),
            .stderr_limit = .limited(max_stderr_bytes),
        }) catch |err| {
            return writeResult(output, .{
                .ok = false,
                .code = -1,
                .out = "",
                .err = switch (err) {
                    error.FileNotFound => "Could not run sqlite3 - install the SQLite command line tools.",
                    else => @errorName(err),
                },
            });
        };

        const exited = run.term == .exited;
        const code: i32 = if (exited) @intCast(run.term.exited) else -1;
        return writeResult(output, .{
            .ok = exited and code == 0,
            .code = code,
            .out = run.stdout,
            .err = run.stderr,
        });
    }

    /// Run one statement through psql and hand the raw framed stdout back
    /// to the web layer. A FAILED query is not a bridge fault: a non-zero
    /// exit comes back as `ok:false` plus stderr so the UI can show the
    /// database's own message. Only malformed calls return an error.
    fn exec(context: *anyopaque, invocation: native_sdk.bridge.Invocation, output: []u8) anyerror![]const u8 {
        const self: *Context = @ptrCast(@alignCast(context));

        var arena_state = std.heap.ArenaAllocator.init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        const parsed = std.json.parseFromSliceLeaky(
            ExecPayload,
            arena,
            invocation.request.payload,
            .{ .ignore_unknown_fields = true },
        ) catch return error.InvalidPayload;

        if (parsed.url.len == 0) return error.MissingUrl;
        if (parsed.sql.len == 0) return error.MissingSql;

        const run = std.process.run(arena, self.io, .{
            .argv = &.{
                "psql",
                parsed.url,
                "-X",
                "-q",
                "-A",
                "-F",
                unit_separator,
                "-R",
                record_separator,
                "-P",
                "footer=off",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                parsed.sql,
            },
            .stdout_limit = .limited(max_stdout_bytes),
            .stderr_limit = .limited(max_stderr_bytes),
        }) catch |err| {
            // psql missing from PATH is the common case, and it is a
            // user-fixable condition rather than a bridge failure.
            return writeResult(output, .{
                .ok = false,
                .code = -1,
                .out = "",
                .err = switch (err) {
                    error.FileNotFound => "Could not run psql - install the PostgreSQL client tools.",
                    else => @errorName(err),
                },
            });
        };

        const exited = run.term == .exited;
        const code: i32 = if (exited) @intCast(run.term.exited) else -1;
        std.debug.print("db.exec: code={d} stdout={d}B stderr={d}B\n", .{ code, run.stdout.len, run.stderr.len });
        const truncated = run.stdout.len > max_out_bytes;
        const out = if (truncated) run.stdout[0..max_out_bytes] else run.stdout;

        return writeResult(output, .{
            .ok = exited and code == 0,
            .code = code,
            .out = out,
            .err = run.stderr,
            .truncated = truncated,
        });
    }

    fn writeResult(output: []u8, result: ExecResult) anyerror![]const u8 {
        var writer = std.Io.Writer.fixed(output);
        try std.json.Stringify.value(result, .{}, &writer);
        return writer.buffered();
    }
};

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "artemis",
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = "frontend/dist",
            .entry = "index.html",
        });
    }
};

/// Must match app.zon's allowed_origins and the dev URL. 5199 rather than
/// Vite's default 5173, which other projects routinely occupy.
const dev_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5199" };

/// Deny-by-default: the bridge is off unless a command is named here, and
/// `db.exec` is reachable only from our own chrome and the dev server.
const bridge_commands = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = "db.exec", .origins = &dev_origins },
    .{ .name = "store.exec", .origins = &dev_origins },
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map };

    var store_path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const store_path = resolveStorePath(init.environ_map, &store_path_buffer);
    std.debug.print("artemis: store {s}\n", .{store_path});

    var context = Context{
        .gpa = init.gpa,
        .io = init.io,
        .store_path = store_path,
    };
    const handlers = [_]native_sdk.BridgeHandler{
        .{ .name = "db.exec", .context = &context, .invoke_fn = Context.exec },
        .{ .name = "store.exec", .context = &context, .invoke_fn = Context.storeExec },
    };
    const dispatcher = native_sdk.BridgeDispatcher{
        .policy = .{ .enabled = true, .commands = &bridge_commands },
        .registry = .{ .handlers = &handlers },
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
