// The results grid.
//
// This is the component the whole rewrite exists for. The native canvas
// grid divided the pane width by the column count, so 26 columns meant
// 67pt each and every value elided to nothing, with no way to reach the
// columns past the edge. Here:
//
//   - every column has a real min-width and never compresses below it
//   - the table scrolls horizontally inside its own container
//   - the header row and the row-number gutter stay pinned while scrolling
//   - columns are drag-resizable, and a double-click resets one to auto
//
// Deliberately NOT shadcn's Table: sticky header, sticky gutter, fixed
// layout and drag-resizing are not things it does. The structural rules
// live in index.css under `.grid-table`; everything else is utilities.
//
// Editing is staged, never immediate: a value only reaches the database
// when the user commits the batch.
//
// Clicking a row opens the inspector: a side panel with every value in the
// row at full length. The grid truncates by column width — that is what
// keeps it a grid — so the panel is where a long value is actually read,
// resized (textareas) and copied.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, TableProperties, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { editText, isNullField } from "@/lib/parse";
import type { Page } from "@/lib/parse";
import type { Sort } from "@/lib/sql";

const MIN_COL_WIDTH = 84;
/// Enough to show a UUID or timestamp in full without one wide column
/// pushing everything else off screen.
const MAX_AUTO_WIDTH = 340;

interface Props {
  page: Page;
  /// Marks the row-number gutter when the result is a keyed table view.
  keyed: boolean;
  /// Staged values by `${ctid}:${colIndex}`, rendered in place of the
  /// database's value and highlighted as pending.
  staged: ReadonlyMap<string, string>;
  /// Only keyed table views can be edited — a join or an expression has no
  /// single row to write back to.
  editable: boolean;
  onStage: (rowIndex: number, colIndex: number, value: string) => void;
  /// The active sort, in precedence order. Ordering is server-side, so this
  /// only says how to draw the headers.
  sort?: readonly Sort[];
  /// Absent for a free-form query: there is no single table to re-order, and
  /// the statement may carry its own ORDER BY. Headers stay inert then.
  onSort?: (column: string, additive: boolean) => void;
  /// A query is in flight. Existing rows stay visible but dimmed — they are
  /// the OLD result, and pretending otherwise would invite edits against
  /// rows about to be replaced (interaction is disabled while dimmed).
  busy?: boolean;
}

/// A first-pass width from the widest sample in the column, clamped. Cheap
/// (character count, not text measurement) but good enough that most tables
/// need no manual resizing at all.
function autoWidth(col: string, rows: readonly string[][], index: number): number {
  let widest = col.length;
  const sampled = Math.min(rows.length, 40);
  for (let i = 0; i < sampled; i++) {
    const value = rows[i][index] ?? "";
    if (value.length > widest) widest = value.length;
  }
  // ~7.4px per monospace character at 12.5px, plus cell padding.
  const estimate = Math.round(widest * 7.4) + 26;
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_AUTO_WIDTH, estimate));
}

export default function DataGrid({
  page,
  keyed,
  staged,
  editable,
  onStage,
  sort = [],
  onSort,
  busy = false,
}: Props) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  /// The inspected row, by page index. Page-scoped view state: a new shape
  /// or page describes different rows, so it resets with them.
  const [selected, setSelected] = useState<number | null>(null);
  const dragRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  // A new result shape means the remembered widths no longer describe these
  // columns — start over rather than mismatching.
  const shape = page.cols.join(" ");
  useEffect(() => {
    setWidths({});
    setEditing(null);
    setSelected(null);
  }, [shape]);

  // Escape closes the inspector — unless a cell editor is open, whose own
  // Escape must win (one press should never cancel an edit AND the panel).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && editing === null) setSelected(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing]);

  const resolved = useMemo(
    () => page.cols.map((col, i) => widths[col] ?? autoWidth(col, page.rows, i)),
    [page.cols, page.rows, widths],
  );

  useEffect(() => {
    function onMove(event: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.max(MIN_COL_WIDTH, drag.startWidth + (event.clientX - drag.startX));
      setWidths((prev) => ({ ...prev, [drag.col]: next }));
    }
    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.classList.remove("resizing");
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  function startResize(event: React.MouseEvent, col: string, current: number) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { col, startX: event.clientX, startWidth: current };
    document.body.classList.add("resizing");
  }

  function resetWidth(col: string) {
    setWidths((prev) => {
      const next = { ...prev };
      delete next[col];
      return next;
    });
  }

  function valueAt(r: number, c: number): string {
    const pending = staged.get(`${page.keys[r] ?? ""}:${c}`);
    return pending !== undefined ? pending : (page.rows[r][c] ?? "");
  }

  function beginEdit(r: number, c: number) {
    if (!editable) return;
    // A NULL cell opens as the text "NULL" — committing it back unchanged
    // stays NULL, and clearing it stages a real empty string.
    setDraft(editText(valueAt(r, c)));
    setEditing({ r, c });
  }

  function commitEdit() {
    if (!editing) return;
    // Staging an unchanged value is a no-op, so a stray double-click never
    // dirties the batch. Compared in editing representation: a NULL cell's
    // draft starts as "NULL", not as the marker byte.
    if (draft !== editText(page.rows[editing.r][editing.c] ?? "")) {
      onStage(editing.r, editing.c, draft);
    }
    setEditing(null);
  }

  if (page.cols.length === 0) {
    // Nothing loaded yet. While the first query runs this is the whole
    // loading state, so it must not read as "nothing to show".
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-faint">
        <TableProperties
          className={cn("size-7 opacity-40", busy && "animate-pulse text-amber opacity-70")}
          strokeWidth={1.5}
        />
        <p className={cn("text-[12.5px]", busy && "animate-pulse")}>
          {busy ? "running query\u2026" : "Run a query or pick a table."}
        </p>
      </div>
    );
  }

  const totalWidth = resolved.reduce((sum, w) => sum + w, 0);
  // The selected index can outlive its row when a smaller page arrives.
  const inspected = selected !== null && selected < page.rows.length ? selected : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-auto transition-opacity duration-200",
          busy && "pointer-events-none opacity-50",
        )}
      >
      <table
        className="grid-table font-mono text-[12.5px]"
        style={{ width: totalWidth }}
      >
        <thead>
          <tr>
            <th
              className="grid-gutter text-[11px] text-faint"
              title={keyed ? "row (ctid-keyed)" : "row"}
            >
              {keyed ? "#" : "·"}
            </th>
            {page.cols.map((col, i) => {
              const rank = sort.findIndex((entry) => entry.column === col);
              const sorted = rank < 0 ? null : sort[rank];
              return (
                <th
                  key={col + i}
                  className="text-[11px] font-medium tracking-[0.03em] text-muted-foreground"
                  style={{ width: resolved[i], minWidth: resolved[i] }}
                  aria-sort={
                    sorted ? (sorted.dir === "asc" ? "ascending" : "descending") : undefined
                  }
                >
                  <span
                    className={cn(
                      "flex items-center gap-1 overflow-hidden",
                      onSort && "cursor-pointer select-none hover:text-foreground",
                    )}
                    onClick={onSort ? (e) => onSort(col, e.shiftKey) : undefined}
                    title={
                      onSort
                        ? `${col} · click to sort, shift-click to add to the sort`
                        : col
                    }
                  >
                    <span className="overflow-hidden text-ellipsis">{col}</span>
                    {sorted && (
                      <span className="flex flex-none items-center text-amber">
                        {sorted.dir === "asc" ? (
                          <ChevronUp className="size-3" />
                        ) : (
                          <ChevronDown className="size-3" />
                        )}
                        {/* The precedence number only earns its space once
                            more than one column is in play. */}
                        {sort.length > 1 && (
                          <span className="text-[9px] leading-none">{rank + 1}</span>
                        )}
                      </span>
                    )}
                  </span>
                  <span
                    className="col-resize"
                    onMouseDown={(e) => startResize(e, col, resolved[i])}
                    onDoubleClick={() => resetWidth(col)}
                    title="Drag to resize · double-click to reset"
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row, r) => (
            <tr
              key={page.keys[r] ?? r}
              className={cn("group", inspected === r && "row-inspected")}
              onClick={() => setSelected(r)}
            >
              <td
                className="grid-gutter text-[11px] text-faint group-hover:text-amber"
                title={page.keys[r] ?? ""}
              >
                {r + 1}
              </td>
              {row.map((_, c) => {
                const isEditing = editing?.r === r && editing?.c === c;
                const dirty = staged.has(`${page.keys[r] ?? ""}:${c}`);
                const value = valueAt(r, c);
                return (
                  <td
                    key={c}
                    className={cn(
                      "group-hover:bg-accent/60",
                      // A staged cell reads as pending, not committed.
                      dirty &&
                        "bg-amber/10 text-amber shadow-[inset_2px_0_0_var(--amber)] group-hover:bg-amber/15",
                    )}
                    style={{ width: resolved[c], minWidth: resolved[c] }}
                    title={isEditing ? undefined : editText(value)}
                    onDoubleClick={() => beginEdit(r, c)}
                  >
                    {isEditing ? (
                      <input
                        className="h-[calc(var(--spacing-row)-5px)] w-full rounded-[2px] border border-amber bg-background px-1 text-[12.5px] text-foreground outline-none"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                      />
                    ) : isNullField(value) ? (
                      <span className="text-[11px] italic text-faint">NULL</span>
                    ) : (
                      // An empty string renders as an empty cell — it is
                      // not NULL, and pretending otherwise was the old
                      // text-format ambiguity this marker removes.
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {inspected !== null && (
        <RowPanel
          cols={page.cols}
          row={page.rows[inspected]}
          rowKey={page.keys[inspected] ?? ""}
          rowNumber={inspected + 1}
          keyed={keyed}
          staged={staged}
          editable={editable}
          onEdit={(c, value) => onStage(inspected, c, value)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/// One field in the inspector. Values live in real form controls so they
/// select and copy like text anywhere else; long ones get a textarea that
/// can be resized to read in place.
///
/// On editable views the fields edit directly: focus takes a local draft,
/// blur stages it through the same lifecycle as a grid cell edit — nothing
/// reaches the database until Commit. Enter commits a single-line field,
/// Escape abandons the draft (and only the draft: the panel stays open).
function PanelField(props: {
  name: string;
  value: string;
  pending: boolean;
  editable: boolean;
  onCommit: (value: string) => void;
}) {
  const { name, value, pending, editable, onCommit } = props;
  const [copied, setCopied] = useState(false);
  /// The in-progress edit; null when not editing. Kept local so typing
  /// does not stage on every keystroke.
  const [draft, setDraft] = useState<string | null>(null);

  const isNull = isNullField(value);
  // Everything renders in editing representation: a NULL cell reads as the
  // text NULL, which is also exactly what commits back as SQL NULL.
  const text = draft ?? editText(value);
  const long = text.length > 64 || text.includes("\n");

  async function copy() {
    const clipboardText = isNull ? "" : editText(value);
    try {
      await navigator.clipboard.writeText(clipboardText);
    } catch {
      // zero:// origins may not grant the async clipboard API; the
      // selection-based path works everywhere a WebView does.
      const scratch = document.createElement("textarea");
      scratch.value = clipboardText;
      document.body.appendChild(scratch);
      scratch.select();
      document.execCommand("copy");
      scratch.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function commit() {
    if (draft === null) return;
    onCommit(draft);
    setDraft(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      // Abandon the draft only — the window-level Escape (which closes the
      // panel) must not see this press.
      event.stopPropagation();
      setDraft(null);
      event.currentTarget.blur();
    }
    if (event.key === "Enter" && event.currentTarget.tagName === "INPUT") {
      event.currentTarget.blur(); // blur commits
    }
  }

  const shared = {
    value: text,
    readOnly: !editable,
    spellCheck: false,
    "aria-label": name,
    onFocus: () => {
      if (editable && draft === null) setDraft(editText(value));
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (editable) setDraft(event.target.value);
    },
    onBlur: commit,
    onKeyDown,
  };

  const control = cn(
    "w-full rounded-[4px] border bg-background px-1.5 font-mono text-[11.5px] outline-none focus:border-ring",
    pending ? "border-amber/50 text-amber" : "border-hairline text-foreground",
    // An untouched NULL reads as what it is; typing takes normal styling.
    isNull && draft === null && "text-faint italic",
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span
          className="min-w-0 flex-1 overflow-hidden font-mono text-[10px] tracking-[0.08em] text-ellipsis whitespace-nowrap text-faint uppercase"
          title={name}
        >
          {name}
          {pending && <span className="ml-1.5 text-amber normal-case">staged</span>}
        </span>
        <button
          className="flex-none p-0.5 text-faint transition-colors hover:text-amber"
          onClick={() => void copy()}
          title={`Copy ${name}`}
          aria-label={`Copy ${name}`}
        >
          {copied ? <Check className="size-3 text-amber" /> : <Copy className="size-3" />}
        </button>
      </div>

      {!editable && isNull ? (
        <span className="px-1.5 py-1 text-[11px] italic text-faint">NULL</span>
      ) : long ? (
        <textarea {...shared} className={cn(control, "h-[92px] resize-y py-1 leading-relaxed")} />
      ) : (
        <input {...shared} className={cn(control, "h-6")} />
      )}
    </div>
  );
}

/// The row inspector. Fields edit in place on editable views, staging
/// through the same batch as grid cell edits — the panel shows staged
/// values marked as such rather than pretending they are committed.
function RowPanel(props: {
  cols: readonly string[];
  row: readonly string[];
  rowKey: string;
  rowNumber: number;
  keyed: boolean;
  staged: ReadonlyMap<string, string>;
  editable: boolean;
  onEdit: (colIndex: number, value: string) => void;
  onClose: () => void;
}) {
  const { cols, row, rowKey, rowNumber, keyed, staged, editable, onEdit, onClose } = props;

  return (
    <aside
      className="flex w-[300px] flex-none flex-col border-l border-border bg-card"
      aria-label={`Row ${rowNumber} details`}
    >
      <header className="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="font-mono text-[10px] tracking-[0.1em] text-faint uppercase">row</span>
        <span className="font-mono text-[12px] text-foreground">{rowNumber}</span>
        {keyed && rowKey.length > 0 && (
          <span className="min-w-0 overflow-hidden font-mono text-[10px] text-ellipsis whitespace-nowrap text-faint" title={rowKey}>
            {rowKey}
          </span>
        )}
        <span className="flex-1" />
        <button
          className="p-0.5 text-faint transition-colors hover:text-amber"
          onClick={onClose}
          aria-label="Close row details"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {cols.map((name, c) => {
          const pendingValue = staged.get(`${rowKey}:${c}`);
          return (
            <PanelField
              key={name + c}
              name={name}
              value={pendingValue !== undefined ? pendingValue : (row[c] ?? "")}
              pending={pendingValue !== undefined}
              editable={editable}
              onCommit={(value) => onEdit(c, value)}
            />
          );
        })}
      </div>
    </aside>
  );
}
