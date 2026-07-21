// The filter builder.
//
// A row of committed filter chips plus one draft row (column, operator,
// value). Filters AND together and are applied server-side through the
// table's WHERE clause, so they narrow the actual result set rather than
// hiding rows the client already fetched — which is what keeps pagination
// and row counts honest.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FILTER_OPS,
  filterLabel,
  opTakesValue,
  type Filter,
  type FilterOp,
} from "@/lib/sql";

interface Props {
  columns: readonly string[];
  filters: readonly Filter[];
  busy: boolean;
  onChange: (filters: Filter[]) => void;
}

export default function FilterBar({ columns, filters, busy, onChange }: Props) {
  const [column, setColumn] = useState("");
  const [op, setOp] = useState<FilterOp>("eq");
  const [value, setValue] = useState("");

  // Default to the first column, and recover if the current pick vanished
  // with a result-shape change.
  useEffect(() => {
    if (columns.length > 0 && !columns.includes(column)) setColumn(columns[0]);
  }, [columns, column]);

  function add() {
    if (column.length === 0) return;
    if (opTakesValue(op) && value.length === 0) return;
    onChange([
      ...filters,
      {
        id: `f${Date.now().toString(36)}`,
        column,
        op,
        value: opTakesValue(op) ? value : "",
      },
    ]);
    setValue("");
  }

  return (
    <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
      {filters.map((filter) => (
        <Badge
          key={filter.id}
          variant="outline"
          className="gap-1 border-ring bg-amber/10 py-0 pr-1 pl-2 font-mono text-[11px] font-normal text-amber"
        >
          {filterLabel(filter)}
          <button
            className="opacity-65 transition-opacity hover:opacity-100 disabled:opacity-30"
            onClick={() => onChange(filters.filter((f) => f.id !== filter.id))}
            disabled={busy}
            aria-label={`Remove filter ${filterLabel(filter)}`}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}

      <Select value={column} onValueChange={(next) => setColumn(next ?? "")} disabled={busy}>
        <SelectTrigger size="sm" className="h-7 w-[150px] font-mono text-[11.5px]" aria-label="Filter column">
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

      <Select value={op} onValueChange={(next) => next && setOp(next as FilterOp)} disabled={busy}>
        <SelectTrigger size="sm" className="h-7 w-[130px] font-mono text-[11.5px]" aria-label="Filter operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILTER_OPS.map((entry) => (
            <SelectItem key={entry.op} value={entry.op} className="font-mono text-[11.5px]">
              {entry.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {opTakesValue(op) && (
        <Input
          className="h-7 w-[160px] font-mono text-[11.5px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="value"
          disabled={busy}
          aria-label="Filter value"
        />
      )}

      <Button size="sm" variant="outline" onClick={add} disabled={busy}>
        Filter
      </Button>

      {filters.length > 0 && (
        <Button size="sm" variant="ghost" onClick={() => onChange([])} disabled={busy}>
          clear all
        </Button>
      )}
    </div>
  );
}
