// The home screen: pick a database, or add one.
//
// Connections used to share the left rail with the table list, which meant
// the rail carried two unrelated jobs and the thing you do first was the
// thing with least room. This screen is the app's entry point; choosing a
// connection is what opens the workspace.

import { Check, Circle, Database, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Connection } from "@/lib/store";

interface Props {
  connections: Connection[];
  activeId: number;
  busy: boolean;
  draftName: string;
  draftUrl: string;
  setDraftName: (v: string) => void;
  setDraftUrl: (v: string) => void;
  onAdd: () => void;
  onOpen: (id: number) => void;
  onRemove: (id: number) => void;
}

export default function Connections(props: Props) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-8 py-14">
        <header className="mb-10 flex items-center gap-3">
          <Database className="size-5 text-amber" />
          <div>
            <h1 className="text-[15px] font-semibold tracking-[0.18em]">ARTEMIS</h1>
            <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
              Postgres browser
            </p>
          </div>
        </header>

        <h2 className="mb-3 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Connections
        </h2>

        <ul className="mb-10 list-none space-y-1.5 p-0">
          {props.connections.map((c) => {
            const isActive = c.id === props.activeId;
            return (
              <li key={c.id}>
                <div
                  className={cn(
                    "group flex cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-4 py-3 transition-colors hover:border-ring hover:bg-accent",
                    isActive && "border-ring bg-amber/5",
                  )}
                  onClick={() => props.onOpen(c.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      props.onOpen(c.id);
                    }
                  }}
                >
                  {isActive ? (
                    <Check className="size-4 flex-none text-amber" />
                  ) : (
                    <Circle className="size-4 flex-none text-faint" strokeWidth={1.5} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px]">{c.name}</div>
                    <div className="overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-faint">
                      {c.url}
                    </div>
                  </div>
                  <span className="font-mono text-[10.5px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
                    open
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRemove(c.id);
                    }}
                    disabled={props.busy}
                    aria-label={`Delete ${c.name}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}

          {props.connections.length === 0 && (
            <li className="rounded-md border border-dashed border-border px-4 py-8 text-center">
              <p className="text-[12.5px] text-muted-foreground">No saved connections yet.</p>
              <p className="mt-1 font-mono text-[11px] text-faint">Add one below to get started.</p>
            </li>
          )}
        </ul>

        <h2 className="mb-3 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Add a connection
        </h2>
        <div className="flex items-center gap-2">
          <Input
            className="h-8 w-[190px] font-mono text-[12px]"
            value={props.draftName}
            onChange={(e) => props.setDraftName(e.target.value)}
            placeholder="name"
            aria-label="Connection name"
          />
          <Input
            className="h-8 flex-1 font-mono text-[12px]"
            value={props.draftUrl}
            onChange={(e) => props.setDraftUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && props.onAdd()}
            placeholder="postgres://user:password@localhost:5432/postgres"
            aria-label="Connection string"
          />
          <Button onClick={props.onAdd} disabled={props.busy}>
            <Plus />
            Add
          </Button>
        </div>
        <p className="mt-2 font-mono text-[10.5px] text-faint">
          Stored locally in SQLite, in plain text.
        </p>
      </div>
    </div>
  );
}
