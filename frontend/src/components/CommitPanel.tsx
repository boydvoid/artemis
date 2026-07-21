// The staged-edits review panel.
//
// A right-side panel listing every pending edit in the batch before it is
// committed. Each entry shows the database's value, the staged value in an
// editable field, and a remove control. It never touches the database — it
// edits the same staged batch the grid does, so Commit/Discard in the banner
// remain the only paths to (or away from) the database.
//
// Both "edit" and "remove" route through the grid's own `onStage`: staging a
// new value replaces the entry, and staging the database's original value
// back drops it — which is exactly "remove this edit". There is one code path
// for changing the batch, shared with the grid and the row inspector.

import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { editText, isNullField, type Page } from "@/lib/parse";
import type { StagedEdit } from "@/lib/sql";

interface Props {
  edits: readonly StagedEdit[];
  /// The current page, so each edit can be located by key to recover its
  /// original value and its live row index (edits are always on this page —
  /// they are dropped whenever the page or query changes).
  page: Page;
  busy: boolean;
  /// The grid's staging entry point. rowIndex is resolved here from the edit's
  /// key, so the panel speaks the same (rowIndex, colIndex, value) language.
  onStage: (rowIndex: number, colIndex: number, value: string) => void;
  onClose: () => void;
}

export default function CommitPanel({ edits, page, busy, onStage, onClose }: Props) {
  // Group by row so a multi-column edit reads as one changed record, matching
  // how it commits (one UPDATE per row).
  const byRow = new Map<string, StagedEdit[]>();
  for (const edit of edits) {
    const list = byRow.get(edit.key);
    if (list) list.push(edit);
    else byRow.set(edit.key, [edit]);
  }

  return (
    <aside
      className="flex w-[320px] flex-none flex-col border-l border-border bg-card"
      aria-label="Staged edits"
    >
      <header className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="font-mono text-[10px] tracking-[0.1em] text-faint uppercase">staged</span>
        <span className="font-mono text-[12px] text-amber">
          {edits.length} edit{edits.length === 1 ? "" : "s"}
        </span>
        <span className="font-mono text-[10px] text-faint">
          · {byRow.size} row{byRow.size === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <button
          className="p-0.5 text-faint transition-colors hover:text-amber"
          onClick={onClose}
          aria-label="Close staged edits"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        {[...byRow.entries()].map(([key, rowEdits]) => {
          const rowIndex = page.keys.indexOf(key);
          const rowNumber = rowIndex >= 0 ? rowIndex + 1 : null;
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-faint">
                <span className="tracking-[0.08em] uppercase">
                  row {rowNumber ?? "?"}
                </span>
                <span
                  className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
                  title={key}
                >
                  {key}
                </span>
              </div>
              {rowEdits.map((edit) => (
                <CommitEditRow
                  key={edit.column + edit.colIndex}
                  edit={edit}
                  rowIndex={rowIndex}
                  original={rowIndex >= 0 ? (page.rows[rowIndex][edit.colIndex] ?? "") : ""}
                  busy={busy}
                  onStage={onStage}
                />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/// One pending edit: column name, the database's value, the staged value in
/// an editable field, and a remove control.
function CommitEditRow(props: {
  edit: StagedEdit;
  rowIndex: number;
  /// The database's raw value for this cell (NULL marker included).
  original: string;
  busy: boolean;
  onStage: (rowIndex: number, colIndex: number, value: string) => void;
}) {
  const { edit, rowIndex, original, busy, onStage } = props;
  /// Local until blur, so typing does not restage on every keystroke.
  const [draft, setDraft] = useState<string | null>(null);

  const staged = editText(edit.value);
  const text = draft ?? staged;
  const long = text.length > 48 || text.includes("\n");
  const disabled = busy || rowIndex < 0;

  const originalNull = isNullField(original);
  const originalText = editText(original);

  function stage() {
    if (draft === null || draft === staged) {
      setDraft(null);
      return;
    }
    onStage(rowIndex, edit.colIndex, draft);
    setDraft(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      // Abandon the draft only — this must not reach the window handler that
      // closes the whole panel.
      event.stopPropagation();
      setDraft(null);
      event.currentTarget.blur();
    }
    if (event.key === "Enter" && event.currentTarget.tagName === "INPUT") {
      event.currentTarget.blur(); // blur stages
    }
  }

  const field = cn(
    "w-full rounded-[4px] border border-amber/50 bg-background px-1.5 font-mono text-[11.5px] text-amber outline-none focus:border-ring",
  );

  return (
    <div className="flex flex-col gap-1 border-l border-amber/40 pl-2">
      <div className="flex items-center gap-1.5">
        <span
          className="min-w-0 flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-foreground"
          title={edit.column}
        >
          {edit.column}
        </span>
        {/* Removing an edit is staging the database's own value back — the
            grid's onStage drops any edit equal to the original. */}
        <button
          className="flex-none p-0.5 text-faint transition-colors hover:text-amber disabled:opacity-40"
          onClick={() => onStage(rowIndex, edit.colIndex, originalText)}
          disabled={disabled}
          title="Remove this edit"
          aria-label={`Remove edit to ${edit.column}`}
        >
          <X className="size-3" />
        </button>
      </div>

      <div className="flex items-center gap-1 font-mono text-[10.5px] text-faint">
        {originalNull ? (
          <span className="italic">NULL</span>
        ) : originalText.length === 0 ? (
          <span className="italic opacity-60">empty</span>
        ) : (
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={originalText}>
            {originalText}
          </span>
        )}
        <span className="flex-none text-amber/60">→</span>
      </div>

      {long ? (
        <textarea
          className={cn(field, "h-[64px] resize-y py-1 leading-relaxed")}
          value={text}
          disabled={disabled}
          spellCheck={false}
          aria-label={`New value for ${edit.column}`}
          onFocus={() => draft === null && setDraft(staged)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={stage}
          onKeyDown={onKeyDown}
        />
      ) : (
        <input
          className={cn(field, "h-6")}
          value={text}
          disabled={disabled}
          spellCheck={false}
          aria-label={`New value for ${edit.column}`}
          onFocus={() => draft === null && setDraft(staged)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={stage}
          onKeyDown={onKeyDown}
        />
      )}
    </div>
  );
}
