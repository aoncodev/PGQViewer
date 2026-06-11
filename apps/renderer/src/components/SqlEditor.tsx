import { useEffect, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLineGutter, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { autocompletion, completionKeymap, type CompletionContext, type Completion } from '@codemirror/autocomplete';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, HighlightStyle } from '@codemirror/language';
import { sql, PostgreSQL } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
import type { Element, GraphMetadata } from '../lib/api';
import { inferBindings } from '../lib/matchBindings';

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

// --- graph-mode schema autocomplete ---------------------------------------
//
// When a GraphMetadata is in scope (graph mode), this source layers
// schema-aware completions on top of the keyword/SQL ones:
//
//   (a)  inside `(...)` after `IS `, suggest vertex labels;
//        inside `[...]` after `IS `, suggest edge labels (kind-aware, the
//        same vertex/edge distinction matchBindings uses);
//   (b)  after `<alias>.`, resolve the alias's element via inferBindings()
//        over the MATCH pattern and suggest that element's property names;
//   (c)  elsewhere in a WHERE expression, suggest the aliases already
//        declared in the pattern.
//
// The source is built as a closure over a getter so the once-initialized
// editor can read the latest metadata without re-creating the view.

const uniq = (xs: string[]): string[] => Array.from(new Set(xs));

// Words that follow SQL's `IS` in a null/boolean test rather than a SQL/PGQ
// label expression. Used to suppress label completion for `x IS NULL` etc. in
// a hand-written GRAPH_TABLE/SQL query. Matched exactly (not as a prefix) so a
// graph label that merely starts with one of these letters — e.g. `node` — is
// still suggested while the user is mid-type.
const IS_SQL_KEYWORD = /^(NULL|NOT|TRUE|FALSE|UNKNOWN|DISTINCT)$/i;

// Collect every distinct label across the given elements.
function labelsOf(elements: Element[]): string[] {
  return uniq(elements.flatMap((e) => e.labels)).sort();
}

// Find the path pattern inferBindings should parse. Two shapes are supported:
//
//   • graph mode: the editor holds the bare pattern, e.g.
//     `(a IS person)-[k]->(b)` — no MATCH/COLUMNS keywords. We treat the whole
//     document as the pattern.
//   • SQL mode: a full `GRAPH_TABLE (g MATCH <pattern> COLUMNS (...))` — we
//     slice out the substring between MATCH and the COLUMNS keyword.
//
// Returning the whole doc in the no-MATCH case is safe: inferBindings is
// itself string-literal- and bracket-aware and ignores anything that isn't a
// top-level element pattern.
function extractMatchPattern(doc: string): string {
  const m = /\bMATCH\b/i.exec(doc);
  if (!m) return doc;
  const rest = doc.slice(m.index + m[0].length);
  const cols = /\bCOLUMNS\b/i.exec(rest);
  return (cols ? rest.slice(0, cols.index) : rest).trim();
}

// Resolve alias → Element using the same inference matchBindings does. We map
// the inferred element_oid back to the full Element so we can read properties.
function aliasElementMap(
  doc: string,
  meta: GraphMetadata,
): Map<string, Element> {
  const out = new Map<string, Element>();
  const pattern = extractMatchPattern(doc);
  if (!pattern.trim()) return out;
  const byOID = new Map<number, Element>();
  for (const e of [...meta.vertices, ...meta.edges]) byOID.set(e.oid, e);
  const r = inferBindings(pattern, meta);
  for (const b of r.bindings) {
    const el = byOID.get(b.element_oid);
    if (el) out.set(b.alias, el);
  }
  return out;
}

// Detect whether the cursor sits inside a top-level `(...)` (vertex) or
// `[...]` (edge) element pattern, scanning backwards from `pos`. String
// literals are skipped so a `(` inside a WHERE string doesn't fool us. Returns
// the enclosing bracket kind, or null when at top level.
function enclosingElementKind(
  doc: string,
  pos: number,
): 'vertex' | 'edge' | null {
  let inString = false;
  // Stack of opener chars so nested parens (e.g. a WHERE expr) resolve to the
  // *innermost* element bracket.
  const stack: string[] = [];
  for (let i = 0; i < pos; i++) {
    const c = doc[i]!;
    if (inString) {
      if (c === "'") {
        if (doc[i + 1] === "'") {
          i++;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      continue;
    }
    if (c === '(' || c === '[') stack.push(c);
    else if (c === ')' || c === ']') stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i] === '[') return 'edge';
    if (stack[i] === '(') return 'vertex';
  }
  return null;
}

function makeGraphCompletions(getMeta: () => GraphMetadata | null) {
  return function graphCompletions(context: CompletionContext) {
    const meta = getMeta();
    if (!meta) return null;
    const doc = context.state.doc.toString();
    const pos = context.pos;
    const before = doc.slice(0, pos);

    // (b) `<alias>.` property completion. Matches the dotted identifier the
    // user is typing, e.g. `a.na`. Resolve the alias to its element via the
    // same inference matchBindings uses, then offer property names.
    const dotted = context.matchBefore(/[A-Za-z_][A-Za-z_0-9]*\.[A-Za-z_0-9]*/);
    if (dotted) {
      const [alias] = dotted.text.split('.');
      const el = aliasElementMap(doc, meta).get(alias!);
      if (el) {
        const dotAt = dotted.from + alias!.length + 1;
        const options: Completion[] = el.properties.map((p) => ({
          label: p.name,
          type: 'property',
          detail: p.type,
          boost: 70,
        }));
        if (options.length > 0) return { from: dotAt, options };
      }
      // Unknown alias / no properties — let other sources try.
      return null;
    }

    // (a) label completion after `IS `. The IS keyword can be followed by a
    // partial label the user is typing. We only fire inside an element
    // bracket so a stray `IS` elsewhere doesn't trigger labels. We also skip
    // SQL null-test keywords (`IS NULL`, `IS NOT TRUE`, …) so a predicate like
    // `WHERE (x IS NULL)` in a hand-written GRAPH_TABLE/SQL query doesn't get
    // label suggestions.
    const afterIs = /\bIS\s+([A-Za-z_][A-Za-z_0-9]*)?$/i.exec(before);
    if (afterIs && !IS_SQL_KEYWORD.test(afterIs[1] ?? '')) {
      const kind = enclosingElementKind(doc, pos);
      if (kind) {
        const pool = kind === 'vertex' ? meta.vertices : meta.edges;
        const labels = labelsOf(pool);
        const typed = afterIs[1] ?? '';
        const from = pos - typed.length;
        const options: Completion[] = labels.map((label) => ({
          label,
          type: 'class',
          detail: kind === 'vertex' ? 'vertex label' : 'edge label',
          boost: 80,
        }));
        if (options.length > 0) return { from, options };
      }
    }

    // (c) bare-identifier completion: suggest aliases already declared in the
    // pattern (useful in a WHERE expression). Only when there's a word to
    // complete or the user explicitly asked.
    const word = context.matchBefore(/[A-Za-z_][A-Za-z_0-9]*/);
    if (word && (word.from !== word.to || context.explicit)) {
      const aliases = Array.from(aliasElementMap(doc, meta).keys());
      if (aliases.length > 0) {
        const options: Completion[] = aliases.map((alias) => ({
          label: alias,
          type: 'variable',
          detail: 'alias',
          boost: 60,
        }));
        return { from: word.from, options };
      }
    }

    return null;
  };
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
  /**
   * Graph-mode metadata. When present (graph mode), enables schema-aware
   * autocomplete: label suggestions after `IS` inside `(...)` / `[...]`,
   * `<alias>.property` suggestions, and declared-alias suggestions in WHERE.
   * Null/undefined (SQL mode) leaves the editor's SQL completion unchanged.
   */
  graphMeta?: GraphMetadata | null;
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
  graphMeta,
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
  // Latest graph metadata, read by the graph completion source. Held in a ref
  // so the editor (initialized once) always sees current metadata without a
  // reconfigure on every metadata change.
  const graphMetaRef = useRef<GraphMetadata | null>(graphMeta ?? null);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
    onChangeRef.current = onChange;
    onHistoryPrevRef.current = onHistoryPrev;
    onHistoryNextRef.current = onHistoryNext;
    graphMetaRef.current = graphMeta ?? null;
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
        autocompletion({
          override: [makeGraphCompletions(() => graphMetaRef.current), pgqCompletions],
        }),
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
