/* Monaco wiring for the SQL editor.
 *
 * We bundle Monaco rather than pulling it from a CDN: the app runs in a native
 * WebView that may have no network at all, so a lazy loader would leave the
 * editor permanently blank. Vite's `?worker` import inlines the worker for us.
 *
 * Everything here runs once at module load. The only moving part is the
 * completion schema, which App refreshes whenever the connection changes. */
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

/* Monaco's default entry registers ~80 tokenizers and four language services
 * (TS, CSS, HTML, JSON) we will never use — about 4 MB of dead weight. Import
 * the SQL grammar and the editor behaviours we actually want instead.
 * These are deep paths into the package; if a Monaco upgrade moves them, the
 * build fails loudly rather than silently degrading. */
import "monaco-editor/languages/definitions/pgsql/register.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import type { TableRef } from "./parse";

// SQL has no language server, so the plain editor worker covers every model.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/* Theme colours are the CSS custom properties from index.css, hardcoded because
 * Monaco's theme API takes literal hex and cannot read var(). If you retune the
 * palette there, retune it here too. */
monaco.editor.defineTheme("artemis", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "dfe3e6" },
    { token: "keyword", foreground: "ffb000" }, // amber = the SQL verbs
    { token: "operator", foreground: "7d868c" },
    { token: "delimiter", foreground: "7d868c" },
    { token: "string", foreground: "9ec7a0" },
    { token: "number", foreground: "9ec7a0" },
    { token: "comment", foreground: "4c5459", fontStyle: "italic" },
    { token: "predefined", foreground: "8fb4d4" },
    { token: "identifier.quote", foreground: "8fb4d4" },
  ],
  colors: {
    "editor.background": "#0b0c0d",
    "editor.foreground": "#dfe3e6",
    "editor.placeholder.foreground": "#4c5459", // --faint
    "editorLineNumber.foreground": "#2f3436",
    "editorLineNumber.activeForeground": "#7d868c",
    "editorCursor.foreground": "#ffb000",
    "editor.selectionBackground": "#232729",
    "editor.lineHighlightBackground": "#101214",
    "editorWidget.background": "#16191c",
    "editorWidget.border": "#232729",
    "editorSuggestWidget.background": "#16191c",
    "editorSuggestWidget.border": "#232729",
    "editorSuggestWidget.selectedBackground": "#232729",
    "editorSuggestWidget.highlightForeground": "#ffb000",
    "scrollbarSlider.background": "#23272980",
    "scrollbarSlider.hoverBackground": "#232729",
  },
});

/* Upper-cases SQL keywords as you finish typing them, the way every other SQL
 * console does. Returns a disposable; the editor owns the lifetime.
 *
 * What counts as a keyword is decided by Monaco's own tokenizer rather than a
 * word list of ours. That is the whole trick: the tokenizer already knows that
 * the `select` inside '...' is a string, that the one after `--` is a comment,
 * and that "select" in double quotes is a quoted identifier — none of which may
 * be touched. A hand-rolled list would mangle all three. */
export function installKeywordUpcase(
  editor: monaco.editor.IStandaloneCodeEditor,
): monaco.IDisposable {
  let rewriting = false; // our own edit re-enters this handler; ignore it

  return editor.onDidChangeModelContent((event) => {
    if (rewriting) return;

    const model = editor.getModel();
    if (!model) return;

    // Only react to a single plain insertion whose first character closes a
    // word — the space, comma, paren or newline that means "done typing it".
    // Anything else (deletes, multi-cursor, accepted completions) is left be.
    if (event.changes.length !== 1) return;
    const change = event.changes[0];
    if (change.rangeLength !== 0 || change.text.length === 0) return;
    if (/^[\w$]/.test(change.text)) return;

    // The word ends exactly where the typed character was inserted. Deriving
    // the boundary from the change rather than from the cursor matters: on
    // Enter the cursor has already jumped to the next line by now.
    const boundary = {
      lineNumber: change.range.startLineNumber,
      column: change.range.startColumn,
    };
    const word = model.getWordUntilPosition(boundary);
    if (!word.word || word.word === word.word.toUpperCase()) return;

    const tokens = monaco.editor.tokenize(model.getValue(), model.getLanguageId());
    const lineTokens = tokens[boundary.lineNumber - 1];
    if (!lineTokens) return;

    // Tokens carry 0-based offsets; find the one covering the word's start.
    const offset = word.startColumn - 1;
    let type = "";
    for (const token of lineTokens) {
      if (token.offset > offset) break;
      type = token.type;
    }
    if (!type.startsWith("keyword")) return;

    rewriting = true;
    try {
      // Same-length replacement entirely behind the caret, so the caret does
      // not move. No undo stop: this stays part of the surrounding typing, so
      // one undo takes back the word rather than just its capitalisation.
      editor.executeEdits("keyword-upcase", [
        {
          range: {
            startLineNumber: boundary.lineNumber,
            endLineNumber: boundary.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          },
          text: word.word.toUpperCase(),
        },
      ]);
    } finally {
      rewriting = false;
    }
  });
}

/* Live schema for completions. App owns the data; we keep a module-level copy
 * so the provider below can stay registered exactly once — re-registering it
 * per render would stack duplicate suggestions. */
let schemaTables: TableRef[] = [];
let schemaColumns: string[] = [];

export function setCompletionSchema(tables: TableRef[], columns: string[]) {
  schemaTables = tables;
  schemaColumns = columns;
}

monaco.languages.registerCompletionItemProvider("pgsql", {
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };

    const suggestions: monaco.languages.CompletionItem[] = [];

    for (const t of schemaTables) {
      // Offer the bare name, but insert the qualified one — unqualified names
      // break as soon as the query touches a second schema.
      suggestions.push({
        label: t.name,
        detail: t.schema,
        kind: monaco.languages.CompletionItemKind.Struct,
        insertText: t.schema === "public" ? t.name : `${t.schema}.${t.name}`,
        range,
      });
    }

    // Columns come from the current result set, so they are only useful once a
    // query has run — which is exactly when you want to refine it.
    for (const c of schemaColumns) {
      suggestions.push({
        label: c,
        detail: "column",
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: c,
        range,
      });
    }

    return { suggestions };
  },
});

export default monaco;
