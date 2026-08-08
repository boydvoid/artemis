// Exploration probes: the AI chat looking at the data before answering.
//
// A reply that is ONLY a ```probe block is not an answer — it is a request
// to run one small read-only SELECT and see the rows. The chat loop
// intercepts it, sanitizes it here, runs it, and feeds the result back as
// the next message, up to PROBE_LIMIT rounds per request. This is what lets
// the model discover that "flowiki" is an org name and "main" a workspace
// name instead of assuming from the request's wording.
//
// Everything here is pure string work — no React, no bridge — so the
// safety rules are testable on their own.

import { RS, US } from "./bridge";
import { isNullField } from "./parse";

/// Split assistant text into prose and fenced code blocks, so SQL can be
/// rendered as an actionable block. A ```lang fence opens a code segment;
/// everything else is prose. Unclosed fences (mid-stream) still render.
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "code"; lang: string; text: string };

export function parseSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (match.index > last) {
      const text = content.slice(last, match.index);
      if (text.trim().length > 0) segments.push({ kind: "text", text });
    }
    segments.push({ kind: "code", lang: match[1] || "", text: match[2].replace(/\n$/, "") });
    last = fence.lastIndex;
  }
  if (last < content.length) {
    const text = content.slice(last);
    if (text.trim().length > 0) segments.push({ kind: "text", text });
  }
  return segments;
}

/// Whether a code block looks like SQL worth a "Send to editor" action.
export function looksLikeSql(segment: Segment): boolean {
  if (segment.kind !== "code") return false;
  if (segment.lang && !/sql/i.test(segment.lang)) return false;
  return /\b(select|insert|update|delete|create|with|alter|drop)\b/i.test(segment.text);
}

/// Max probe rounds per user request, so a confused model cannot loop.
export const PROBE_LIMIT = 3;

/// Max rows a probe returns to the model. Small: probes locate values,
/// they do not fetch reports.
export const PROBE_ROWS = 20;

/// The probe from a reply, if that is what the reply is. A reply that also
/// carries a ```sql block is a final answer, never a probe.
export function extractProbe(content: string): string | null {
  const segments = parseSegments(content);
  if (segments.some((s) => s.kind === "code" && looksLikeSql(s))) return null;
  const probe = segments.find((s) => s.kind === "code" && /^probe$/i.test(s.lang));
  return probe && probe.kind === "code" && probe.text.trim().length > 0
    ? probe.text.trim()
    : null;
}

/// Statements that must never run as a probe, whatever clothing they wear.
const PROBE_FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|attach|detach|pragma|copy|vacuum|reindex|merge|call|execute|do)\b/i;

/// Reduce a probe to one read-only, row-capped statement — or refuse. The
/// wrap enforces the row cap even when the model wrote its own LIMIT.
export function sanitizeProbe(
  raw: string,
): { ok: true; sql: string } | { ok: false; reason: string } {
  const sql = raw.trim().replace(/;\s*$/, "");
  if (sql.includes(";")) return { ok: false, reason: "one statement only" };
  if (!/^\s*(select|with)\b/i.test(sql)) return { ok: false, reason: "must be a SELECT" };
  if (PROBE_FORBIDDEN.test(sql)) return { ok: false, reason: "read-only SELECTs only" };
  return { ok: true, sql: `SELECT * FROM (\n${sql}\n) AS probe_rows LIMIT ${PROBE_ROWS};` };
}

/// Render a probe's framed result for the model: header plus rows, cells
/// pipe-separated, bounded in every direction.
export function formatProbeResult(out: string): { text: string; rows: number } {
  const trimmed = out.endsWith("\n") ? out.slice(0, -1) : out;
  const lines = trimmed.split(RS).filter((l) => l.length > 0);
  const shown = lines.slice(0, PROBE_ROWS + 1).map((line) =>
    line
      .split(US)
      .map((cell) => {
        const value = isNullField(cell) ? "NULL" : cell;
        return value.length > 120 ? `${value.slice(0, 120)}…` : value;
      })
      .join(" | "),
  );
  const text = shown.join("\n");
  return {
    text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
    rows: Math.max(0, lines.length - 1),
  };
}
