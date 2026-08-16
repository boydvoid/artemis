// Coding-agent CLIs as a chat backend — Claude Code and Codex, driven as
// child processes.
//
// The companion to ollama.zig. Where that opens a socket to a local daemon,
// this spawns a CLI the user has already signed into and reads its JSON
// event stream. That is the whole point: the subscription lives in the
// CLI's own login (`claude` OAuth, `codex login`), so running the binary is
// what buys access to the model. No API key is involved, and this file
// never sees a credential.
//
// Both CLIs speak newline-delimited JSON on stdout in their headless modes:
//
//   claude -p --output-format stream-json --verbose --include-partial-messages
//     -> {"type":"stream_event","event":{"type":"content_block_delta",
//         "delta":{"type":"text_delta","text":"…"}}}
//        …plus a final {"type":"result",…}. Errors arrive on stdout as JSON
//        too, not on stderr, which is why stderr is simply ignored here.
//
//   codex exec --json
//     -> {"type":"item.updated","item":{"type":"agent_message","text":"…"}}
//        where `text` is CUMULATIVE, so only the new suffix is emitted.
//        Failures arrive as {"type":"turn.failed","error":{"message":…}}.
//
// The prompt goes in on stdin rather than argv: a system prompt carrying a
// whole database schema plus a transcript would otherwise crowd ARG_MAX.
//
// Like ollama.zig, the sink is dumb — it copies a delta somewhere
// thread-safe and returns. main.zig owns the queue and the WebView nudge;
// this file owns only the child process.

const std = @import("std");
const builtin = @import("builtin");

const Io = std.Io;
const Environ = std.process.Environ;

/// Which CLI to drive. Both are optional on the machine — `resolve` reports
/// a missing binary rather than failing at spawn time.
pub const Provider = enum {
    claude,
    codex,

    /// The executable's name on PATH.
    pub fn binaryName(provider: Provider) []const u8 {
        return switch (provider) {
            .claude => "claude",
            .codex => "codex",
        };
    }

    /// How the user signs in, for the "not authenticated" message. The CLI
    /// owns the credential; we only know which command creates it.
    pub fn loginHint(provider: Provider) []const u8 {
        return switch (provider) {
            .claude => "run `claude` in a terminal and sign in",
            .codex => "run `codex login` in a terminal",
        };
    }

    pub fn parse(name: []const u8) ?Provider {
        if (std.mem.eql(u8, name, "claude")) return .claude;
        if (std.mem.eql(u8, name, "codex")) return .codex;
        return null;
    }
};

/// Same shape as ollama.Result / postgres.Result: `out` is the payload,
/// `code` is 0 on success, `err` carries a human message.
pub const Result = struct {
    out: []const u8,
    code: i32,
    err: []const u8,
};

/// Where the deltas go, plus the two callbacks that make a Stop button work.
/// All three run on the worker thread and must be quick and thread-safe.
pub const Sink = struct {
    context: *anyopaque,
    /// One streamed slice of reply text.
    emit: *const fn (context: *anyopaque, delta: []const u8) void,
    /// Polled once per output line, so a stop ends the read loop.
    cancelled: *const fn (context: *anyopaque) bool,
    /// Handed the child's pid right after spawn (0 once it has been
    /// reaped). A line-polled cancel alone is not enough — a model can
    /// think for a minute without printing anything — so the loop thread
    /// signals the process directly.
    pid: *const fn (context: *anyopaque, pid: i32) void,
};

pub const Options = struct {
    provider: Provider,
    /// Absolute path or bare name; see `resolve`.
    binary: []const u8,
    /// Model id understood by that CLI ("opus", "gpt-5", …). Empty means
    /// whatever the CLI itself defaults to.
    model: []const u8 = "",
    /// System prompt. Claude takes it as a flag; Codex has no equivalent,
    /// so the caller has already folded it into `prompt`.
    system: []const u8 = "",
    /// The message to send.
    prompt: []const u8 = "",
    /// A previous Claude session to continue, so a follow-up question does
    /// not resend the schema. Empty starts fresh. Codex ignores this — its
    /// `exec resume` subcommand does not accept `--json`.
    session: []const u8 = "",
    /// Working directory for the child. A neutral directory on purpose: the
    /// CLIs read project files (CLAUDE.md, AGENTS.md, git state) from their
    /// cwd, and none of that belongs in a database chat.
    cwd: []const u8,
};

fn fail(arena: std.mem.Allocator, comptime fmt: []const u8, args: anytype) Result {
    const msg = std.fmt.allocPrint(arena, fmt, args) catch "agent error";
    return .{ .out = "", .code = -1, .err = msg };
}

// ---- binary + environment resolution ---------------------------------------

/// Directories to look in beyond PATH, and to prepend to the child's PATH.
///
/// A windowed app launched from Finder inherits a PATH of roughly
/// `/usr/bin:/bin:/usr/sbin:/sbin` — neither CLI is there, and `codex` is a
/// Node shim whose `#!/usr/bin/env node` also needs a usable PATH. So the
/// well-known install locations are searched explicitly and handed to the
/// child.
fn extraDirs(arena: std.mem.Allocator, env: *const Environ.Map) [][]const u8 {
    var dirs: std.ArrayList([]const u8) = .empty;
    if (env.get("HOME")) |home| {
        const under_home = [_][]const u8{
            ".local/bin",
            ".claude/local",
            ".bun/bin",
            ".deno/bin",
            ".volta/bin",
            ".npm-global/bin",
            ".cargo/bin",
        };
        for (under_home) |suffix| {
            const path = std.fmt.allocPrint(arena, "{s}/{s}", .{ home, suffix }) catch continue;
            dirs.append(arena, path) catch {};
        }
    }
    const system_dirs = [_][]const u8{
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    };
    for (system_dirs) |dir| dirs.append(arena, dir) catch {};
    return dirs.items;
}

fn isExecutable(io: Io, path: []const u8) bool {
    Io.Dir.accessAbsolute(io, path, .{ .execute = true }) catch return false;
    return true;
}

/// Find the CLI. An explicit `override` (the user's own setting) always
/// wins. Otherwise PATH is searched first — the user's own tooling choice —
/// then the well-known locations. A bare name is returned when nothing is
/// found, so `spawn` still gets its chance and the error comes from the OS.
pub fn resolve(
    arena: std.mem.Allocator,
    io: Io,
    env: *const Environ.Map,
    provider: Provider,
    override: []const u8,
) []const u8 {
    if (override.len > 0) return override;
    const name = provider.binaryName();

    if (env.get("PATH")) |path| {
        var it = std.mem.tokenizeScalar(u8, path, ':');
        while (it.next()) |dir| {
            if (dir.len == 0 or dir[0] != '/') continue;
            const candidate = std.fmt.allocPrint(arena, "{s}/{s}", .{ dir, name }) catch continue;
            if (isExecutable(io, candidate)) return candidate;
        }
    }

    for (extraDirs(arena, env)) |dir| {
        const candidate = std.fmt.allocPrint(arena, "{s}/{s}", .{ dir, name }) catch continue;
        if (isExecutable(io, candidate)) return candidate;
    }

    return name;
}

/// Environment variables that would silently route the CLI away from the
/// user's subscription — an API key bills a different account, and the
/// gateway variables point the CLI at another provider entirely. The whole
/// reason to shell out to a signed-in CLI is to use the seat the human
/// already pays for, so these are dropped from the child's environment.
const stripped_vars = [_][]const u8{
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
};

/// The child's environment: ours, minus the credential overrides above,
/// with PATH widened to the places these CLIs actually install to.
fn childEnv(arena: std.mem.Allocator, io: Io, env: *const Environ.Map) ?*Environ.Map {
    const map = arena.create(Environ.Map) catch return null;
    map.* = Environ.Map.init(arena);

    var it = env.iterator();
    outer: while (it.next()) |entry| {
        for (stripped_vars) |name| {
            if (std.mem.eql(u8, entry.key_ptr.*, name)) continue :outer;
        }
        map.put(entry.key_ptr.*, entry.value_ptr.*) catch return null;
    }

    var path: std.ArrayList(u8) = .empty;
    for (extraDirs(arena, env)) |dir| {
        if (!isExecutable(io, dir)) continue;
        if (path.items.len > 0) path.append(arena, ':') catch return null;
        path.appendSlice(arena, dir) catch return null;
    }
    if (env.get("PATH")) |existing| {
        if (path.items.len > 0) path.append(arena, ':') catch return null;
        path.appendSlice(arena, existing) catch return null;
    }
    if (path.items.len > 0) map.put("PATH", path.items) catch return null;

    return map;
}

// ---- availability ----------------------------------------------------------

/// `<binary> --version`, so the UI can say "found, v2.1.233" or "not
/// installed" before the user sends anything. Authentication is deliberately
/// NOT probed: on macOS the Claude credential lives in the login keychain
/// with no readable file, and the only honest check is a real request. An
/// unauthenticated CLI surfaces its own message on the first chat.
pub fn version(gpa: std.mem.Allocator, arena: std.mem.Allocator, io: Io, env: *const Environ.Map, binary: []const u8) Result {
    const result = std.process.run(gpa, io, .{
        .argv = &.{ binary, "--version" },
        .environ_map = childEnv(arena, io, env),
        .stdout_limit = .limited(64 * 1024),
        .stderr_limit = .limited(64 * 1024),
    }) catch |err| return switch (err) {
        // By far the common case, and worth saying plainly: nothing is
        // broken, the CLI just is not installed here.
        error.FileNotFound => fail(arena, "`{s}` was not found", .{binary}),
        else => fail(arena, "could not run {s} ({s})", .{ binary, @errorName(err) }),
    };
    defer gpa.free(result.stdout);
    defer gpa.free(result.stderr);

    const text = std.mem.trim(u8, result.stdout, " \r\n\t");
    switch (result.term) {
        .exited => |code| if (code != 0) {
            return fail(arena, "{s} --version exited with code {d}", .{ binary, code });
        },
        else => return fail(arena, "{s} --version did not exit normally", .{binary}),
    }
    return .{ .out = arena.dupe(u8, text) catch "", .code = 0, .err = "" };
}

// ---- the chat run ----------------------------------------------------------

/// Longest single JSON line we will hold. Claude's session-init event lists
/// every tool, MCP server and skill, so it is routinely tens of kilobytes;
/// a line over the cap is skipped rather than aborting a good reply.
const line_buffer_bytes: usize = 1024 * 1024;

/// Build the argv for one run.
fn buildArgv(arena: std.mem.Allocator, options: Options) !std.ArrayList([]const u8) {
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.append(arena, options.binary);

    switch (options.provider) {
        .claude => {
            try argv.appendSlice(arena, &.{
                "-p",
                "--output-format",
                "stream-json",
                // stream-json in print mode requires --verbose; partial
                // messages are what make it token-by-token rather than
                // message-by-message.
                "--verbose",
                "--include-partial-messages",
                // This is a chat about a database, not a coding session:
                // no MCP servers, no skills, and no tools. Artemis runs its
                // own read-only probes through its own connection, and
                // nothing the model writes may touch a file.
                "--strict-mcp-config",
                "--disable-slash-commands",
                "--disallowed-tools",
                "Bash Edit Write Read Glob Grep Task WebFetch WebSearch NotebookEdit TodoWrite",
            });
            if (options.model.len > 0) try argv.appendSlice(arena, &.{ "--model", options.model });
            // Resuming carries the transcript, so only the new message is
            // sent — but NOT the system prompt: `--resume` alone drops it
            // and the run falls back to Claude Code's own agent prompt,
            // which is how a resumed chat forgets it is looking at a
            // database. The two flags compose, so both go on every turn.
            if (options.session.len > 0) try argv.appendSlice(arena, &.{ "--resume", options.session });
            if (options.system.len > 0) try argv.appendSlice(arena, &.{ "--system-prompt", options.system });
        },
        .codex => {
            try argv.appendSlice(arena, &.{
                "exec",
                "--json",
                // Artemis is not a repository and the model gets no shell
                // here anyway; read-only is the floor, not the ceiling.
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "-C",
                options.cwd,
            });
            if (options.model.len > 0) try argv.appendSlice(arena, &.{ "-m", options.model });
            // `-` reads the prompt from stdin.
            try argv.append(arena, "-");
        },
    }
    return argv;
}

/// What one parsed line did to the stream.
const Progress = struct {
    /// The run finished successfully.
    done: bool = false,
    /// A message that ends the run.
    failure: ?[]const u8 = null,
};

/// Running state threaded through the line parser.
const Stream = struct {
    session: []const u8 = "",
    /// Codex reports the agent message as cumulative text; this is how much
    /// of it has already been emitted, so only the new suffix is streamed.
    emitted: usize = 0,
    /// Which codex item `emitted` refers to.
    item_id: []const u8 = "",
    /// The most recent non-fatal error line (codex retries are reported as
    /// `error` events before the turn actually fails).
    last_error: []const u8 = "",
};

fn objectGet(value: std.json.Value, key: []const u8) ?std.json.Value {
    return switch (value) {
        .object => |obj| obj.get(key),
        else => null,
    };
}

fn stringField(value: std.json.Value, key: []const u8) ?[]const u8 {
    const field = objectGet(value, key) orelse return null;
    return switch (field) {
        .string => |s| s,
        else => null,
    };
}

fn handleClaudeLine(
    arena: std.mem.Allocator,
    value: std.json.Value,
    stream: *Stream,
    sink: Sink,
) Progress {
    if (stringField(value, "session_id")) |id| {
        if (stream.session.len == 0) stream.session = arena.dupe(u8, id) catch "";
    }
    const kind = stringField(value, "type") orelse return .{};

    if (std.mem.eql(u8, kind, "stream_event")) {
        const event = objectGet(value, "event") orelse return .{};
        const event_type = stringField(event, "type") orelse return .{};
        if (!std.mem.eql(u8, event_type, "content_block_delta")) return .{};
        const delta = objectGet(event, "delta") orelse return .{};
        // Only the visible answer streams. `thinking_delta` and
        // `signature_delta` blocks ride the same channel and are not part
        // of the reply.
        const delta_type = stringField(delta, "type") orelse return .{};
        if (!std.mem.eql(u8, delta_type, "text_delta")) return .{};
        if (stringField(delta, "text")) |text| {
            if (text.len > 0) sink.emit(sink.context, text);
        }
        return .{};
    }

    if (std.mem.eql(u8, kind, "result")) {
        const is_error = switch (objectGet(value, "is_error") orelse std.json.Value{ .bool = false }) {
            .bool => |b| b,
            else => false,
        };
        if (!is_error) return .{ .done = true };
        const message = stringField(value, "result") orelse
            stringField(value, "error") orelse
            "the Claude CLI reported an error";
        return .{ .failure = arena.dupe(u8, message) catch "the Claude CLI reported an error" };
    }

    return .{};
}

fn handleCodexLine(
    arena: std.mem.Allocator,
    value: std.json.Value,
    stream: *Stream,
    sink: Sink,
) Progress {
    const kind = stringField(value, "type") orelse return .{};

    if (std.mem.eql(u8, kind, "thread.started")) {
        if (stringField(value, "thread_id")) |id| stream.session = arena.dupe(u8, id) catch "";
        return .{};
    }

    if (std.mem.eql(u8, kind, "item.started") or
        std.mem.eql(u8, kind, "item.updated") or
        std.mem.eql(u8, kind, "item.completed"))
    {
        const item = objectGet(value, "item") orelse return .{};
        const item_type = stringField(item, "type") orelse return .{};
        // Reasoning, command and tool items are not the answer.
        if (!std.mem.eql(u8, item_type, "agent_message")) return .{};
        const text = stringField(item, "text") orelse return .{};

        // `text` is the whole message so far, resent on every update. A new
        // item restarts the count.
        const id = stringField(item, "id") orelse "";
        if (!std.mem.eql(u8, id, stream.item_id)) {
            stream.item_id = arena.dupe(u8, id) catch "";
            stream.emitted = 0;
        }
        if (text.len > stream.emitted) {
            sink.emit(sink.context, text[stream.emitted..]);
            stream.emitted = text.len;
        }
        return .{};
    }

    // Codex reports its retries as `error` events and only gives up with
    // `turn.failed`, so an error line is remembered rather than acted on.
    if (std.mem.eql(u8, kind, "error")) {
        if (stringField(value, "message")) |message| {
            stream.last_error = arena.dupe(u8, message) catch "";
        }
        return .{};
    }

    if (std.mem.eql(u8, kind, "turn.failed")) {
        const detail = objectGet(value, "error");
        const message = if (detail) |d| stringField(d, "message") else null;
        return .{ .failure = arena.dupe(u8, message orelse stream.last_error) catch "the Codex CLI reported an error" };
    }

    if (std.mem.eql(u8, kind, "turn.completed")) return .{ .done = true };

    return .{};
}

/// Spawn the CLI, stream its reply, and return once it exits.
///
/// Reply text rides `sink.emit` as it arrives; `Result.out` carries only a
/// small `{"session":"…"}` envelope, so a long answer never touches the
/// bridge's response budget — the same split ollama.chat uses.
pub fn chat(arena: std.mem.Allocator, io: Io, env: *const Environ.Map, options: Options, sink: Sink) Result {
    const argv = buildArgv(arena, options) catch return fail(arena, "out of memory", .{});

    var child = std.process.spawn(io, .{
        .argv = argv.items,
        .cwd = .{ .path = options.cwd },
        .environ_map = childEnv(arena, io, env),
        .stdin = .pipe,
        .stdout = .pipe,
        // The CLIs report their failures as JSON on stdout (an expired
        // login included), so stderr carries nothing we act on — and
        // ignoring it means no second pipe to drain and no way to deadlock
        // against a full one.
        .stderr = .ignore,
    }) catch |err| return switch (err) {
        error.FileNotFound => fail(
            arena,
            "{s} was not found. Install the {s} CLI, then {s}.",
            .{ options.binary, @tagName(options.provider), options.provider.loginHint() },
        ),
        else => fail(arena, "could not start {s} ({s})", .{ options.binary, @errorName(err) }),
    };

    // Hand the pid up so Stop can signal the process directly: the read
    // below blocks while the model thinks, and polling alone would leave
    // the button dead for as long as that takes.
    if (child.id) |id| sink.pid(sink.context, @intCast(id));
    defer sink.pid(sink.context, 0);

    // The prompt goes in first and stdin is closed, which is what tells both
    // CLIs the input is complete. Safe against a stdout-side stall: neither
    // writes more than a few kilobytes (Claude's init event) before it has
    // read the prompt, well inside the pipe buffer.
    if (child.stdin) |stdin| {
        var stdin_buffer: [16 * 1024]u8 = undefined;
        var writer = stdin.writerStreaming(io, &stdin_buffer);
        writer.interface.writeAll(options.prompt) catch {};
        writer.interface.flush() catch {};
        stdin.close(io);
        child.stdin = null;
    }

    var stream = Stream{};
    var progress = Progress{};

    if (child.stdout) |stdout| {
        const buffer = arena.alloc(u8, line_buffer_bytes) catch {
            child.kill(io);
            return fail(arena, "out of memory", .{});
        };
        var file_reader = stdout.readerStreaming(io, buffer);
        const reader = &file_reader.interface;

        // One arena per line: a long reply is thousands of events, and each
        // parse tree dies with the line that produced it.
        var line_arena_state = std.heap.ArenaAllocator.init(arena);
        defer line_arena_state.deinit();

        read: while (true) {
            if (sink.cancelled(sink.context)) break;
            const line = reader.takeDelimiter('\n') catch |err| switch (err) {
                // A line longer than the buffer: drop what is held and
                // resynchronise on the next newline rather than losing the
                // whole reply to one oversized event.
                error.StreamTooLong => {
                    reader.tossBuffered();
                    continue :read;
                },
                error.ReadFailed => break :read,
            } orelse break;

            const trimmed = std.mem.trim(u8, line, " \r\t");
            if (trimmed.len == 0) continue;

            const value = std.json.parseFromSliceLeaky(
                std.json.Value,
                line_arena_state.allocator(),
                trimmed,
                .{},
                // A line we cannot parse is one event lost, not a failed
                // reply; both CLIs also print the odd non-JSON notice.
            ) catch {
                _ = line_arena_state.reset(.retain_capacity);
                continue;
            };

            progress = switch (options.provider) {
                .claude => handleClaudeLine(arena, value, &stream, sink),
                .codex => handleCodexLine(arena, value, &stream, sink),
            };
            _ = line_arena_state.reset(.retain_capacity);
            if (progress.done or progress.failure != null) break;
        }
    }

    // Draining stdout is not the same as the child being gone; wait reaps it
    // (and a cancel has already signalled it, so this returns promptly).
    const term = child.wait(io) catch {
        child.kill(io);
        return sessionResult(arena, stream.session, 0, "");
    };
    // Unpublish immediately rather than leaving it to the deferred clear:
    // a reaped pid can be handed to another process, and a Stop arriving in
    // that window must not signal a stranger.
    sink.pid(sink.context, 0);

    if (progress.failure) |message| {
        return sessionResult(arena, stream.session, -1, withLoginHint(arena, options.provider, message));
    }

    switch (term) {
        .exited => |code| if (code != 0 and !progress.done) {
            // Cancelled runs exit non-zero by design; that is not an error.
            if (sink.cancelled(sink.context)) return sessionResult(arena, stream.session, 0, "");
            const detail = if (stream.last_error.len > 0)
                stream.last_error
            else
                std.fmt.allocPrint(
                    arena,
                    "the {s} CLI exited with code {d}. If it is not signed in, {s}.",
                    .{ @tagName(options.provider), code, options.provider.loginHint() },
                ) catch "the CLI exited with an error";
            return sessionResult(arena, stream.session, -1, detail);
        },
        // A signalled child is the Stop button doing its job.
        else => {},
    }

    return sessionResult(arena, stream.session, 0, "");
}

/// A CLI reports an expired login in its own words — Codex says "Failed to
/// refresh token: 401 Unauthorized", which is true but leaves the user with
/// nowhere to go. When the failure reads like an auth problem, the fix is
/// appended; every other error is passed through untouched.
fn withLoginHint(arena: std.mem.Allocator, provider: Provider, message: []const u8) []const u8 {
    const markers = [_][]const u8{
        "401",
        "Unauthorized",
        "unauthorized",
        "authenticate",
        "Authentication",
        "authentication",
        "not logged in",
        "log in",
        "login",
        "credentials",
        "OAuth",
    };
    for (markers) |marker| {
        if (std.mem.indexOf(u8, message, marker) != null) {
            return std.fmt.allocPrint(arena, "{s} — {s}.", .{
                std.mem.trimEnd(u8, message, ". "),
                provider.loginHint(),
            }) catch message;
        }
    }
    return message;
}

/// The bridge payload: just the session handle, so a follow-up question can
/// continue the conversation instead of resending the schema.
fn sessionResult(arena: std.mem.Allocator, session: []const u8, code: i32, err: []const u8) Result {
    var buffer: [256]u8 = undefined;
    var writer = std.Io.Writer.fixed(&buffer);
    std.json.Stringify.value(.{ .session = session }, .{}, &writer) catch
        return .{ .out = "", .code = code, .err = err };
    return .{ .out = arena.dupe(u8, writer.buffered()) catch "", .code = code, .err = err };
}

/// Ask the operating system to stop a running CLI. Called from the loop
/// thread when Stop is pressed; the worker then sees stdout end.
pub fn signalStop(pid: i32) void {
    if (builtin.os.tag == .windows) return;
    std.posix.kill(@intCast(pid), .TERM) catch {};
}
