// The light/dark switch: a two-position segmented control, not a checkbox.
//
// Both destinations are shown at once so the control says what it will do
// rather than what it currently is — a lone moon icon is ambiguous about
// whether it means "you are in dark" or "click for dark".

import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Theme } from "@/lib/theme";

const OPTIONS: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

export default function ThemeToggle(props: {
  theme: Theme;
  setTheme: (next: Theme) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex flex-none items-center gap-0.5 rounded-full border border-hairline bg-background/60 p-0.5",
        props.className,
      )}
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = props.theme === value;
        return (
          <button
            key={value}
            className={cn(
              "flex size-[22px] items-center justify-center rounded-full transition-colors",
              active
                ? "bg-card text-foreground shadow-[0_1px_2px_var(--shadow)]"
                : "text-faint hover:text-foreground",
            )}
            onClick={() => props.setTheme(value)}
            aria-pressed={active}
            title={`${label} theme`}
          >
            <Icon className="size-3" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
