import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLineGutter, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion, completionKeymap, type CompletionContext, type Completion } from '@codemirror/autocomplete';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle } from '@codemirror/language';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';

// --- SQL/PGQ keyword tweaks ------------------------------------------------

// PostgreSQL 19 SQL/PGQ adds GRAPH_TABLE, MATCH, IS, COLUMNS, PROPERTY GRAPH,
// VERTEX/NODE/EDGE/RELATIONSHIP, SOURCE/DESTINATION KEY, REFERENCES, LABEL.
// @codemirror/lang-sql highlights regular SQL keywords; we layer PGQ-specific
// completions on top via an autocomplete source.
const PGQ_KEYWORDS = [
  'GRAPH_TABLE',
  'MATCH',
  'COLUMNS',
  'IS',
  'PROPERTY',
  'GRAPH',
  'PROPERTY GRAPH',
  'VERTEX',
  'EDGE',
  'NODE',
  'RELATIONSHIP',
  'TABLES',
  'SOURCE',
  'DESTINATION',
  'KEY',
  'REFERENCES',
  'LABEL',
  'DEFAULT LABEL',
  'PROPERTIES',
  'ALL COLUMNS',
  'NO PROPERTIES',
];

function pgqCompletions(context: CompletionContext) {
  const word = context.matchBefore(/[\w_]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const options: Completion[] = PGQ_KEYWORDS.map((label) => ({
    label,
    type: 'keyword',
    boost: 50,
  }));
  return { from: word.from, options };
}

// --- theme ----------------------------------------------------------------

// Editor surface theme: all colors come from CSS variables so it follows
// the app's light/dark toggle without needing JS to re-style.
const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--fg)',
    backgroundColor: 'var(--bg)',
    fontSize: '13px',
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg-subtle)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--surface-2) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in oklch, var(--surface-2) 60%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--accent) 30%, transparent)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    border: '1px solid var(--border)',
    color: 'var(--fg)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'color-mix(in oklch, var(--accent) 25%, transparent)',
  },
});

// Highlight palette tuned to work on both themes. Light/dark choose hues
// with enough chroma in both directions.
const editorHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'oklch(0.55 0.18 250)', fontWeight: 'bold' },
  { tag: t.operator, color: 'var(--fg-muted)' },
  { tag: t.string, color: 'oklch(0.55 0.22 25)' },
  { tag: t.number, color: 'oklch(0.55 0.18 70)' },
  { tag: t.comment, color: 'var(--fg-subtle)', fontStyle: 'italic' },
  { tag: t.variableName, color: 'var(--fg)' },
  { tag: t.typeName, color: 'oklch(0.55 0.16 285)' },
  { tag: t.propertyName, color: 'oklch(0.58 0.16 158)' },
]);

// --- React wrapper --------------------------------------------------------

interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  /** Walk one step back into the per-mode query history. Called from the
   *  Ctrl/Cmd-↑ keybinding. Implementer is expected to update `value`
   *  via its own state path. */
  onHistoryPrev?: () => void;
  /** Walk one step forward (toward the live draft) in query history. */
  onHistoryNext?: () => void;
  placeholder?: string;
  /**
   * Schema autocomplete: maps a top-level alias (e.g. "people") to a list of
   * column names. Used by lang-sql's built-in completion.
   */
  schema?: Record<string, string[]>;
  className?: string;
  minHeight?: string;
  /**
   * Explicit height in pixels. When supplied, takes precedence over
   * minHeight — useful when the editor's height is owned by a parent
   * Splitter.
   */
  heightPx?: number;
}

export function SqlEditor({
  value,
  onChange,
  onSubmit,
  onHistoryPrev,
  onHistoryNext,
  placeholder,
  schema,
  className,
  minHeight = '120px',
  heightPx,
}: SqlEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompRef = useRef(new Compartment());
  const onSubmitRef = useRef(onSubmit);
  const onChangeRef = useRef(onChange);
  const onHistoryPrevRef = useRef(onHistoryPrev);
  const onHistoryNextRef = useRef(onHistoryNext);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onChangeRef.current = onChange;
    onHistoryPrevRef.current = onHistoryPrev;
    onHistoryNextRef.current = onHistoryNext;
  });

  // Initialize once.
  useEffect(() => {
    if (!hostRef.current) return;

    const baseState = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(editorHighlight),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        autocompletion({ override: [pgqCompletions] }),
        langCompRef.current.of(sql({ dialect: PostgreSQL, schema })),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onSubmitRef.current?.();
              return true;
            },
          },
          // Query history navigation. Mod = Ctrl on Linux/Windows, Cmd on
          // Mac. Doesn't conflict with built-in CodeMirror bindings — vanilla
          // ArrowUp/Down still moves the caret line by line.
          {
            key: 'Mod-ArrowUp',
            run: () => {
              if (!onHistoryPrevRef.current) return false;
              onHistoryPrevRef.current();
              return true;
            },
          },
          {
            key: 'Mod-ArrowDown',
            run: () => {
              if (!onHistoryNextRef.current) return false;
              onHistoryNextRef.current();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({
          'aria-label': placeholder ?? 'SQL editor',
        }),
      ],
    });

    viewRef.current = new EditorView({ state: baseState, parent: hostRef.current });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // We deliberately initialize once; live updates flow through other effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value → editor when it changes (e.g. when the suggested
  // MATCH updates because the user picked a new graph).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // Hot-swap the SQL dialect's schema when the metadata changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompRef.current.reconfigure(sql({ dialect: PostgreSQL, schema })),
    });
  }, [schema]);

  return (
    <div
      ref={hostRef}
      className={className ?? 'overflow-hidden rounded-md border border-border bg-bg'}
      style={heightPx !== undefined ? { height: heightPx } : { minHeight }}
    />
  );
}
