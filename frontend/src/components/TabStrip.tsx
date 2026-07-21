// The workspace tab strip.
//
// Every tab here is a document: its own statement or table, its own result,
// its own staged edits. Filters used to live here too, as a pinned pseudo-tab
// that was a mode rather than a document — it edited whichever query tab
// happened to be active. Filters belong to the table they narrow, so they now
// live inside the table tab itself and this strip is documents only.

import { Plus, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { countConditions } from "@/lib/sql";
import type { QueryTab } from "@/lib/tabs";

interface Props {
  tabs: QueryTab[];
  activeTabId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}

export default function TabStrip(props: Props) {
  return (
    <div className="flex flex-none items-center gap-0.5 border-b border-border px-2 pt-1.5">
      {props.tabs.map((tab) => {
        const active = tab.id === props.activeTabId;
        // A filtered tab shows fewer rows than its name implies, and on an
        // inactive tab the filter bar is not there to say so.
        const filterCount =
          tab.source.kind === "table" ? countConditions(tab.source.query.where) : 0;
        return (
          <div
            key={tab.id}
            className={cn(
              "group flex h-7 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[12px]",
              active
                ? "border-border bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => props.onSelect(tab.id)}
            role="tab"
            aria-selected={active}
            title={tab.name}
          >
            <span className="max-w-[130px] overflow-hidden text-ellipsis whitespace-nowrap">
              {tab.name}
            </span>
            {filterCount > 0 && (
              <span
                className="flex flex-none items-center gap-1 rounded-full bg-amber/15 px-1.5 font-mono text-[10px] text-amber"
                title={`${filterCount} filter${filterCount === 1 ? "" : "s"} applied`}
              >
                <SlidersHorizontal className="size-2.5" />
                {filterCount}
              </span>
            )}
            {/* Unsaved staged edits are the one thing you must not lose by
                closing a tab, so mark them right on the tab. */}
            {tab.staged.length > 0 && (
              <span
                className="size-1.5 flex-none rounded-full bg-amber"
                title={`${tab.staged.length} staged edit${tab.staged.length === 1 ? "" : "s"}`}
              />
            )}
            {props.tabs.length > 1 && (
              <button
                className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-amber"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(tab.id);
                }}
                aria-label={`Close ${tab.name}`}
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        );
      })}

      <Button size="icon-xs" variant="ghost" onClick={props.onNew} aria-label="New query tab">
        <Plus />
      </Button>
    </div>
  );
}
