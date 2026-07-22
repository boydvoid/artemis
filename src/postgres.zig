// Native Postgres, speaking the v3 wire protocol — no `psql` binary.
//
// The companion to sqlite.zig: where that links libsqlite3, this talks the
// PostgreSQL frontend/backend protocol directly over a TCP socket, so a
// Postgres connection needs nothing installed and nothing on PATH. The
// output is the same US/RS/0x01 framing psql produced (header record 0,
// US-separated fields, RS-separated records, 0x01 for NULL), so the
// TypeScript parser is untouched.
//
// Scope: the simple query protocol (one round trip per db.exec), TLS with
// the sslmode the URL asks for, and the auth methods a real server hands
// out — trust, cleartext, MD5, and SCRAM-SHA-256 (the modern default). All
// crypto is std: HMAC-SHA256, SHA-256, PBKDF2, MD5.

const std = @import("std");

const Io = std.Io;
const Reader = std.Io.Reader;
const Writer = std.Io.Writer;
const HmacSha256 = std.crypto.auth.hmac.sha2.HmacSha256;
const Sha256 = std.crypto.hash.sha2.Sha256;
const Md5 = std.crypto.hash.Md5;

const US: u8 = 0x1f;
const RS: u8 = 0x1e;
const NULL_MARK: u8 = 0x01;

const protocol_version: u32 = 196608; // 3.0
const default_port: u16 = 5432;

/// Same shape as sqlite.Result, so `runDb` frames both engines identically.
pub const Result = struct {
    out: []const u8,
    code: i32,
    err: []const u8,
};

fn fail(arena: std.mem.Allocator, comptime fmt: []const u8, args: anytype) Result {
    const msg = std.fmt.allocPrint(arena, fmt, args) catch "postgres error";
    return .{ .out = "", .code = -1, .err = msg };
}

fn oom() Result {
    return .{ .out = "", .code = -1, .err = "out of memory" };
}

/// Connect, authenticate, run `sql`, and frame the rows. A failing
/// statement comes back as `code = 1` with the server's message in `err`,
/// like psql's ON_ERROR_STOP — the caller treats that as data, not a fault.
pub fn exec(arena: std.mem.Allocator, io: Io, url: []const u8, sql: []const u8) Result {
    var conn = parseUrl(arena, url) catch return fail(arena, "could not parse the connection URL", .{});

    // Resolve the host through the OS resolver (std's IpAddress.resolve only
    // parses literal addresses — it cannot look up a name like a cloud host),
    // then try each returned address until one connects. A name commonly
    // resolves to several addresses (and both IPv4 and IPv6); trying them in
    // turn is what makes a machine with no IPv6 route still connect.
    const addresses = resolveHost(arena, conn.host, conn.port) catch |err|
        return fail(arena, "could not resolve {s} ({s})", .{ conn.host, @errorName(err) });
    var stream: Io.net.Stream = undefined;
    var connect_err: anyerror = error.HostNotFound;
    var connected = false;
    for (addresses) |addr| {
        stream = addr.connect(io, .{ .mode = .stream }) catch |err| {
            connect_err = err;
            continue;
        };
        connected = true;
        break;
    }
    if (!connected) return fail(arena, "could not connect to {s}:{d} ({s})", .{ conn.host, conn.port, @errorName(connect_err) });
    defer stream.close(io);

    const sock_read_buf = arena.alloc(u8, 64 * 1024) catch return oom();
    const sock_write_buf = arena.alloc(u8, 64 * 1024) catch return oom();
    var sock_reader = stream.reader(io, sock_read_buf);
    var sock_writer = stream.writer(io, sock_write_buf);

    var pg = Pg{
        .arena = arena,
        .io = io,
        .r = &sock_reader.interface,
        .w = &sock_writer.interface,
        // The socket writer is the wire: the TLS layer only buffers ciphertext
        // into it, so this is what must be flushed for bytes to leave.
        .transport = &sock_writer.interface,
    };

    // ---- TLS (sslmode). A single SSLRequest byte tells us whether the
    // server speaks it; the handshake then swaps pg.r/pg.w to the encrypted
    // streams while transport stays the raw socket writer.
    if (conn.sslmode != .disable) {
        pg.establishTls(&conn) catch |err| switch (err) {
            error.SslDeclined => if (conn.sslmode == .require or conn.sslmode == .verify_ca or conn.sslmode == .verify_full)
                return fail(arena, "the server does not support SSL, but sslmode requires it", .{})
            else {}, // prefer: fall through on plaintext
            else => return fail(arena, "TLS handshake failed ({s})", .{@errorName(err)}),
        };
    }

    // ---- Startup + authentication.
    pg.startup(&conn) catch |err| return fail(arena, "startup failed ({s})", .{@errorName(err)});
    pg.authenticate(&conn) catch |err| switch (err) {
        error.AuthFailed => return .{ .out = "", .code = 1, .err = conn.auth_error orelse "authentication failed" },
        else => return fail(arena, "authentication failed ({s})", .{@errorName(err)}),
    };

    // Drain to the first ReadyForQuery (ParameterStatus/BackendKeyData).
    pg.waitReady() catch |err| return fail(arena, "connection setup failed ({s})", .{@errorName(err)});

    // ---- Simple query. One Query message; frame everything the server
    // sends back until ReadyForQuery.
    return pg.runQuery(sql);
}

// ---- connection parameters -------------------------------------------------

const SslMode = enum { disable, prefer, require, verify_ca, verify_full };

const Conn = struct {
    host: []const u8,
    port: u16,
    user: []const u8,
    password: []const u8,
    database: []const u8,
    sslmode: SslMode,
    /// Filled in when the server rejects auth, so the caller can report it.
    auth_error: ?[]const u8 = null,
};

/// Parse `postgres://user:password@host:port/dbname?sslmode=...`. Missing
/// pieces take the conventional defaults (port 5432, database = user,
/// sslmode = prefer, matching libpq).
fn parseUrl(arena: std.mem.Allocator, url: []const u8) !Conn {
    var rest = url;
    inline for (.{ "postgresql://", "postgres://" }) |scheme| {
        if (std.mem.startsWith(u8, rest, scheme)) {
            rest = rest[scheme.len..];
            break;
        }
    }

    // Split off ?query.
    var query: []const u8 = "";
    if (std.mem.indexOfScalar(u8, rest, '?')) |q| {
        query = rest[q + 1 ..];
        rest = rest[0..q];
    }

    // Split authority/path on the FIRST '/', so the database name is whatever
    // follows the authority.
    var authority = rest;
    var database: []const u8 = "";
    if (std.mem.indexOfScalar(u8, rest, '/')) |slash| {
        authority = rest[0..slash];
        database = rest[slash + 1 ..];
    }

    // userinfo@hostinfo — take the LAST '@' as the split so an '@' inside a
    // (percent-encoded) password does not confuse the host.
    var userinfo: []const u8 = "";
    var hostinfo = authority;
    if (std.mem.lastIndexOfScalar(u8, authority, '@')) |at| {
        userinfo = authority[0..at];
        hostinfo = authority[at + 1 ..];
    }

    var user: []const u8 = "";
    var password: []const u8 = "";
    if (std.mem.indexOfScalar(u8, userinfo, ':')) |colon| {
        user = try percentDecode(arena, userinfo[0..colon]);
        password = try percentDecode(arena, userinfo[colon + 1 ..]);
    } else {
        user = try percentDecode(arena, userinfo);
    }

    var host: []const u8 = "localhost";
    var port: u16 = default_port;
    if (hostinfo.len > 0) {
        if (std.mem.lastIndexOfScalar(u8, hostinfo, ':')) |colon| {
            host = hostinfo[0..colon];
            port = std.fmt.parseInt(u16, hostinfo[colon + 1 ..], 10) catch default_port;
        } else {
            host = hostinfo;
        }
    }

    if (user.len == 0) return error.MissingUser;
    if (database.len == 0) database = user;

    var sslmode: SslMode = .prefer;
    var it = std.mem.splitScalar(u8, query, '&');
    while (it.next()) |pair| {
        if (std.mem.indexOfScalar(u8, pair, '=')) |eq| {
            if (std.mem.eql(u8, pair[0..eq], "sslmode")) {
                sslmode = parseSslMode(pair[eq + 1 ..]) orelse sslmode;
            }
        }
    }

    return .{
        .host = host,
        .port = port,
        .user = user,
        .password = password,
        .database = try percentDecode(arena, database),
        .sslmode = sslmode,
    };
}

fn parseSslMode(value: []const u8) ?SslMode {
    if (std.mem.eql(u8, value, "disable")) return .disable;
    if (std.mem.eql(u8, value, "allow")) return .prefer;
    if (std.mem.eql(u8, value, "prefer")) return .prefer;
    if (std.mem.eql(u8, value, "require")) return .require;
    if (std.mem.eql(u8, value, "verify-ca")) return .verify_ca;
    if (std.mem.eql(u8, value, "verify-full")) return .verify_full;
    return null;
}

fn percentDecode(arena: std.mem.Allocator, s: []const u8) ![]const u8 {
    if (std.mem.indexOfScalar(u8, s, '%') == null) return s;
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < s.len) : (i += 1) {
        if (s[i] == '%' and i + 2 < s.len) {
            const hi = std.fmt.charToDigit(s[i + 1], 16) catch {
                try out.append(arena, s[i]);
                continue;
            };
            const lo = std.fmt.charToDigit(s[i + 2], 16) catch {
                try out.append(arena, s[i]);
                continue;
            };
            try out.append(arena, @as(u8, hi) * 16 + lo);
            i += 2;
        } else {
            try out.append(arena, s[i]);
        }
    }
    return out.items;
}

/// Resolve a host (name or literal) to its addresses via the OS resolver.
/// libc's `getaddrinfo` handles DNS, `/etc/hosts`, and IPv4/IPv6 literals
/// alike; we translate each result into the std address type. Blocking, but
/// this runs on a worker thread.
fn resolveHost(arena: std.mem.Allocator, host: []const u8, port: u16) ![]Io.net.IpAddress {
    const host_z = try arena.dupeZ(u8, host);

    var hints: std.c.addrinfo = std.mem.zeroes(std.c.addrinfo);
    hints.socktype = std.c.SOCK.STREAM; // one entry per address, not per socket type

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
            // sin.addr is the 4 octets in network order; its memory is exactly
            // Ip4Address.bytes. The port comes from the URL, not the lookup.
            try list.append(arena, .{ .ip4 = .{ .bytes = @bitCast(sin.addr), .port = port } });
        } else if (ai.family == std.c.AF.INET6) {
            const sin6: *align(1) const std.c.sockaddr.in6 = @ptrCast(sa);
            try list.append(arena, .{ .ip6 = .{ .port = port, .bytes = sin6.addr } });
        }
    }
    if (list.items.len == 0) return error.HostNotFound;
    return list.items;
}

/// True when `host` is a numeric IPv4/IPv6 literal rather than a name.
fn isIpLiteral(host: []const u8) bool {
    if (Io.net.IpAddress.parseIp4(host, 0)) |_| return true else |_| {}
    if (Io.net.IpAddress.parseIp6(host, 0)) |_| return true else |_| {}
    return false;
}

// ---- the connection --------------------------------------------------------

const Msg = struct { type: u8, payload: []u8 };

/// One connection's protocol I/O. `w` is the stream writes go to (the socket
/// writer, or the TLS plaintext writer once encrypted); `transport` is always
/// the socket writer, because flushing the TLS layer only stages ciphertext
/// there — the bytes reach the wire when `transport` itself is flushed.
const Pg = struct {
    arena: std.mem.Allocator,
    io: Io,
    r: *Reader,
    w: *Writer,
    transport: *Writer,
    tls: ?*std.crypto.tls.Client = null,

    fn flush(pg: *Pg) !void {
        try pg.w.flush();
        if (pg.transport != pg.w) try pg.transport.flush();
    }

    /// Send a typed frontend message: [type][int32 length incl. self][payload].
    fn send(pg: *Pg, type_byte: u8, payload: []const u8) !void {
        var hdr: [5]u8 = undefined;
        hdr[0] = type_byte;
        std.mem.writeInt(u32, hdr[1..5], @intCast(4 + payload.len), .big);
        try pg.w.writeAll(&hdr);
        try pg.w.writeAll(payload);
        try pg.flush();
    }

    /// Read one backend message. Payloads go on the arena so a DataRow larger
    /// than the socket buffer is still whole.
    fn recv(pg: *Pg) !Msg {
        const type_byte = try pg.r.takeByte();
        const len_bytes = try pg.r.takeArray(4);
        const len = std.mem.readInt(u32, len_bytes, .big);
        if (len < 4) return error.ProtocolError;
        const payload = try pg.arena.alloc(u8, len - 4);
        try pg.r.readSliceAll(payload);
        return .{ .type = type_byte, .payload = payload };
    }

    /// Negotiate TLS. Sends SSLRequest on the raw socket; if the server
    /// answers 'S', runs the handshake and points r/w at the encrypted
    /// streams. `error.SslDeclined` ('N') is left for the caller to judge.
    fn establishTls(pg: *Pg, conn: *const Conn) !void {
        var req: [8]u8 = undefined;
        std.mem.writeInt(u32, req[0..4], 8, .big);
        std.mem.writeInt(u32, req[4..8], 80877103, .big); // SSLRequest magic
        try pg.transport.writeAll(&req);
        try pg.transport.flush();

        if (try pg.r.takeByte() != 'S') return error.SslDeclined;

        var entropy: [512]u8 = undefined;
        pg.io.random(&entropy);

        const Options = std.crypto.tls.Client.Options;
        const verify_ca = conn.sslmode == .verify_ca or conn.sslmode == .verify_full;

        // SNI must be sent for a name-based host: cloud Postgres routes the
        // connection on it (PlanetScale, Neon, Supabase pooler), so without it
        // the handshake reaches the wrong backend or none. The std TLS client
        // only sends SNI when a host is given — which also turns on host-name
        // verification — so send the host for any DNS name, or when the mode
        // explicitly verifies it. A real cloud certificate is valid for its
        // hostname, so that check passes. A bare IP (typically a local server)
        // sends neither, matching libpq's `require`, which verifies nothing.
        const send_host = !isIpLiteral(conn.host) or conn.sslmode == .verify_full;
        const host_opt: @FieldType(Options, "host") = if (send_host)
            .{ .explicit = conn.host }
        else
            .no_verification;

        var ca_opt: @FieldType(Options, "ca") = .no_verification;
        if (verify_ca) {
            const bundle = try pg.arena.create(std.crypto.Certificate.Bundle);
            bundle.* = .empty;
            try bundle.rescan(pg.arena, pg.io, Io.Timestamp.now(pg.io, .real));
            const lock = try pg.arena.create(Io.RwLock);
            lock.* = .init;
            ca_opt = .{ .bundle = .{ .gpa = pg.arena, .io = pg.io, .lock = lock, .bundle = bundle } };
        }

        const client = try pg.arena.create(std.crypto.tls.Client);
        client.* = try std.crypto.tls.Client.init(pg.r, pg.transport, .{
            .host = host_opt,
            .ca = ca_opt,
            .read_buffer = try pg.arena.alloc(u8, 64 * 1024),
            .write_buffer = try pg.arena.alloc(u8, 64 * 1024),
            .entropy = entropy[0..Options.entropy_len],
            .realtime_now = Io.Timestamp.now(pg.io, .real),
        });
        pg.tls = client;
        pg.r = &client.reader;
        pg.w = &client.writer;
    }

    // ---- startup + auth

    fn startup(pg: *Pg, conn: *const Conn) !void {
        var payload: std.ArrayList(u8) = .empty;
        var head: [4]u8 = undefined;
        std.mem.writeInt(u32, &head, protocol_version, .big);
        try payload.appendSlice(pg.arena, &head);
        try appendParam(pg.arena, &payload, "user", conn.user);
        try appendParam(pg.arena, &payload, "database", conn.database);
        try appendParam(pg.arena, &payload, "application_name", "artemis");
        try appendParam(pg.arena, &payload, "client_encoding", "UTF8");
        try payload.append(pg.arena, 0); // params terminator

        // StartupMessage has no type byte: [int32 length incl. self][payload].
        var hdr: [4]u8 = undefined;
        std.mem.writeInt(u32, &hdr, @intCast(4 + payload.items.len), .big);
        try pg.w.writeAll(&hdr);
        try pg.w.writeAll(payload.items);
        try pg.flush();
    }

    fn authenticate(pg: *Pg, conn: *Conn) !void {
        while (true) {
            const msg = try pg.recv();
            switch (msg.type) {
                'R' => {
                    const kind = std.mem.readInt(u32, msg.payload[0..4], .big);
                    switch (kind) {
                        0 => return, // AuthenticationOk
                        3 => try pg.sendPassword(conn.password), // cleartext
                        5 => try pg.sendMd5(conn, msg.payload[4..]), // MD5 + 4-byte salt
                        10 => try pg.scram(conn, msg.payload[4..]), // SASL
                        else => return error.UnsupportedAuth,
                    }
                },
                'E' => {
                    conn.auth_error = try errorText(pg.arena, msg.payload);
                    return error.AuthFailed;
                },
                else => return error.ProtocolError,
            }
        }
    }

    fn sendPassword(pg: *Pg, password: []const u8) !void {
        const token = try std.fmt.allocPrint(pg.arena, "{s}\x00", .{password});
        try pg.send('p', token);
    }

    fn sendMd5(pg: *Pg, conn: *const Conn, salt: []const u8) !void {
        // md5(md5(password + user) + salt), prefixed with "md5".
        var inner: [16]u8 = undefined;
        var h1 = Md5.init(.{});
        h1.update(conn.password);
        h1.update(conn.user);
        h1.final(&inner);
        const inner_hex = std.fmt.bytesToHex(inner, .lower);

        var outer: [16]u8 = undefined;
        var h2 = Md5.init(.{});
        h2.update(&inner_hex);
        h2.update(salt);
        h2.final(&outer);
        const outer_hex = std.fmt.bytesToHex(outer, .lower);

        const token = try std.fmt.allocPrint(pg.arena, "md5{s}\x00", .{outer_hex});
        try pg.send('p', token);
    }

    // ---- SCRAM-SHA-256

    fn scram(pg: *Pg, conn: *Conn, initial: []const u8) !void {
        const arena = pg.arena;
        // We require SCRAM-SHA-256 without channel binding.
        if (std.mem.indexOf(u8, initial, "SCRAM-SHA-256") == null) return error.UnsupportedAuth;

        // Client nonce: 18 random bytes, base64 (printable, comma-free).
        var nonce_raw: [18]u8 = undefined;
        pg.io.random(&nonce_raw);
        const client_nonce = try b64Encode(arena, &nonce_raw);

        const client_first_bare = try std.fmt.allocPrint(arena, "n=,r={s}", .{client_nonce});
        const client_first = try std.fmt.allocPrint(arena, "n,,{s}", .{client_first_bare});

        // SASLInitialResponse: mechanism, int32 length of response, response.
        {
            var payload: std.ArrayList(u8) = .empty;
            try payload.appendSlice(arena, "SCRAM-SHA-256");
            try payload.append(arena, 0);
            var len_bytes: [4]u8 = undefined;
            std.mem.writeInt(u32, &len_bytes, @intCast(client_first.len), .big);
            try payload.appendSlice(arena, &len_bytes);
            try payload.appendSlice(arena, client_first);
            try pg.send('p', payload.items);
        }

        // AuthenticationSASLContinue (R, 11): server-first-message.
        const cont = try pg.recv();
        if (cont.type == 'E') {
            conn.auth_error = try errorText(arena, cont.payload);
            return error.AuthFailed;
        }
        if (cont.type != 'R' or std.mem.readInt(u32, cont.payload[0..4], .big) != 11) return error.ProtocolError;
        const server_first = cont.payload[4..];

        const combined_nonce = (try scramField(server_first, 'r')) orelse return error.ProtocolError;
        const salt_b64 = (try scramField(server_first, 's')) orelse return error.ProtocolError;
        const iter_str = (try scramField(server_first, 'i')) orelse return error.ProtocolError;
        if (!std.mem.startsWith(u8, combined_nonce, client_nonce)) return error.ProtocolError;
        const iterations = try std.fmt.parseInt(u32, iter_str, 10);
        const salt = try b64Decode(arena, salt_b64);

        // SaltedPassword = PBKDF2-HMAC-SHA256(password, salt, i, 32).
        var salted: [32]u8 = undefined;
        try std.crypto.pwhash.pbkdf2(&salted, conn.password, salt, iterations, HmacSha256);

        // ClientKey = HMAC(SaltedPassword,"Client Key"); StoredKey = SHA256(ClientKey).
        var client_key: [32]u8 = undefined;
        HmacSha256.create(&client_key, "Client Key", &salted);
        var stored_key: [32]u8 = undefined;
        Sha256.hash(&client_key, &stored_key, .{});

        const client_final_bare = try std.fmt.allocPrint(arena, "c=biws,r={s}", .{combined_nonce});
        const auth_message = try std.fmt.allocPrint(arena, "{s},{s},{s}", .{ client_first_bare, server_first, client_final_bare });

        // ClientSignature = HMAC(StoredKey, AuthMessage); proof = ClientKey XOR sig.
        var client_sig: [32]u8 = undefined;
        HmacSha256.create(&client_sig, auth_message, &stored_key);
        var proof: [32]u8 = undefined;
        for (0..32) |i| proof[i] = client_key[i] ^ client_sig[i];
        const proof_b64 = try b64Encode(arena, &proof);

        // ServerSignature, to authenticate the server's final message.
        var server_key: [32]u8 = undefined;
        HmacSha256.create(&server_key, "Server Key", &salted);
        var server_sig: [32]u8 = undefined;
        HmacSha256.create(&server_sig, auth_message, &server_key);

        const client_final = try std.fmt.allocPrint(arena, "{s},p={s}", .{ client_final_bare, proof_b64 });
        try pg.send('p', client_final);

        // AuthenticationSASLFinal (R, 12): v=<server signature>.
        const fin = try pg.recv();
        if (fin.type == 'E') {
            conn.auth_error = try errorText(arena, fin.payload);
            return error.AuthFailed;
        }
        if (fin.type != 'R' or std.mem.readInt(u32, fin.payload[0..4], .big) != 12) return error.ProtocolError;
        const server_v = (try scramField(fin.payload[4..], 'v')) orelse return error.ProtocolError;
        const server_sig_got = try b64Decode(arena, server_v);
        if (!std.mem.eql(u8, server_sig_got, &server_sig)) return error.ServerSignatureMismatch;

        // The trailing AuthenticationOk is read by the authenticate() loop.
    }

    /// Read to the first ReadyForQuery, ignoring setup chatter
    /// (ParameterStatus, BackendKeyData, NoticeResponse).
    fn waitReady(pg: *Pg) !void {
        while (true) {
            const msg = try pg.recv();
            if (msg.type == 'Z') return;
            if (msg.type == 'E') return error.SetupError;
        }
    }

    // ---- query

    fn runQuery(pg: *Pg, sql: []const u8) Result {
        var q: std.ArrayList(u8) = .empty;
        q.appendSlice(pg.arena, sql) catch return oom();
        q.append(pg.arena, 0) catch return oom();
        pg.send('Q', q.items) catch |err| return fail(pg.arena, "send failed ({s})", .{@errorName(err)});

        var out: std.ArrayList(u8) = .empty;
        var code: i32 = 0;
        var err_text: []const u8 = "";

        while (true) {
            const msg = pg.recv() catch |e| return fail(pg.arena, "read failed ({s})", .{@errorName(e)});
            switch (msg.type) {
                'T' => frameHeader(pg.arena, &out, msg.payload) catch return oom(), // RowDescription
                'D' => frameRow(pg.arena, &out, msg.payload) catch return oom(), // DataRow
                'C' => {}, // CommandComplete — one statement done
                'I' => {}, // EmptyQueryResponse
                'E' => { // ErrorResponse — remember it, keep draining to ReadyForQuery
                    code = 1;
                    err_text = errorText(pg.arena, msg.payload) catch "query failed";
                },
                'Z' => break, // ReadyForQuery — end of the whole exchange
                else => {}, // ParameterStatus, NoticeResponse, etc.
            }
        }

        return .{ .out = out.items, .code = code, .err = err_text };
    }
};

fn appendParam(arena: std.mem.Allocator, list: *std.ArrayList(u8), key: []const u8, value: []const u8) !void {
    try list.appendSlice(arena, key);
    try list.append(arena, 0);
    try list.appendSlice(arena, value);
    try list.append(arena, 0);
}

/// RowDescription → header record: int16 count, then per column a
/// null-terminated name followed by 18 bytes of type metadata we skip.
fn frameHeader(arena: std.mem.Allocator, out: *std.ArrayList(u8), payload: []const u8) !void {
    var cur = Cursor{ .buf = payload };
    const count = try cur.int16();
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const name = try cur.cstr();
        try cur.skip(18); // tableOid(4) col(2) typeOid(4) size(2) mod(4) fmt(2)
        if (i > 0) try out.append(arena, US);
        try out.appendSlice(arena, name);
    }
    try out.append(arena, RS);
}

/// DataRow → one record: int16 count, then per field an int32 length
/// (-1 = NULL → 0x01 marker) and that many bytes.
fn frameRow(arena: std.mem.Allocator, out: *std.ArrayList(u8), payload: []const u8) !void {
    var cur = Cursor{ .buf = payload };
    const count = try cur.int16();
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const len = try cur.int32();
        if (i > 0) try out.append(arena, US);
        if (len < 0) {
            try out.append(arena, NULL_MARK);
        } else {
            try out.appendSlice(arena, try cur.take(@intCast(len)));
        }
    }
    try out.append(arena, RS);
}

/// Pull `key=value` out of a comma-separated SCRAM message (value runs to
/// the next comma or the end).
fn scramField(message: []const u8, key: u8) !?[]const u8 {
    var it = std.mem.splitScalar(u8, message, ',');
    while (it.next()) |field| {
        if (field.len >= 2 and field[0] == key and field[1] == '=') return field[2..];
    }
    return null;
}

/// ErrorResponse is a set of type-tagged, null-terminated fields; 'M' is the
/// human-readable message.
fn errorText(arena: std.mem.Allocator, payload: []const u8) ![]const u8 {
    var cur = Cursor{ .buf = payload };
    while (cur.rest().len > 0) {
        const field_type = try cur.byte();
        if (field_type == 0) break;
        const value = try cur.cstr();
        if (field_type == 'M') return arena.dupe(u8, value);
    }
    return "query failed";
}

// ---- cursor over a message payload -----------------------------------------

const Cursor = struct {
    buf: []const u8,
    pos: usize = 0,

    fn rest(c: *Cursor) []const u8 {
        return c.buf[c.pos..];
    }

    fn byte(c: *Cursor) !u8 {
        if (c.pos >= c.buf.len) return error.ProtocolError;
        defer c.pos += 1;
        return c.buf[c.pos];
    }

    fn take(c: *Cursor, n: usize) ![]const u8 {
        if (c.pos + n > c.buf.len) return error.ProtocolError;
        defer c.pos += n;
        return c.buf[c.pos .. c.pos + n];
    }

    fn skip(c: *Cursor, n: usize) !void {
        if (c.pos + n > c.buf.len) return error.ProtocolError;
        c.pos += n;
    }

    fn int16(c: *Cursor) !u16 {
        const b = try c.take(2);
        return std.mem.readInt(u16, b[0..2], .big);
    }

    fn int32(c: *Cursor) !i32 {
        const b = try c.take(4);
        return std.mem.readInt(i32, b[0..4], .big);
    }

    fn cstr(c: *Cursor) ![]const u8 {
        const start = c.pos;
        while (c.pos < c.buf.len and c.buf[c.pos] != 0) c.pos += 1;
        if (c.pos >= c.buf.len) return error.ProtocolError;
        defer c.pos += 1; // consume the null
        return c.buf[start..c.pos];
    }
};

// ---- base64 ----------------------------------------------------------------

fn b64Encode(arena: std.mem.Allocator, data: []const u8) ![]const u8 {
    const enc = std.base64.standard.Encoder;
    const dest = try arena.alloc(u8, enc.calcSize(data.len));
    return enc.encode(dest, data);
}

fn b64Decode(arena: std.mem.Allocator, text: []const u8) ![]const u8 {
    const dec = std.base64.standard.Decoder;
    const n = try dec.calcSizeForSlice(text);
    const dest = try arena.alloc(u8, n);
    try dec.decode(dest, text);
    return dest;
}
