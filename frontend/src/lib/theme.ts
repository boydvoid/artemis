// Light/dark theme.
//
// The palette itself lives in index.css: `:root` carries light, `.dark`
// carries dark, and everything in the app is drawn from those tokens. All this
// module does is decide which of the two is on the <html> element.
//
// The choice is kept in localStorage rather than the SQLite store even though
// it is a preference, because it has to be readable *synchronously before the
// first paint* — a round trip through the bridge would flash the wrong theme on
// every launch. Same reasoning as ./session.ts: this is window shape, not app
// data, and the native side has no use for it.

import monaco from "./monaco";

export type Theme = "dark" | "light";

const KEY = "artemis:theme";

/// No stored choice means "follow the OS". Once you touch the toggle the
/// choice is explicit and the OS stops being consulted.
function preferred(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch {
    // Private mode, disabled storage: fall back to the OS every launch.
    return null;
  }
}

export function loadTheme(): Theme {
  return stored() ?? preferred();
}

/// The Monaco theme matching the current app theme. Creating an editor sets
/// Monaco's global theme, so a newly mounted editor must be built with this
/// rather than a fixed name — otherwise opening a query tab drags the whole
/// editor service back to whichever theme was hardcoded.
export function editorThemeName(theme: Theme = loadTheme()): string {
  return theme === "dark" ? "artemis" : "artemis-light";
}

/// Paints the theme. Monaco cannot read CSS custom properties, so its own
/// theme is switched in the same breath as the class — otherwise the editor
/// stays dark inside a light app.
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  monaco.editor.setTheme(editorThemeName(theme));
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}
