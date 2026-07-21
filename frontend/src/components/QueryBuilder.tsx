// The query builder.
//
// Two things a table tab shapes here: the predicate tree and which columns
// come back. Sort is the third part of the query but lives on the grid's
// column headers — you decide to re-order while looking at the rows, not
// while building the filter. It still shows up in the SQL preview below.
//
// All of it stays inside one table, so the result is still `SELECT ctid, ...`
// over addressable rows — which is what keeps the grid editable and staged
// commits able to find their row.
//
// Edits are local until Apply. A builder that re-queried on every keystroke
// would hammer the database while you are halfway through typing a value; the
// live SQL preview is what gives feedback in the meantime.
//
// Visual language: everything quiet except the logic. Controls are flat
// hairline wells on the panel background; amber is spent only on the
// connectives (the words that change what the query means), the primary
// action, and hover intent. A condition should read left-to-right like the
// SQL it becomes, and a hidden column should look switched off, not shouted.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  FILTER_OPS,
  emptyGroup,
  newCondition,
  opLabel,
  opTakesValue,
  type Condition,
  type FilterOp,
  type Group,
  type Predicate,
  type TableQuery,
} from "@/lib/sql";

interface Props {
  /// The table's full column set, so a hidden column can still be unhidden.
  columns: readonly string[];
  query: TableQuery;
  busy: boolean;
  onApply: (query: TableQuery) => void;
  onEditAsSql: (query: TableQuery) => void;
  /// Rendered under the builder so you can see what it is producing.
  buildSql: (query: TableQuery) => string;
}

// ---- immutable tree edits, addressed by node id

function replaceNode(node: Predicate, id: string, next: Predicate): Predicate {
  if (node.id === id) return next;
  if (node.kind !== "group") return node;
  return { ...node, children: node.children.map((child) => replaceNode(child, id, next)) };
}

function removeNode(node: Group, id: string): Group {
  return {
    ...node,
    children: node.children
      .filter((child) => child.id !== id)
      .map((child) => (child.kind === "group" ? removeNode(child, id) : child)),
  };
}

function appendTo(node: Predicate, groupId: string, child: Predicate): Predicate {
  if (node.kind !== "group") return node;
  if (node.id === groupId) return { ...node, children: [...node.children, child] };
  return { ...node, children: node.children.map((c) => appendTo(c, groupId, child)) };
}

/// Flat hairline well, shared by every control in a condition row so the row
/// reads as one phrase rather than three unrelated widgets.
const WELL =
  "h-6 rounded-[4px] border-hairline bg-card px-1.5 font-mono text-[11px] " +
  "hover:border-border dark:bg-card dark:hover:bg-card";

const CHEVRON = "[&_svg:not([class*='size-'])]:size-3";

export default function QueryBuilder(props: Props) {
  const { columns, query, busy, onApply, onEditAsSql, buildSql } = props;

  // Local until Apply. Re-seeded whenever the applied query changes, which
  // covers both a successful apply and a switch to another tab.
  const [draft, setDraft] = useState<TableQuery>(query);
  useEffect(() => setDraft(query), [query]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(query);
  const firstColumn = columns[0] ?? "";

  function setWhere(next: Predicate) {
    if (next.kind === "group") setDraft({ ...draft, where: next });
  }

  function renderNode(node: Predicate, depth: number) {
    return node.kind === "condition"
      ? renderCondition(node)
      : renderGroup(node, depth, false);
  }

  function renderCondition(node: Condition) {
    return (
      <div key={node.id} className="group/row flex items-center gap-1">
        <Select
          value={node.column}
          onValueChange={(next) =>
            next && setWhere(replaceNode(draft.where, node.id, { ...node, column: next }))
          }
          disabled={busy}
        >
          <SelectTrigger
            size="sm"
            className={cn(WELL, CHEVRON, "w-[136px] text-foreground")}
            aria-label="Condition column"
          >
            <SelectValue placeholder="column" />
          </SelectTrigger>
          <SelectContent>
            {columns.map((name) => (
              <SelectItem key={name} value={name} className="font-mono text-[11.5px]">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={node.op}
          onValueChange={(next) =>
            next &&
            setWhere(
              replaceNode(draft.where, node.id, { ...node, op: next as FilterOp }),
            )
          }
          disabled={busy}
        >
          <SelectTrigger
            size="sm"
            className={cn(WELL, CHEVRON, "w-[104px] text-muted-foreground")}
            aria-label="Condition operator"
          >
            {/* Base UI renders the raw value unless given a formatter, and
                "eq" is not what anyone reads a predicate as. */}
            <SelectValue>{(value) => opLabel(value as FilterOp)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPS.map((entry) => (
              <SelectItem key={entry.op} value={entry.op} className="font-mono text-[11.5px]">
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {opTakesValue(node.op) && (
          <Input
            className={cn(WELL, "w-[160px] text-foreground placeholder:text-faint")}
            value={node.value}
            onChange={(e) =>
              setWhere(replaceNode(draft.where, node.id, { ...node, value: e.target.value }))
            }
            onKeyDown={(e) => e.key === "Enter" && dirty && onApply(draft)}
            placeholder="value"
            disabled={busy}
            aria-label="Condition value"
          />
        )}

        {/* Destructive affordances stay hidden until the row is under the
            pointer — a tree full of × is a tree that looks deletable. */}
        <button
          className="p-0.5 text-faint opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-amber focus-visible:opacity-100"
          onClick={() => setWhere(removeNode(draft.where, node.id))}
          disabled={busy}
          aria-label="Remove condition"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  function renderGroup(node: Group, depth: number, root: boolean) {
    // A connective binds two things; with fewer it is noise. The root earns
    // its chip only then. A nested group keeps it always — the group exists
    // to hold a connective, so the chip is its name.
    const showConnective = !root || node.children.length >= 2;

    return (
      <div
        key={node.id}
        className={cn(
          "flex flex-col items-start gap-1",
          !root && "border-l border-border/80 py-0.5 pl-3",
        )}
      >
        {showConnective && (
          <div className="group/row flex items-center gap-1">
            <Select
              value={node.connective}
              onValueChange={(next) =>
                next &&
                setWhere(
                  replaceNode(draft.where, node.id, {
                    ...node,
                    connective: next as "and" | "or",
                  }),
                )
              }
              disabled={busy}
            >
              <SelectTrigger
                size="sm"
                className={cn(
                  CHEVRON,
                  "h-5 gap-0.5 rounded-[4px] border-transparent bg-amber/10 py-0 pr-1 pl-1.5",
                  "font-mono text-[10px] font-medium tracking-[0.08em] text-amber uppercase",
                  "hover:bg-amber/15 dark:bg-amber/10 dark:hover:bg-amber/15",
                  "[&_svg]:text-amber/60",
                )}
                aria-label="Group connective"
              >
                {/* The stored value is already the word we want to show, so
                    Base UI's raw render is right here. */}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="and" className="font-mono text-[11.5px]">
                  and
                </SelectItem>
                <SelectItem value="or" className="font-mono text-[11.5px]">
                  or
                </SelectItem>
              </SelectContent>
            </Select>

            {!root && (
              <button
                className="p-0.5 text-faint opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-amber focus-visible:opacity-100"
                onClick={() => setWhere(removeNode(draft.where, node.id))}
                disabled={busy}
                aria-label="Remove group"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        )}

        {node.children.map((child) => renderNode(child, depth + 1))}

        <div className="flex items-center gap-2.5">
          <AddLink
            disabled={busy || columns.length === 0}
            onClick={() =>
              setWhere(appendTo(draft.where, node.id, newCondition(firstColumn)))
            }
          >
            condition
          </AddLink>
          {/* Nesting past a couple of levels stops being readable faster than
              it stops being expressible, so the offer ends at depth 2. */}
          {depth < 2 && (
            <AddLink
              disabled={busy}
              onClick={() =>
                setWhere(
                  appendTo(
                    draft.where,
                    node.id,
                    emptyGroup(node.connective === "and" ? "or" : "and"),
                  ),
                )
              }
            >
              group
            </AddLink>
          )}
        </div>
      </div>
    );
  }

  const hidden = new Set(draft.hidden);

  return (
    <section className="flex max-h-[45%] flex-none flex-col gap-2.5 overflow-auto border-b border-border px-3 py-2.5">
      <Field label="where">{renderGroup(draft.where, 0, true)}</Field>

      <Field label="columns">
        <div className="flex flex-wrap items-center gap-1">
          {columns.map((name) => {
            const off = hidden.has(name);
            return (
              <button
                key={name}
                aria-pressed={!off}
                disabled={busy}
                onClick={() =>
                  setDraft({
                    ...draft,
                    hidden: off
                      ? draft.hidden.filter((c) => c !== name)
                      : [...draft.hidden, name],
                  })
                }
                className={cn(
                  "rounded-[4px] border px-1.5 py-[3px] font-mono text-[10.5px] leading-none transition-colors",
                  off
                    ? "border-transparent text-faint line-through hover:border-hairline hover:text-muted-foreground"
                    : "border-hairline bg-card text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {name}
              </button>
            );
          })}
          {draft.hidden.length > 0 && (
            <button
              className="ml-1 font-mono text-[10px] text-amber/80 transition-colors hover:text-amber"
              disabled={busy}
              onClick={() => setDraft({ ...draft, hidden: [] })}
            >
              {draft.hidden.length} hidden · show all
            </button>
          )}
        </div>
      </Field>

      <div className="border-t border-hairline pt-2">
        <div className="flex items-center gap-2.5">
          <span className="w-[52px] flex-none font-mono text-[10px] tracking-[0.1em] text-faint uppercase">
            sql
          </span>
          {/* Scrolls rather than wraps, and dissolves at the right edge so a
              long statement reads as "continues" instead of "cut off". */}
          <p className="m-0 min-w-0 flex-1 overflow-x-auto font-mono text-[10.5px] whitespace-nowrap text-faint [mask-image:linear-gradient(90deg,#000_calc(100%-28px),transparent)]">
            {buildSql(draft)}
          </p>
          <button
            className="flex-none font-mono text-[10.5px] text-muted-foreground transition-colors hover:text-amber disabled:opacity-40"
            onClick={() => onEditAsSql(draft)}
            disabled={busy}
          >
            edit as sql
          </button>
          <Button
            size="xs"
            variant={dirty ? "default" : "ghost"}
            className="font-mono"
            onClick={() => onApply(draft)}
            disabled={busy || !dirty}
          >
            {busy ? "running" : dirty ? "Apply" : "applied"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/// The quiet way to grow the tree: reads as an affordance, not a control.
function AddLink(props: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="flex items-center gap-1 py-0.5 font-mono text-[10.5px] text-faint transition-colors hover:text-amber disabled:opacity-40"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span aria-hidden>+</span>
      {props.children}
    </button>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="w-[52px] flex-none pt-[5px] font-mono text-[10px] tracking-[0.1em] text-faint uppercase">
        {props.label}
      </span>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
