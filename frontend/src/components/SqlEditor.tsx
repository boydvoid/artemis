/* Monaco, wrapped thin. The editor instance owns its own text; React only
 * pushes a value in when it changed somewhere else (loading a saved query,
 * switching tabs) — writing on every keystroke would fight the cursor. */
import { useEffect, useRef } from "react";
import type * as Monaco from "monaco-editor";
import monaco, { installKeywordUpcase } from "@/lib/monaco";
import { cn } from "@/lib/utils";

export default function SqlEditor(props: {
  value: string;
  /// The text to run: the selection when there is one, the whole box
  /// otherwise. The caller never has to ask which.
  onRun: (sql: string) => void;
  onChange: (v: string) => void;
  /// Fires when the selection turns into text or back into a bare caret, so
  /// the Run button outside can say which of the two it will run.
  onSelectionChange?: (selected: boolean) => void;
  /// Filled with the editor's own run trigger. A button outside the editor
  /// cannot see the selection; going through here means ⌘↵ and the button
  /// run exactly the same thing.
  runRef?: React.RefObject<(() => void) | null>;
  className?: string;
  style?: React.CSSProperties;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // Callbacks change identity every render; the editor is built once. Route
  // them through refs so the mount effect never needs them as deps.
  const onRunRef = useRef(props.onRun);
  const onChangeRef = useRef(props.onChange);
  const onSelectionChangeRef = useRef(props.onSelectionChange);
  onRunRef.current = props.onRun;
  onChangeRef.current = props.onChange;
  onSelectionChangeRef.current = props.onSelectionChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const editor = monaco.editor.create(host, {
      value: props.value,
      language: "pgsql", // the backend is psql; pgsql knows its functions
      theme: "artemis",
      placeholder: "SELECT * FROM ...",
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 12.5,
      lineHeight: 19,
      minimap: { enabled: false },
      lineNumbersMinChars: 2,
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 6,
      renderLineHighlight: "none",
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      automaticLayout: true, // the host div is user-resizable
      padding: { top: 6, bottom: 6 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      tabSize: 2,
      wordWrap: "on",
      contextmenu: false,
      quickSuggestions: { other: true, comments: false, strings: false },
    });
    editorRef.current = editor;

    const upcase = installKeywordUpcase(editor);
    editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));

    // Highlight some SQL and that is what runs — the rest of the box is
    // scratch. Whitespace-only selections don't count: dragging past the end
    // of a statement should still run the box, not nothing.
    function selectedSql(): string {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model || selection.isEmpty()) return "";
      const text = model.getValueInRange(selection);
      return text.trim().length > 0 ? text : "";
    }
    function runNow() {
      onRunRef.current(selectedSql() || editor.getValue());
    }

    // Cmd/Ctrl+Enter runs, matching every other SQL console.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runNow);
    if (props.runRef) props.runRef.current = runNow;

    let selected = false;
    const selectionWatch = editor.onDidChangeCursorSelection(() => {
      const next = selectedSql().length > 0;
      if (next === selected) return; // fires per keystroke; the flag rarely moves
      selected = next;
      onSelectionChangeRef.current?.(next);
    });

    return () => {
      if (props.runRef) props.runRef.current = null;
      onSelectionChangeRef.current?.(false);
      selectionWatch.dispose();
      upcase.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // Mount-only: `value` is seeded here and reconciled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && props.value !== editor.getValue()) editor.setValue(props.value);
  }, [props.value]);

  return (
    <div
      ref={hostRef}
      className={cn(
        "overflow-hidden rounded-md border border-input bg-background",
        props.className,
      )}
      style={props.style}
      aria-label="SQL editor"
    />
  );
}
