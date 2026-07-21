// The workspace tab strip.
//
// Query tabs are documents (own statement, own result, own staged edits).
// The Filters tab is pinned at the end and is a different kind of thing: a
// panel mode, not a document — it edits the ACTIVE query tab's filters. It
// is separated by a divider and never closes, so the distinction reads
// visually rather than needing to be explained.

import { Plus, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QueryTab } from "@/lib/tabs";

interface Props {
  tabs: QueryTab[];
  activeTabId: number;
  /// Which panel the workspace is showing. "filters" keeps a query tab
  /// active underneath — it only swaps what the panel edits.
  panel: "query" | "filters";
  /// Number of filters on the active tab, surfaced on the Filters tab so a
  /// narrowed result is never invisible.
  filterCount: number;
  /// Filters only apply to a table view.
  filtersEnabled: boolean;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onShowFilters: () => void;
}

export default function TabStrip(props: Props) {
  return (
    <div className="flex flex-none items-center gap-0.5 border-b border-border px-2 pt-1.5">
      {props.tabs.map((tab) => {
        const active = props.panel === "query" && tab.id === props.activeTabId;
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

      <span className="mx-1.5 h-4 w-px flex-none bg-border" />

      <div
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-2.5 text-[12px]",
          props.panel === "filters"
            ? "border-border bg-background text-foreground"
            : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
          !props.filtersEnabled && "cursor-default opacity-40 hover:bg-transparent",
        )}
        onClick={() => props.filtersEnabled && props.onShowFilters()}
        role="tab"
        aria-selected={props.panel === "filters"}
        aria-disabled={!props.filtersEnabled}
        title={
          props.filtersEnabled
            ? "Filters for the current table"
            : "Filters apply to table views only"
        }
      >
        <SlidersHorizontal className="size-3" />
        Filters
        {props.filterCount > 0 && (
          <span className="rounded-full bg-amber/15 px-1.5 font-mono text-[10px] text-amber">
            {props.filterCount}
          </span>
        )}
      </div>
    </div>
  );
}
