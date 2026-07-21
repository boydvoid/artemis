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

import { useEffect, useMemo, useRef, useState } from "react";
import { TableProperties } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Page } from "@/lib/parse";

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

export default function DataGrid({ page, keyed, staged, editable, onStage }: Props) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [draft, setDraft] = useState("");
  const dragRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null);

  // A new result shape means the remembered widths no longer describe these
  // columns — start over rather than mismatching.
  const shape = page.cols.join(" ");
  useEffect(() => {
    setWidths({});
    setEditing(null);
  }, [shape]);

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
    setDraft(valueAt(r, c));
    setEditing({ r, c });
  }

  function commitEdit() {
    if (!editing) return;
    // Staging an unchanged value is a no-op, so a stray double-click never
    // dirties the batch.
    if (draft !== (page.rows[editing.r][editing.c] ?? "")) {
      onStage(editing.r, editing.c, draft);
    }
    setEditing(null);
  }

  if (page.cols.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-faint">
        <TableProperties className="size-7 opacity-40" strokeWidth={1.5} />
        <p className="text-[12.5px]">Run a query or pick a table.</p>
      </div>
    );
  }

  const totalWidth = resolved.reduce((sum, w) => sum + w, 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
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
            {page.cols.map((col, i) => (
              <th
                key={col + i}
                className="text-[11px] font-medium tracking-[0.03em] text-muted-foreground"
                style={{ width: resolved[i], minWidth: resolved[i] }}
              >
                <span className="block overflow-hidden text-ellipsis" title={col}>
                  {col}
                </span>
                <span
                  className="col-resize"
                  onMouseDown={(e) => startResize(e, col, resolved[i])}
                  onDoubleClick={() => resetWidth(col)}
                  title="Drag to resize · double-click to reset"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row, r) => (
            <tr key={page.keys[r] ?? r} className="group">
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
                    title={isEditing ? undefined : value}
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
                    ) : value.length === 0 ? (
                      <span className="text-[11px] italic text-faint">NULL</span>
                    ) : (
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
  );
}
