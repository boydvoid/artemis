// psql output parsing, ported from the native app's parsePage/parseTableRows.
//
// With `-A -F <US> -R <RS> -P footer=off`, psql emits one record per row
// separated by RS, fields separated by US, and record 0 is the header.
// An unquoted empty field is SQL NULL — psql prints nothing for it — so
// NULL and empty string are genuinely indistinguishable in this format.
// That ambiguity is inherited from the native app; it is called out here
// because the grid renders both as a dimmed NULL marker.

import { RS, US } from "./bridge";

/// What psql prints for SQL NULL (`-P null=` on the native side). With it,
/// NULL and empty string are finally distinguishable: an empty field is a
/// real empty string, and this marker is NULL.
export const NULL_FIELD = "\x01";

export function isNullField(value: string): boolean {
  return value === NULL_FIELD;
}

/// The editing representation of a raw field: a NULL cell opens as the
/// text "NULL", which is also what commits back as SQL NULL — the same
/// convention the app has always had, now round-trip coherent.
export function editText(value: string): string {
  return value === NULL_FIELD ? "NULL" : value;
}

export interface TableRef {
  id: string;
  schema: string;
  name: string;
}

export interface Page {
  cols: string[];
  rows: string[][];
  /// ctid per row when the query was keyed; empty otherwise.
  keys: string[];
  hasNext: boolean;
}

function records(out: string): string[] {
  const trimmed = out.endsWith("\n") ? out.slice(0, -1) : out;
  if (trimmed.length === 0) return [];
  return trimmed.split(RS).filter((line) => line.length > 0);
}

export function parseTables(out: string): TableRef[] {
  const lines = records(out);
  const tables: TableRef[] = [];
  // Record 0 is the psql header row.
  for (let i = 1; i < lines.length; i++) {
    const sep = lines[i].indexOf(US);
    if (sep < 0) continue;
    const schema = lines[i].slice(0, sep);
    const name = lines[i].slice(sep + 1);
    tables.push({ id: `${schema}.${name}`, schema, name });
  }
  return tables;
}

export function parsePkCols(out: string): string[] {
  const lines = records(out);
  const cols: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith("pk:")) cols.push(lines[i].slice(3));
  }
  return cols;
}

/// One page of results. `keyed` means the statement selected `ctid, *`,
/// so field 0 is the row key rather than user data.
export function parsePage(out: string, keyed: boolean, cap: number): Page {
  const lines = records(out);
  if (lines.length === 0) return { cols: [], rows: [], keys: [], hasNext: false };

  const header = lines[0].split(US);
  const cols = keyed ? header.slice(1) : header;

  const rows: string[][] = [];
  const keys: string[] = [];
  let hasNext = false;

  for (let i = 1; i < lines.length; i++) {
    if (rows.length >= cap) {
      // The probe row exists, so there is another page. It is never shown.
      hasNext = true;
      break;
    }
    const fields = lines[i].split(US);
    if (keyed) {
      keys.push(fields[0] ?? "");
      rows.push(padTo(fields.slice(1), cols.length));
    } else {
      rows.push(padTo(fields, cols.length));
    }
  }

  return { cols, rows, keys, hasNext };
}

/// A short row is padded rather than dropped: a ragged record should show
/// as blank trailing cells, never as a column shift.
function padTo(fields: string[], width: number): string[] {
  if (fields.length >= width) return fields.slice(0, width);
  return fields.concat(new Array(width - fields.length).fill(""));
}
