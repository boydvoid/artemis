// Byte and draft utilities: separator framing, concatenation, SQL
// quoting, decimal parsing, and the elm-style text-draft helpers every
// section of the app shares.

import { asciiBytes } from "@native-sdk/core";
import {
  type TextEditState,
  type TextInputEvent,
  applyTextInputEvent,
  clampedInsertEvent,
} from "@native-sdk/core/text";

export function unitSeparator(): Uint8Array {
  const out = new Uint8Array(1);
  out[0] = 0x1f;
  return out;
}

export function recordSeparator(): Uint8Array {
  const out = new Uint8Array(1);
  out[0] = 0x1e;
  return out;
}

export function bytesConcat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  return out;
}

/// A value as a single-quoted SQL text literal (internal quotes doubled).
export function sqlQuoted(value: Uint8Array): Uint8Array {
  const pieces = value.split(asciiBytes("'"));
  const parts: Uint8Array[] = [];
  parts.push(asciiBytes("'"));
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) parts.push(asciiBytes("''"));
    parts.push(pieces[i]);
  }
  parts.push(asciiBytes("'"));
  return bytesConcat(parts);
}

/// A name as a double-quoted SQL identifier (internal quotes doubled).
export function identQuoted(name: Uint8Array): Uint8Array {
  const pieces = name.split(asciiBytes('"'));
  const parts: Uint8Array[] = [];
  parts.push(asciiBytes('"'));
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) parts.push(asciiBytes('""'));
    parts.push(pieces[i]);
  }
  parts.push(asciiBytes('"'));
  return bytesConcat(parts);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function parseDecimal(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    const digit = bytes[i] - 48;
    if (digit < 0 || digit > 9) return 0;
    value = value * 10 + digit;
  }
  return value;
}

/// psql ends its output with one final newline after the last record -
/// strip it so the last field parses clean.
export function stripFinalNewline(out: Uint8Array): Uint8Array {
  if (out.length > 0 && out[out.length - 1] === 0x0a) return out.subarray(0, out.length - 1);
  return out;
}

export function emptyDraft(): TextEditState {
  return { text: new Uint8Array(0), selection: { anchor: 0, focus: 0 }, composition: null };
}

export function draftFrom(text: Uint8Array): TextEditState {
  return { text: text, selection: { anchor: text.length, focus: text.length }, composition: null };
}

export function applyDraftEdit(draft: TextEditState, edit: TextInputEvent, capacity: number): TextEditState {
  const next = applyTextInputEvent(draft, edit, capacity);
  if (next !== null) return next;
  // Over-capacity: clamp an insert to the bytes that fit, drop the rest.
  const clamped = clampedInsertEvent(draft, edit, capacity);
  if (clamped === null) return draft;
  const applied = applyTextInputEvent(draft, clamped, capacity);
  if (applied === null) return draft;
  return applied;
}
