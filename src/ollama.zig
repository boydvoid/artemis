// Native Ollama client — plain HTTP/1.1 over a TCP socket, no libcurl and
// nothing on PATH.
//
// The companion to postgres.zig: where that speaks the Postgres wire
// protocol, this speaks just enough HTTP to reach a local Ollama daemon
// (default http://127.0.0.1:11434). The WebView cannot call Ollama itself —
// its custom `zero://app` origin is rejected by Ollama's CORS, and the
// shell locks navigation down — so, like every other network capability in
// this app, the request is made here.
//
// Two calls are needed:
//   * `tags` — GET /api/tags, the local model list (one JSON blob).
//   * `chat` — POST /api/chat with "stream": true. Ollama answers with
//     `Transfer-Encoding: chunked` and `application/x-ndjson`: one JSON
//     object per line, each carrying a slice of the reply. This decodes the
//     chunks, splits the NDJSON, and hands every delta to a sink as it
//     arrives — that is what makes token-by-token streaming possible.
//
// The sink is deliberately dumb: it copies the delta somewhere thread-safe
// and returns. main.zig owns the queue and the WebView nudge; this file
// owns only the socket.

const std = @import("std");

const Io = std.Io;
const Reader = std.Io.Reader;
const Writer = std.Io.Writer;

const default_host = "127.0.0.1";
const default_port: u16 = 11434;

/// Same shape as postgres.Result / sqlite.Result: `out` is the payload (the
/// tags JSON, or the full concatenated reply text), `code` is 0 on success
/// and non-zero on failure, `err` carries a human message.
pub const Result = struct {
    out: []const u8,
    code: i32,
    err: []const u8,
};

/// Where the deltas go. `emit` is called once per streamed token with the
/// new text; `cancelled` is polled before each chunk so an aborted request
/// stops pulling from the socket. Both run on the worker thread, so both
/// must be quick and thread-safe — no WebView, no blocking.
pub const Sink = struct {
    context: *anyopaque,
    emit: *const fn (context: *anyopaque, delta: []const u8) void,
    cancelled: *const fn (context: *anyopaque) bool,
};

const Endpoint = struct {
    host: []const u8,
    port: u16,
};

/// Case-insensitive substring test — `std.ascii` has no ignore-case
/// `indexOf`, and header values like "gzip, chunked" need a contains check.
fn containsIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    if (needle.len == 0 or needle.len > haystack.len) return needle.len == 0;
    var i: usize = 0;
    while (i + needle.len <= haystack.len) : (i += 1) {
        if (std.ascii.eqlIgnoreCase(haystack[i .. i + needle.len], needle)) return true;
    }
    return false;
}

fn fail(arena: std.mem.Allocator, comptime fmt: []const u8, args: anytype) Result {
    const msg = std.fmt.allocPrint(arena, fmt, args) catch "ollama error";
    return .{ .out = "", .code = -1, .err = msg };
}

fn oom() Result {
    return .{ .out = "", .code = -1, .err = "out of memory" };
}

/// Parse `http://host:port` (or bare `host:port`, or `host`) into its parts.
/// Missing pieces take Ollama's defaults. `https` is accepted syntactically
/// but not implemented — a local daemon is plaintext, and the error is
/// honest rather than a silent plaintext downgrade.
fn parseEndpoint(url: []const u8) !Endpoint {
    var rest = std.mem.trim(u8, url, " \t");
    if (std.mem.startsWith(u8, rest, "http://")) {
        rest = rest["http://".len..];
    } else if (std.mem.startsWith(u8, rest, "https://")) {
        return error.HttpsUnsupported;
    }
    // Drop any path: the endpoint is host:port only.
    if (std.mem.indexOfScalar(u8, rest, '/')) |slash| rest = rest[0..slash];
    if (rest.len == 0) return .{ .host = default_host, .port = default_port };

    if (std.mem.lastIndexOfScalar(u8, rest, ':')) |colon| {
        const host = rest[0..colon];
        const port = std.fmt.parseInt(u16, rest[colon + 1 ..], 10) catch return error.BadPort;
        return .{ .host = if (host.len == 0) default_host else host, .port = port };
    }
    return .{ .host = rest, .port = default_port };
}

// ---- socket ---------------------------------------------------------------

const Conn = struct {
    stream: Io.net.Stream,
    reader: *Reader,
    writer: *Writer,
};

/// Resolve `host` through the OS resolver and connect the first address that
/// answers. Mirrors postgres.zig: getaddrinfo returns one entry per address
/// (v4 and v6), and trying them in turn is what lets a v4-only machine reach
/// a name that also resolves to v6.
fn resolveHost(arena: std.mem.Allocator, host: []const u8, port: u16) ![]Io.net.IpAddress {
    const host_z = try arena.dupeZ(u8, host);

    var hints: std.c.addrinfo = std.mem.zeroes(std.c.addrinfo);
    hints.socktype = std.c.SOCK.STREAM;

    var res: ?*std.c.addrinfo = null;
    if (@intFromEnum(std.c.getaddrinfo(host_z.ptr, null, &hints, &res)) != 0) return error.HostNotFound;
    const head = res orelse return error.HostNotFound;
    defer std.c.freeaddrinfo(head);

    var list: std.ArrayList(Io.net.IpAddress) = .empty;
    var it: ?*std.c.addrinfo = head;
    while (it) |ai| : (it = ai.next) {
        const sa = ai.addr orelse continue;
        if (ai.family == std.c.AF.INET) {
            const sin: *align(1) const std.c.sockaddr.in = @ptrCast(sa);
            try list.append(arena, .{ .ip4 = .{ .bytes = @bitCast(sin.addr), .port = port } });
        } else if (ai.family == std.c.AF.INET6) {
            const sin6: *align(1) const std.c.sockaddr.in6 = @ptrCast(sa);
            try list.append(arena, .{ .ip6 = .{ .port = port, .bytes = sin6.addr } });
        }
    }
    if (list.items.len == 0) return error.HostNotFound;
    return list.items;
}

fn connect(arena: std.mem.Allocator, io: Io, ep: Endpoint) !Conn {
    const addresses = try resolveHost(arena, ep.host, ep.port);
    var stream: Io.net.Stream = undefined;
    var connected = false;
    for (addresses) |addr| {
        stream = addr.connect(io, .{ .mode = .stream }) catch continue;
        connected = true;
        break;
    }
    if (!connected) return error.ConnectionRefused;

    const read_buf = try arena.alloc(u8, 64 * 1024);
    const write_buf = try arena.alloc(u8, 16 * 1024);
    const reader = try arena.create(Io.net.Stream.Reader);
    const writer = try arena.create(Io.net.Stream.Writer);
    reader.* = stream.reader(io, read_buf);
    writer.* = stream.writer(io, write_buf);
    return .{ .stream = stream, .reader = &reader.interface, .writer = &writer.interface };
}

/// Write a request line + headers + optional body and flush. `Connection:
/// close` keeps the response framing simple: whatever is not chunked ends at
/// EOF, so there is no keep-alive length bookkeeping to get wrong.
fn sendRequest(w: *Writer, ep: Endpoint, method: []const u8, path: []const u8, body: []const u8) !void {
    try w.print("{s} {s} HTTP/1.1\r\n", .{ method, path });
    try w.print("Host: {s}:{d}\r\n", .{ ep.host, ep.port });
    try w.writeAll("User-Agent: artemis\r\n");
    try w.writeAll("Accept: application/x-ndjson\r\n");
    if (body.len > 0) {
        try w.writeAll("Content-Type: application/json\r\n");
        try w.print("Content-Length: {d}\r\n", .{body.len});
    }
    try w.writeAll("Connection: close\r\n\r\n");
    if (body.len > 0) try w.writeAll(body);
    try w.flush();
}

const Headers = struct {
    status: u16,
    chunked: bool,
    content_length: ?usize,
};

/// Read the status line and every header up to the blank line. Header
/// slices point into the reader's buffer and die on the next read, so each
/// is consumed (into a bool or an int) before the loop advances.
fn readHeaders(r: *Reader) !Headers {
    const status_line = try r.takeDelimiterInclusive('\n');
    // "HTTP/1.1 200 OK\r\n" — the code is the token after the first space.
    const space = std.mem.indexOfScalar(u8, status_line, ' ') orelse return error.BadStatus;
    const after = status_line[space + 1 ..];
    const end = std.mem.indexOfScalar(u8, after, ' ') orelse after.len;
    const status = std.fmt.parseInt(u16, std.mem.trim(u8, after[0..end], " \r\n"), 10) catch return error.BadStatus;

    var chunked = false;
    var content_length: ?usize = null;
    while (true) {
        const line_raw = try r.takeDelimiterInclusive('\n');
        const line = std.mem.trim(u8, line_raw, " \r\n");
        if (line.len == 0) break; // end of headers
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        const name = std.mem.trim(u8, line[0..colon], " ");
        const value = std.mem.trim(u8, line[colon + 1 ..], " ");
        if (std.ascii.eqlIgnoreCase(name, "transfer-encoding")) {
            if (containsIgnoreCase(value, "chunked")) chunked = true;
        } else if (std.ascii.eqlIgnoreCase(name, "content-length")) {
            content_length = std.fmt.parseInt(usize, value, 10) catch null;
        }
    }
    return .{ .status = status, .chunked = chunked, .content_length = content_length };
}

/// Cap on a single response body / chunk, so a runaway daemon cannot make us
/// allocate without bound. Generous — model lists and replies are small.
const max_body_bytes: usize = 16 * 1024 * 1024;

/// Read the whole body (dechunked). Used by `tags`, where the answer is one
/// JSON object rather than a stream.
fn readWholeBody(arena: std.mem.Allocator, r: *Reader, headers: Headers) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    if (headers.chunked) {
        while (try nextChunk(arena, r, &out)) {}
    } else if (headers.content_length) |len| {
        if (len > max_body_bytes) return error.BodyTooLarge;
        const buf = try arena.alloc(u8, len);
        try r.readSliceAll(buf);
        try out.appendSlice(arena, buf);
    } else {
        // No framing: read to EOF (Connection: close). Reaching the cap
        // (StreamTooLong) keeps what arrived rather than failing the read.
        r.appendRemaining(arena, &out, .limited(max_body_bytes)) catch |err| switch (err) {
            error.StreamTooLong => {},
            else => return err,
        };
    }
    return out.items;
}

/// Read one chunk into `out`, returning false at the terminating 0-chunk.
/// A chunk is `<hex-size>[;ext]\r\n<data>\r\n`.
fn nextChunk(arena: std.mem.Allocator, r: *Reader, out: *std.ArrayList(u8)) !bool {
    const size_line_raw = try r.takeDelimiterInclusive('\n');
    const size_line = std.mem.trim(u8, size_line_raw, " \r\n");
    // A chunk extension (rare) follows a ';'; the size is everything before.
    const semi = std.mem.indexOfScalar(u8, size_line, ';') orelse size_line.len;
    const size = std.fmt.parseInt(usize, size_line[0..semi], 16) catch return error.BadChunkSize;
    if (size == 0) {
        // Trailer section ends with a blank line; discard it.
        _ = r.takeDelimiterInclusive('\n') catch {};
        return false;
    }
    if (size > max_body_bytes or out.items.len + size > max_body_bytes) return error.BodyTooLarge;
    const buf = try arena.alloc(u8, size);
    try r.readSliceAll(buf);
    _ = try r.takeArray(2); // trailing CRLF
    try out.appendSlice(arena, buf);
    return true;
}

// ---- public API -----------------------------------------------------------

/// GET /api/tags. Returns the raw JSON body — the web layer already knows the
/// Ollama shape (`{ "models": [...] }`), so parsing stays on that side.
pub fn tags(arena: std.mem.Allocator, io: Io, url: []const u8) Result {
    const ep = parseEndpoint(url) catch return fail(arena, "invalid Ollama endpoint", .{});
    const conn = connect(arena, io, ep) catch |err|
        return fail(arena, "could not reach Ollama at {s}:{d} ({s})", .{ ep.host, ep.port, @errorName(err) });
    defer conn.stream.close(io);

    sendRequest(conn.writer, ep, "GET", "/api/tags", "") catch |err|
        return fail(arena, "request failed ({s})", .{@errorName(err)});
    const headers = readHeaders(conn.reader) catch |err|
        return fail(arena, "bad response from Ollama ({s})", .{@errorName(err)});
    const body = readWholeBody(arena, conn.reader, headers) catch |err|
        return fail(arena, "could not read the model list ({s})", .{@errorName(err)});
    if (headers.status != 200) {
        return .{ .out = "", .code = @intCast(headers.status), .err = body };
    }
    return .{ .out = body, .code = 0, .err = "" };
}

/// A parsed NDJSON line from /api/chat. Only the fields we act on are named;
/// everything else (timings, model, context) is ignored.
const ChatLine = struct {
    message: ?struct { content: []const u8 = "" } = null,
    done: bool = false,
    @"error": ?[]const u8 = null,
};

/// POST /api/chat with the caller's JSON body (which must set
/// `"stream": true`). Every content delta is handed to `sink.emit` as it
/// decodes; the full concatenated reply is returned in `Result.out` so the
/// caller can persist a complete message. `sink.cancelled` is polled before
/// each chunk, so a stop button ends the pull promptly.
pub fn chat(arena: std.mem.Allocator, io: Io, url: []const u8, body: []const u8, sink: Sink) Result {
    const ep = parseEndpoint(url) catch return fail(arena, "invalid Ollama endpoint", .{});
    const conn = connect(arena, io, ep) catch |err|
        return fail(arena, "could not reach Ollama at {s}:{d} ({s})", .{ ep.host, ep.port, @errorName(err) });
    defer conn.stream.close(io);

    sendRequest(conn.writer, ep, "POST", "/api/chat", body) catch |err|
        return fail(arena, "request failed ({s})", .{@errorName(err)});
    const headers = readHeaders(conn.reader) catch |err|
        return fail(arena, "bad response from Ollama ({s})", .{@errorName(err)});

    // A non-200 has a JSON error body rather than an NDJSON stream.
    if (headers.status != 200) {
        const body_err = readWholeBody(arena, conn.reader, headers) catch "";
        return .{ .out = "", .code = @intCast(headers.status), .err = if (body_err.len > 0) body_err else "Ollama returned an error" };
    }

    var full: std.ArrayList(u8) = .empty;
    // Holds bytes not yet terminated by a newline, carried across chunk
    // boundaries — a JSON object can straddle two chunks.
    var pending: std.ArrayList(u8) = .empty;
    // A short-lived arena for per-line JSON parsing, reset each line so a
    // thousand-token reply does not accumulate a thousand parse trees.
    var line_arena_state = std.heap.ArenaAllocator.init(arena);
    defer line_arena_state.deinit();

    while (true) {
        if (sink.cancelled(sink.context)) break;
        var chunk: std.ArrayList(u8) = .empty;
        const more = nextChunk(arena, conn.reader, &chunk) catch |err| switch (err) {
            error.EndOfStream => break, // server closed after the stream
            else => return .{ .out = full.items, .code = -1, .err = @errorName(err) },
        };
        pending.appendSlice(arena, chunk.items) catch return oom();

        // Drain every complete line now buffered.
        while (std.mem.indexOfScalar(u8, pending.items, '\n')) |nl| {
            const line = std.mem.trim(u8, pending.items[0..nl], " \r\t");
            if (line.len > 0) {
                if (handleLine(line_arena_state.allocator(), line, &full, arena, sink)) |done| {
                    if (done) return .{ .out = full.items, .code = 0, .err = "" };
                } else |_| {}
                _ = line_arena_state.reset(.retain_capacity);
            }
            // Drop the consumed line (plus its newline) from the buffer.
            const rest = pending.items[nl + 1 ..];
            std.mem.copyForwards(u8, pending.items, rest);
            pending.shrinkRetainingCapacity(rest.len);
        }
        if (!more) break;
    }
    return .{ .out = full.items, .code = 0, .err = "" };
}

/// Parse one NDJSON line, emit its content delta, and report whether the
/// stream is finished. Returns error on a malformed line, which the caller
/// simply skips — one bad frame should not abort a good reply.
fn handleLine(
    line_arena: std.mem.Allocator,
    line: []const u8,
    full: *std.ArrayList(u8),
    full_arena: std.mem.Allocator,
    sink: Sink,
) !bool {
    const parsed = try std.json.parseFromSliceLeaky(ChatLine, line_arena, line, .{ .ignore_unknown_fields = true });
    if (parsed.message) |message| {
        if (message.content.len > 0) {
            sink.emit(sink.context, message.content);
            try full.appendSlice(full_arena, message.content);
        }
    }
    return parsed.done;
}
