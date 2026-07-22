// The dialect registry: the one place that maps a connection to how it talks.

import { postgresDialect } from "./postgres";
import { sqliteDialect } from "./sqlite";
import { connectionKind, type DbKind, type Dialect } from "./dialect";

export { ident, literal, connectionKind } from "./dialect";
export type { DbKind, Dialect } from "./dialect";

export function dialectFor(kind: DbKind): Dialect {
  return kind === "sqlite" ? sqliteDialect : postgresDialect;
}

/// Resolve straight from a connection URL — the common case at call sites,
/// which hold a URL rather than a pre-computed kind.
export function dialectForUrl(url: string): Dialect {
  return dialectFor(connectionKind(url));
}

/// UI metadata for the connection form's engine picker.
export const DB_KINDS: ReadonlyArray<{ kind: DbKind; label: string }> = [
  { kind: "postgres", label: "PostgreSQL" },
  { kind: "sqlite", label: "SQLite" },
];
