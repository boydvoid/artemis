// Connection URL ⇄ fields.
//
// The stored connection is a URL and only a URL: the connections table is
// `(id, name, url)` and its schema is shared with the native app, so widening
// it would fork a store both front ends are supposed to see the same way.
// Fields are therefore an alternate *editor* for the same string, not a second
// way to store one — everything below converts, nothing persists.
//
// The reason this is worth having: a password containing `@`, `:`, `/` or `?`
// makes a hand-typed URL mean something other than what you intended, quietly.
// Building the URL here percent-encodes the parts that need it.

export interface ConnectionFields {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslmode: string;
}

export const EMPTY_FIELDS: ConnectionFields = {
  host: "",
  port: "",
  database: "",
  user: "",
  password: "",
  sslmode: "",
};

/// "" means "unset" — leave sslmode out of the URL and let libpq decide.
export const SSL_MODES: readonly string[] = [
  "",
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
];

/// Percent-decode, but never lose the whole value to one bad escape: a URL
/// typed by hand can easily contain a stray `%`.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildUrl(fields: ConnectionFields): string {
  const host = fields.host.trim();
  // Without a host there is no URL to form. The caller reads "" as incomplete.
  if (host.length === 0) return "";

  let auth = "";
  if (fields.user.length > 0) {
    auth = encodeURIComponent(fields.user);
    if (fields.password.length > 0) auth += `:${encodeURIComponent(fields.password)}`;
    auth += "@";
  }

  // A bare IPv6 literal has to be bracketed or its colons read as a port.
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = fields.port.trim().length > 0 ? `:${fields.port.trim()}` : "";
  const database =
    fields.database.trim().length > 0 ? `/${encodeURIComponent(fields.database.trim())}` : "";
  const sslmode = fields.sslmode.length > 0 ? `?sslmode=${encodeURIComponent(fields.sslmode)}` : "";

  return `postgresql://${auth}${hostPart}${port}${database}${sslmode}`;
}

/// Null when the text is not a Postgres URL we understand, so the caller can
/// keep what the user typed rather than replacing it with a wrong guess.
export function parseUrl(url: string): ConnectionFields | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return null;
    const hostname = parsed.hostname;
    return {
      host:
        hostname.startsWith("[") && hostname.endsWith("]")
          ? hostname.slice(1, -1)
          : hostname,
      port: parsed.port,
      database: safeDecode(parsed.pathname.replace(/^\//, "")),
      user: safeDecode(parsed.username),
      password: safeDecode(parsed.password),
      sslmode: parsed.searchParams.get("sslmode") ?? "",
    };
  } catch {
    return null;
  }
}
