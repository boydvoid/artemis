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

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
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
      <div key={node.id} className="flex items-center gap-1.5">
        <Select
          value={node.column}
          onValueChange={(next) =>
            next && setWhere(replaceNode(draft.where, node.id, { ...node, column: next }))
          }
          disabled={busy}
        >
          <SelectTrigger
            size="sm"
            className="h-7 w-[150px] font-mono text-[11.5px]"
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
            className="h-7 w-[120px] font-mono text-[11.5px]"
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
            className="h-7 w-[170px] font-mono text-[11.5px]"
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

        <button
          className="text-faint transition-colors hover:text-amber"
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
    return (
      <div
        key={node.id}
        className={cn("flex flex-col gap-1.5", !root && "border-l border-hairline pl-2.5")}
      >
        <div className="flex items-center gap-1.5">
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
              className="h-6 w-[72px] font-mono text-[11px]"
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
              className="text-faint transition-colors hover:text-amber"
              onClick={() => setWhere(removeNode(draft.where, node.id))}
              disabled={busy}
              aria-label="Remove group"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {node.children.map((child) => renderNode(child, depth + 1))}

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || columns.length === 0}
            onClick={() =>
              setWhere(appendTo(draft.where, node.id, newCondition(firstColumn)))
            }
          >
            <Plus /> condition
          </Button>
          {/* Nesting past a couple of levels stops being readable faster than
              it stops being expressible, so the offer ends at depth 2. */}
          {depth < 2 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                setWhere(appendTo(draft.where, node.id, emptyGroup(node.connective === "and" ? "or" : "and")))
              }
            >
              <Plus /> group
            </Button>
          )}
        </div>
      </div>
    );
  }

  const hidden = new Set(draft.hidden);

  return (
    <section className="flex max-h-[45%] flex-none flex-col gap-2 overflow-auto border-b border-border p-3">
      <Field label="where">{renderGroup(draft.where, 0, true)}</Field>

      <Field label="columns">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {columns.map((name) => (
            <label
              key={name}
              className="flex cursor-pointer items-center gap-1.5 font-mono text-[11.5px]"
            >
              <input
                type="checkbox"
                className="accent-amber"
                checked={!hidden.has(name)}
                disabled={busy}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    hidden: e.target.checked
                      ? draft.hidden.filter((c) => c !== name)
                      : [...draft.hidden, name],
                  })
                }
              />
              <span className={hidden.has(name) ? "text-faint line-through" : "text-foreground"}>
                {name}
              </span>
            </label>
          ))}
        </div>
      </Field>

      <div className="flex items-end gap-2 border-t border-hairline pt-2">
        <pre className="m-0 min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-pre-wrap text-faint">
          {buildSql(draft)}
        </pre>
        <Button size="sm" variant="ghost" onClick={() => onEditAsSql(draft)} disabled={busy}>
          Edit as SQL
        </Button>
        <Button size="sm" onClick={() => onApply(draft)} disabled={busy || !dirty}>
          {busy ? "running" : dirty ? "Apply" : "Applied"}
        </Button>
      </div>
    </section>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5">
      <span className="w-[52px] flex-none pt-1.5 font-mono text-[10px] tracking-[0.1em] text-faint uppercase">
        {props.label}
      </span>
      <div className="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
