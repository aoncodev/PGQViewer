import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelQuery,
  streamExpand,
  streamQuery,
  type MetaEvent,
  type QueryEvent,
} from '../lib/api';
import { formatElementId } from '../lib/elementId';
import { matchHint, type ErrorHintAction } from '../lib/errors';
import { parseGraphTableSql } from '../lib/graphTableSql';
import { buildTemplates, type MatchTemplate } from '../lib/graphTemplates';
import { inferBindings, type InferResult } from '../lib/matchBindings';
import {
  addSavedQuery,
  loadSavedQueries,
  removeSavedQuery,
  type SavedQuery,
} from '../lib/savedQueries';
import { readFlag, readJSON, readNumber } from '../lib/storage';
import { useApp, type EdgeLink, type VertexNode } from '../lib/store';
import { useDragResize } from '../lib/useDragResize';
import { BindingPreview } from './BindingPreview';
import { EdgeWeightModal } from './EdgeWeightModal';
import { ExplainPanel } from './ExplainPanel';
import { GeneratedSqlPanel } from './GeneratedSqlPanel';
import { GraphCanvas } from './GraphCanvas';
import { GraphFilterModal } from './GraphFilterModal';
import { HintPopover } from './HintPopover';
import { JsonView } from './JsonView';
import { Splitter } from './Splitter';
import { SqlEditor } from './SqlEditor';
import { TableView } from './TableView';

// Layout declutter (2026-06): rarely-used query-panel surfaces are hidden for
// now to keep the editor area calm. The components and their wiring are kept
// intact — flip any flag to true to bring the surface back.
const SHOW_LATERAL_PANE = false;
const SHOW_BINDING_PREVIEW = false;
const SHOW_TEMPLATES = false;
const SHOW_SAVED_QUERIES = false;

type Mode = 'graph' | 'sql';
type ResultTab = 'graph' | 'table' | 'json' | 'explain';

interface Stats {
  rows: number;
  // Note: vertex/edge counts come from the store (post-dedup) and live on
  // StatsLine as separate props — see Workspace footer. The stream-event
  // `vertices`/`edges` numbers are emit counts (rows × endpoints) and
  // would mislead anyone reading them as "what's on the canvas".
  elapsed?: number;
  command?: string;
}

// Rehydrate per-mode query history from localStorage at first mount. Best-
// effort: invalid JSON or schema drift returns an empty list.
function readHistory(key: string): string[] {
  return readJSON<string[]>(
    key,
    (v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined),
    [],
  );
}

export function Workspace() {
  const sid = useApp((s) => s.sid);
  const metadata = useApp((s) => s.metadata);
  const selectedGraphOID = useApp((s) => s.selectedGraphOID);
  // Footer stats reflect what's on the canvas (post-dedup) — pull the live
  // store Maps so the counts re-render as elements stream in.
  const vertices = useApp((s) => s.vertices);
  const edges = useApp((s) => s.edges);
  const bulkApply = useApp((s) => s.bulkApply);
  const setResultColumns = useApp((s) => s.setResultColumns);
  const clearResult = useApp((s) => s.clearResult);
  const busy = useApp((s) => s.busy);
  const setBusy = useApp((s) => s.setBusy);
  const pushToast = useApp((s) => s.pushToast);
  const focusMode = useApp((s) => s.focusMode);

  const [mode, setMode] = useState<Mode>('graph');
  const [tab, setTab] = useState<ResultTab>('graph');
  const [matchText, setMatchText] = useState('');
  const [sqlText, setSqlText] = useState('SELECT * FROM people LIMIT 100;');
  const [stats, setStats] = useState<Stats | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [qid, setQid] = useState<string | null>(null);
  const [paramsText, setParamsText] = useState('');
  // Graph-mode dedicated WHERE predicate. matchText stays the pure pattern;
  // this rides along as request.where so the server appends a top-level
  // WHERE to the generated GRAPH_TABLE.
  const [whereText, setWhereText] = useState('');
  // Lateral FROM disclosure. fromText is a newline-separated list of FROM
  // items; lateralAlias names the GRAPH_TABLE reference for correlation.
  const [fromText, setFromText] = useState('');
  const [lateralAlias, setLateralAlias] = useState('');
  // EXPLAIN toggle: 'off' runs normally, 'explain' asks for the plan,
  // 'analyze' runs EXPLAIN ANALYZE (actually executes).
  const [explainMode, setExplainMode] = useState<'off' | 'explain' | 'analyze'>(
    'off',
  );
  // Generated GRAPH_TABLE SQL + per-binding summary, captured from the meta
  // event of the most recent graph-mode run.
  const [genSql, setGenSql] = useState<string | null>(null);
  const [genBindings, setGenBindings] = useState<MetaEvent['bindings']>(undefined);
  // Query plan from the most recent EXPLAIN run. Null = no plan to show.
  const [explainPlan, setExplainPlan] = useState<unknown | null>(null);
  // Live binding preview for the current MATCH pattern (debounced).
  const [bindingPreview, setBindingPreview] = useState<InferResult | null>(null);
  // Named saved queries (localStorage).
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() =>
    loadSavedQueries(),
  );
  // Graph-mode LIMIT. Default 500 — small enough that the canvas first-paint
  // is meaningful even on million-element graphs, large enough that
  // 1k-edge demo graphs land in one shot. Last-used value persists per
  // browser; users on big graphs will leave it at e.g. 100, users on
  // small ones will crank it up.
  const RUN_LIMIT_KEY = 'pgviewer.runLimit';
  const RUN_LIMIT_DEFAULT = 500;
  const RUN_LIMIT_MAX = 10_000;
  const [runLimit, setRunLimitState] = useState<number>(() => {
    const n = readNumber(RUN_LIMIT_KEY, RUN_LIMIT_DEFAULT);
    if (n < 1) return RUN_LIMIT_DEFAULT;
    return Math.min(Math.floor(n), RUN_LIMIT_MAX);
  });
  function setRunLimit(n: number) {
    const clamped = Math.max(1, Math.min(Math.floor(n), RUN_LIMIT_MAX));
    setRunLimitState(clamped);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(RUN_LIMIT_KEY, String(clamped));
    }
  }
  const [editorCollapsed, setEditorCollapsedState] = useState<boolean>(() =>
    readFlag('pgviewer.editor.collapsed'),
  );
  function setEditorCollapsed(v: boolean) {
    setEditorCollapsedState(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('pgviewer.editor.collapsed', v ? '1' : '0');
    }
  }
  const abortRef = useRef<AbortController | null>(null);
  // Per-run flag for auto-collapse: set true when a run starts, cleared by any
  // error (thrown or in-band 'error' event) or abort, so a FAILED run keeps the
  // editor expanded (the error hint lives there). Session-only — auto-collapse
  // deliberately does not persist, so a page reload always starts expanded.
  const collapseAfterRunRef = useRef(false);
  // Pending events accumulate here between microtask flushes. Coalescing
  // many NDJSON lines into one store mutation cuts the streaming path from
  // O(N²) (one Map copy per event) to O(N) (one Map copy per batch).
  const pendingRef = useRef<{
    v: VertexNode[];
    e: EdgeLink[];
    r: unknown[][];
    scheduled: boolean;
  }>({ v: [], e: [], r: [], scheduled: false });

  // Per-mode query history. `entries` is oldest→newest; cursor counts back
  // from newest (0 = most recent), null = "live draft" (the text the user
  // was composing before they started navigating). draft preserves the
  // pre-navigation text so Ctrl-↓ past the newest entry restores it.
  // Persisted to localStorage.
  const HISTORY_MAX = 20;
  const HISTORY_KEY = (m: Mode) => `pgviewer.history.${m}`;
  const historyRef = useRef<{
    graph: { entries: string[]; cursor: number | null; draft: string };
    sql: { entries: string[]; cursor: number | null; draft: string };
  }>({
    graph: {
      entries: readHistory(HISTORY_KEY('graph')),
      cursor: null,
      draft: '',
    },
    sql: {
      entries: readHistory(HISTORY_KEY('sql')),
      cursor: null,
      draft: '',
    },
  });

  function pushHistory(m: Mode, text: string) {
    const t = text.trim();
    if (!t) return;
    const h = historyRef.current[m];
    // Deduplicate adjacent: pressing Run twice doesn't double-add.
    if (h.entries.length > 0 && h.entries[h.entries.length - 1] === t) return;
    h.entries.push(t);
    if (h.entries.length > HISTORY_MAX) {
      h.entries.splice(0, h.entries.length - HISTORY_MAX);
    }
    h.cursor = null;
    h.draft = '';
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(HISTORY_KEY(m), JSON.stringify(h.entries));
      } catch {
        /* localStorage full or disabled — fine to lose history. */
      }
    }
  }

  function historyPrev() {
    const m = mode;
    const h = historyRef.current[m];
    if (h.entries.length === 0) return;
    if (h.cursor === null) {
      // First nav step — stash the live draft so Ctrl-↓ past newest restores.
      h.draft = m === 'graph' ? matchText : sqlText;
      h.cursor = 0;
    } else if (h.cursor < h.entries.length - 1) {
      h.cursor += 1;
    } else {
      return; // already at the oldest
    }
    const idx = h.entries.length - 1 - h.cursor;
    const text = h.entries[idx] ?? '';
    if (m === 'graph') setMatchText(text);
    else setSqlText(text);
  }

  function historyNext() {
    const m = mode;
    const h = historyRef.current[m];
    if (h.cursor === null) return;
    if (h.cursor === 0) {
      // Back past newest → restore the live draft.
      h.cursor = null;
      if (m === 'graph') setMatchText(h.draft);
      else setSqlText(h.draft);
      h.draft = '';
      return;
    }
    h.cursor -= 1;
    const idx = h.entries.length - 1 - h.cursor;
    const text = h.entries[idx] ?? '';
    if (m === 'graph') setMatchText(text);
    else setSqlText(text);
  }

  // Reset history cursor when the user types directly into the editor. That
  // way, after navigating to an old entry and editing it, the next Ctrl-↑
  // restarts from the most recent entry rather than continuing the walk.
  function resetHistoryCursor(m: Mode) {
    const h = historyRef.current[m];
    if (h.cursor !== null) {
      h.cursor = null;
      h.draft = '';
    }
  }

  function flushPending() {
    const p = pendingRef.current;
    if (p.v.length === 0 && p.e.length === 0 && p.r.length === 0) return;
    const vs = p.v;
    const es = p.e;
    const rs = p.r;
    p.v = [];
    p.e = [];
    p.r = [];
    bulkApply(vs, es, rs);
  }

  function scheduleFlush() {
    const p = pendingRef.current;
    if (p.scheduled) return;
    p.scheduled = true;
    queueMicrotask(() => {
      p.scheduled = false;
      flushPending();
    });
  }
  const {
    size: editorHeight,
    startDrag: startEditorResize,
    reset: resetEditorHeight,
  } = useDragResize({
    storageKey: 'pgviewer.editor.height',
    defaultSize: 160,
    min: 80,
    max: 600,
    axis: 'y',
  });

  // Default tab follows mode unless the user has clicked another.
  useEffect(() => {
    setTab(mode === 'graph' ? 'graph' : 'table');
  }, [mode]);

  const suggested = useMemo(() => suggestMatch(metadata), [metadata]);
  useEffect(() => {
    if (suggested) setMatchText(suggested);
  }, [suggested]);

  const editorSchema = useMemo(() => {
    if (!metadata) return undefined;
    const out: Record<string, string[]> = {};
    for (const e of [...metadata.vertices, ...metadata.edges]) {
      out[e.alias] = e.properties.map((p) => p.name);
      out[e.table.name] = e.properties.map((p) => p.name);
      for (const label of e.labels) out[label] = e.properties.map((p) => p.name);
    }
    return out;
  }, [metadata]);

  // MATCH templates derived from the selected graph's labels.
  const templates = useMemo(() => buildTemplates(metadata), [metadata]);

  // Live binding preview: debounce inferBindings on the MATCH pattern so we
  // can show alias→label chips and "won't be drawn" warnings BEFORE running.
  // Graph mode only; cleared otherwise so a stale preview doesn't linger.
  useEffect(() => {
    if (mode !== 'graph' || !metadata) {
      setBindingPreview(null);
      return;
    }
    const text = matchText.trim();
    if (!text) {
      setBindingPreview(null);
      return;
    }
    const handle = window.setTimeout(() => {
      setBindingPreview(inferBindings(matchText, metadata));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [matchText, metadata, mode]);

  // Append snippets dispatched from elsewhere (e.g. sidebar element clicks).
  // The store carries the target mode; if the user is in a different mode we
  // hop to it so the insert lands somewhere visible.
  const pendingInsert = useApp((s) => s.pendingInsert);
  const clearPendingInsert = useApp((s) => s.clearPendingInsert);
  useEffect(() => {
    if (!pendingInsert) return;
    setMode(pendingInsert.mode);
    if (pendingInsert.mode === 'graph') {
      setMatchText(pendingInsert.text);
    } else {
      setSqlText(pendingInsert.text);
    }
    clearPendingInsert();
  }, [pendingInsert, clearPendingInsert]);

  // Pass the active editor text so matchHint can heuristically detect
  // user-typed quantifier shapes that PG19 returns as a generic syntax
  // error (e.g. `[k*1..3]` → `syntax error at or near "*"`). Without the
  // query text those errors slip past the pattern matcher.
  const hint = lastError
    ? matchHint(lastError, mode === 'graph' ? matchText : sqlText)
    : null;

  async function run() {
    if (!sid || busy) return;
    // Push to history at the start of the run so even a query that errors
    // is recallable. Deduplication of identical adjacent entries is in
    // pushHistory.
    pushHistory(mode, mode === 'graph' ? matchText : sqlText);
    setStats(null);
    setLastError(null);
    setQid(null);
    // Assume success; any error path below clears this so we don't collapse.
    collapseAfterRunRef.current = true;
    // Clear any prior captured SQL / plan so the panels reflect THIS run.
    setGenSql(null);
    setGenBindings(undefined);
    setExplainPlan(null);
    setBusy(true);
    // Drop any leftover-but-not-yet-flushed events from the previous run.
    // Without this, a microtask scheduled by the prior stream could fire
    // AFTER clearResult() and dump stale vertices into the fresh canvas.
    const p = pendingRef.current;
    p.v = [];
    p.e = [];
    p.r = [];
    clearResult();

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (mode === 'graph') {
        if (!metadata) throw new Error('No graph selected');
        const bindings = inferBindings(matchText, metadata);
        if (bindings.error) throw new Error(bindings.error);
        // Non-fatal: unaliased/abbreviated elements match but aren't
        // projected, so the canvas under-draws the result. Tell the user
        // why a node might look disconnected instead of leaving them to
        // distrust the renderer.
        bindings.warnings?.forEach((w) => pushToast('info', w));
        const fromItems = parseLines(fromText);
        const params = parseParams(paramsText);
        await streamQuery(
          sid,
          {
            mode: 'graph',
            graph_oid: metadata.graph.oid,
            match: matchText,
            where: whereText.trim() || undefined,
            bindings: bindings.bindings,
            limit: runLimit,
            from: fromItems.length > 0 ? fromItems : undefined,
            lateral_alias: lateralAlias.trim() || undefined,
            params: params ?? undefined,
            explain: explainMode === 'explain' || undefined,
            explain_analyze: explainMode === 'analyze' || undefined,
          },
          handleEvent,
          controller.signal,
          (q) => setQid(q),
        );
      } else {
        const params = parseParams(paramsText);
        await streamQuery(
          sid,
          { mode: 'sql', sql: sqlText, params: params ?? undefined },
          handleEvent,
          controller.signal,
          (q) => setQid(q),
        );
      }
    } catch (e) {
      // A failed/aborted run must keep the editor open (the hint lives there).
      collapseAfterRunRef.current = false;
      // AbortError = user clicked Cancel; don't surface that as an error.
      if (e instanceof DOMException && e.name === 'AbortError') {
        pushToast('info', 'Query cancelled');
      } else {
        const msg = String(e instanceof Error ? e.message : e);
        pushToast('error', msg);
        setLastError(msg);
      }
    } finally {
      // Ensure any tail batch lands even when the stream was torn down
      // mid-flight (abort, error).
      flushPending();
      setBusy(false);
      setQid(null);
      abortRef.current = null;
      // Auto-collapse the editor after a clean run so the result/canvas gets
      // the space. Cleared on error/abort above so the hint stays visible.
      // Non-persisting setter: collapse is session-only (reload starts open).
      if (collapseAfterRunRef.current) setEditorCollapsedState(true);
    }
  }

  // Hand the supplied SQL to SQL mode (used by the Generated SQL panel's
  // "Open in SQL mode" button). Shared with the hint-action wiring below.
  function openInSqlMode(sql: string) {
    resetHistoryCursor('sql');
    setMode('sql');
    setSqlText(sql);
  }

  // Wraps the current MATCH pattern in a runnable GRAPH_TABLE skeleton so the
  // user can finish it by hand in SQL mode. Used by the 'wrap-graph-table'
  // hint action and as a fallback when there's no captured SQL.
  function wrapMatchAsGraphTable(): string {
    const graphName = metadata
      ? metadata.graph.schema && metadata.graph.schema !== 'public'
        ? `${metadata.graph.schema}.${metadata.graph.name}`
        : metadata.graph.name
      : 'your_graph';
    const pattern = matchText.trim() || '(a)-[e]->(b)';
    const whereClause = whereText.trim() ? `\n    WHERE ${whereText.trim()}` : '';
    return `SELECT *\nFROM GRAPH_TABLE (\n  ${graphName}\n  MATCH ${pattern}${whereClause}\n  COLUMNS (a.*)\n);`;
  }

  // Implements the ErrorHintAction kinds surfaced by HintPopover. 'switch-to-
  // sql' just hops modes (carrying any payload SQL); 'wrap-graph-table' seeds
  // SQL mode with a GRAPH_TABLE wrapper around the current pattern.
  function onHintAction(action: ErrorHintAction) {
    if (action.kind === 'switch-to-sql') {
      if (action.payload) openInSqlMode(action.payload);
      else {
        resetHistoryCursor('sql');
        setMode('sql');
      }
    } else if (action.kind === 'wrap-graph-table') {
      openInSqlMode(action.payload ?? wrapMatchAsGraphTable());
    }
  }

  // "View as graph" for a GRAPH_TABLE SQL statement typed in SQL mode. Parses
  // the SQL, checks the graph name matches the selected graph, infers bindings
  // from the MATCH, and runs the auto-projecting graph endpoint so the canvas
  // renders. The user's COLUMNS is intentionally ignored (server projects
  // identity columns itself).
  async function viewAsGraph() {
    if (!sid || busy) return;
    if (!metadata) {
      pushToast('error', 'Select a graph first to view SQL as a graph.');
      return;
    }
    const parsed = parseGraphTableSql(sqlText);
    if (!parsed) {
      pushToast(
        'error',
        'No GRAPH_TABLE(...) found in this SQL. View as graph only works on a top-level GRAPH_TABLE query.',
      );
      return;
    }
    // Compare against the selected graph, tolerating an unqualified name or a
    // schema-qualified one.
    const selected = metadata.graph.name.toLowerCase();
    const selectedQualified = `${metadata.graph.schema}.${metadata.graph.name}`.toLowerCase();
    const parsedName = parsed.graphName.replace(/"/g, '').toLowerCase();
    if (parsedName !== selected && parsedName !== selectedQualified) {
      pushToast(
        'error',
        `This SQL queries graph "${parsed.graphName}", but "${metadata.graph.name}" is selected. Pick that graph in the sidebar, then try again.`,
      );
      return;
    }
    const bindings = inferBindings(parsed.match, metadata);
    if (bindings.error) {
      pushToast('error', bindings.error);
      return;
    }
    bindings.warnings?.forEach((w) => pushToast('info', w));

    setStats(null);
    setLastError(null);
    setQid(null);
    setGenSql(null);
    setGenBindings(undefined);
    setExplainPlan(null);
    setMode('graph');
    setMatchText(parsed.match);
    if (parsed.where !== undefined) setWhereText(parsed.where);
    setTab('graph');
    setBusy(true);
    const p = pendingRef.current;
    p.v = [];
    p.e = [];
    p.r = [];
    clearResult();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamQuery(
        sid,
        {
          mode: 'graph',
          graph_oid: metadata.graph.oid,
          match: parsed.match,
          where: parsed.where,
          bindings: bindings.bindings,
          limit: runLimit,
        },
        handleEvent,
        controller.signal,
        (q) => setQid(q),
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        pushToast('info', 'Query cancelled');
      } else {
        const msg = String(e instanceof Error ? e.message : e);
        pushToast('error', msg);
        setLastError(msg);
      }
    } finally {
      flushPending();
      setBusy(false);
      setQid(null);
      abortRef.current = null;
    }
  }

  // --- saved queries -------------------------------------------------------
  function saveCurrentQuery() {
    const text = (mode === 'graph' ? matchText : sqlText).trim();
    if (!text) {
      pushToast('info', 'Nothing to save — the editor is empty.');
      return;
    }
    const name = window.prompt('Save query as:')?.trim();
    if (!name) return;
    setSavedQueries((prev) =>
      addSavedQuery(prev, {
        name,
        mode,
        text,
        where: mode === 'graph' && whereText.trim() ? whereText.trim() : undefined,
      }),
    );
    pushToast('success', `Saved “${name}”.`);
  }

  function applySavedQuery(q: SavedQuery) {
    setMode(q.mode);
    if (q.mode === 'graph') {
      setMatchText(q.text);
      setWhereText(q.where ?? '');
    } else {
      setSqlText(q.text);
    }
  }

  function deleteSavedQuery(id: string) {
    setSavedQueries((prev) => removeSavedQuery(prev, id));
  }

  async function cancel() {
    if (!sid) return;
    // Abort the client-side stream immediately so the NDJSON reader stops
    // pumping events into the canvas. Without this, the server cancels the
    // PG backend but we keep draining whatever is already in the response
    // buffer.
    abortRef.current?.abort();
    // Drop any queued-but-not-yet-flushed events from the cancelled stream
    // so they don't land in the next query's canvas.
    const p = pendingRef.current;
    p.v = [];
    p.e = [];
    p.r = [];
    if (qid) {
      try {
        await cancelQuery(sid, qid);
      } catch (e) {
        pushToast('error', `Cancel failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Tracks the anchor of an in-flight expand so the canvas can lock existing
  // nodes and lay out only the new neighbourhood (delta-only layout) instead
  // of re-running a global layout that disturbs settled positions.
  const [expandingAnchorId, setExpandingAnchorId] = useState<string | null>(
    null,
  );

  async function expandNeighbors(anchorOID: number, anchorPK: string[]) {
    if (!sid || !selectedGraphOID) return;
    // Mirrors the canvas id synthesis from projection.go:joinKey
    // (`<oid>:<json-array>`). See apps/renderer/src/lib/elementId.ts.
    const anchorCanvasId = formatElementId(anchorOID, anchorPK);
    setExpandingAnchorId(anchorCanvasId);
    setBusy(true);
    try {
      await streamExpand(
        sid,
        selectedGraphOID,
        { anchor_element_oid: anchorOID, anchor_pk: anchorPK, limit: 500 },
        handleEvent,
      );
    } catch (e) {
      pushToast('error', `Expand failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      flushPending();
      setBusy(false);
      setExpandingAnchorId(null);
    }
  }

  function handleEvent(ev: QueryEvent) {
    const p = pendingRef.current;
    switch (ev.type) {
      case 'vertex':
        p.v.push({ id: ev.id, labels: ev.labels, properties: ev.properties });
        scheduleFlush();
        break;
      case 'edge':
        p.e.push({
          id: ev.id,
          source: ev.source,
          destination: ev.destination,
          labels: ev.labels,
          properties: ev.properties,
        });
        scheduleFlush();
        break;
      case 'row':
        p.r.push(ev.row);
        scheduleFlush();
        break;
      // Infrequent events: flush any pending data first so the user never
      // sees "elapsed 200ms" rendered before the vertices it summarises.
      case 'columns':
        flushPending();
        setResultColumns(ev.columns);
        break;
      case 'stats':
        flushPending();
        setStats({
          rows: ev.rows,
          command: ev.command,
        });
        if (ev.truncated) {
          pushToast(
            'info',
            `Element cap reached — canvas shows ${ev.vertices ?? 0} unique vertices and ${ev.edges ?? 0} unique edges. Narrow the MATCH (e.g. add a WHERE) or raise the cap to see more.`,
          );
        }
        break;
      case 'summary':
        flushPending();
        setStats((s) =>
          s ? { ...s, elapsed: ev.elapsed_ms } : { rows: 0, elapsed: ev.elapsed_ms },
        );
        break;
      case 'error':
        flushPending();
        // In-band stream error: don't auto-collapse, the hint must stay visible.
        collapseAfterRunRef.current = false;
        pushToast('error', ev.error);
        setLastError(ev.error);
        break;
      case 'meta':
        if (ev.qid) setQid(ev.qid);
        // Graph-mode meta carries the projected GRAPH_TABLE SQL and the
        // per-binding projection summary; stash both so the Generated SQL
        // panel can render them.
        if (ev.sql !== undefined) setGenSql(ev.sql);
        if (ev.bindings !== undefined) setGenBindings(ev.bindings);
        break;
      case 'explain':
        flushPending();
        setExplainPlan(ev.plan);
        setTab('explain');
        break;
    }
  }

  const editorValue = mode === 'graph' ? matchText : sqlText;
  // Wrap the setter so direct typing also resets the history cursor — that
  // way Ctrl-↑ after an edit starts from the newest entry again, instead of
  // continuing a half-finished walk through old queries.
  const setEditorValue = (v: string) => {
    resetHistoryCursor(mode);
    if (mode === 'graph') setMatchText(v);
    else setSqlText(v);
  };
  const placeholder =
    mode === 'graph'
      ? '(a IS person)-[k IS knows]->(b IS person)'
      : 'SELECT * FROM people;';
  const canRun = !!sid && !busy && (mode === 'sql' || !!metadata);
  const showCancel = busy && !!qid;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      {/* Focus mode hides editor + tabs + stats footer so the canvas
          takes over the workspace. Using `hidden` (display:none) instead
          of conditional render so CodeMirror's editor state survives a
          toggle round-trip. */}
      {editorCollapsed ? (
        <div className={focusMode ? 'hidden' : 'contents'}>
          <CollapsedEditorBar
            mode={mode}
            preview={editorValue}
            busy={busy}
            showCancel={showCancel}
            canRun={canRun}
            onRun={run}
            onCancel={cancel}
            onExpand={() => setEditorCollapsed(false)}
          />
        </div>
      ) : (
      <header className={`border-b border-border bg-surface p-4 ${focusMode ? 'hidden' : ''}`}>
        <div className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <ModeToggle value={mode} onChange={setMode} />
            <span className="text-xs text-fg-subtle">
              {mode === 'graph'
                ? 'MATCH pattern — auto-projected against the selected graph.'
                : 'Raw SQL — runs verbatim. Table output below.'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setEditorCollapsed(true)}
            title="Hide editor (maximise canvas)"
            aria-label="Hide editor"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ChevronUpIcon />
          </button>
        </div>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <SqlEditor
              value={editorValue}
              onChange={setEditorValue}
              onSubmit={run}
              onHistoryPrev={historyPrev}
              onHistoryNext={historyNext}
              schema={editorSchema}
              graphMeta={metadata}
              placeholder={placeholder}
              heightPx={editorHeight}
            />
            <Splitter
              axis="y"
              onMouseDown={startEditorResize}
              onDoubleClick={resetEditorHeight}
              title="Drag to resize the editor · double-click to reset"
            />
            {mode === 'graph' && (
              <>
                <div className="mt-2">
                  <WherePane value={whereText} onChange={setWhereText} />
                </div>
                {SHOW_LATERAL_PANE && (
                  <div className="mt-2">
                    <LateralPane
                      fromText={fromText}
                      onFromChange={setFromText}
                      lateralAlias={lateralAlias}
                      onAliasChange={setLateralAlias}
                    />
                  </div>
                )}
                {SHOW_BINDING_PREVIEW && (
                  <BindingPreview result={bindingPreview} metadata={metadata} />
                )}
                {SHOW_TEMPLATES && templates.length > 0 && (
                  <TemplateGallery
                    templates={templates}
                    onPick={(p) => setEditorValue(p)}
                  />
                )}
                {genSql && (
                  <div className="mt-2">
                    <GeneratedSqlPanel
                      sql={genSql}
                      bindings={genBindings}
                      onOpenInSql={openInSqlMode}
                    />
                  </div>
                )}
              </>
            )}
            {mode === 'sql' && (
              <div className="mt-2">
                <ParamsPane value={paramsText} onChange={setParamsText} />
              </div>
            )}
            {SHOW_SAVED_QUERIES && (
              <SavedQueriesBar
                queries={savedQueries}
                mode={mode}
                onSave={saveCurrentQuery}
                onApply={applySavedQuery}
                onDelete={deleteSavedQuery}
              />
            )}
            {hint && (
              <div className="mt-2">
                <HintPopover
                  hint={hint}
                  rawError={lastError ?? undefined}
                  onDismiss={() => setLastError(null)}
                  onAction={onHintAction}
                />
              </div>
            )}
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-fg-subtle">
              <span>
                <kbd className="rounded bg-surface-2 px-1.5 py-0.5">⌘/Ctrl + Enter</kbd> to run
              </span>
              {mode === 'sql' && (
                <button
                  type="button"
                  onClick={viewAsGraph}
                  disabled={!sid || busy || !metadata}
                  title="Run a GRAPH_TABLE query through the graph endpoint and render it on the canvas"
                  className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  View as graph
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col items-stretch gap-2">
            {mode === 'graph' && (
              <label
                className="flex items-center gap-1.5 text-[11px] text-fg-subtle"
                title="Maximum rows projected from GRAPH_TABLE. Start small on big graphs; raise once you've narrowed your MATCH."
              >
                <span>limit</span>
                <input
                  type="number"
                  min={1}
                  max={RUN_LIMIT_MAX}
                  step={100}
                  value={runLimit}
                  onChange={(e) => setRunLimit(Number(e.target.value) || RUN_LIMIT_DEFAULT)}
                  className="w-20 rounded border border-border bg-surface px-1.5 py-0.5 text-right font-mono text-xs text-fg outline-none focus:border-accent"
                />
              </label>
            )}
            {mode === 'graph' && (
              <label
                className="flex items-center gap-1.5 text-[11px] text-fg-subtle"
                title="EXPLAIN shows the planner's chosen plan without running. ANALYZE runs the query and reports actual timings."
              >
                <span>explain</span>
                <select
                  value={explainMode}
                  onChange={(e) =>
                    setExplainMode(e.target.value as 'off' | 'explain' | 'analyze')
                  }
                  className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent"
                >
                  <option value="off">off</option>
                  <option value="explain">plan</option>
                  <option value="analyze">analyze</option>
                </select>
              </label>
            )}
            {showCancel ? (
              <button
                onClick={cancel}
                className="rounded-md bg-danger px-4 py-2 text-sm font-medium text-danger-fg transition-colors hover:opacity-90"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={run}
                disabled={!canRun}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Running…' : 'Run'}
              </button>
            )}
          </div>
        </div>
      </header>
      )}

      <div className={`flex items-center gap-1 border-b border-border bg-surface px-4 py-1 ${focusMode ? 'hidden' : ''}`}>
        <TabButton active={tab === 'graph'} onClick={() => setTab('graph')} disabled={mode !== 'graph'}>
          Graph
        </TabButton>
        <TabButton active={tab === 'table'} onClick={() => setTab('table')} disabled={mode === 'graph'}>
          Table
        </TabButton>
        <TabButton active={tab === 'json'} onClick={() => setTab('json')}>
          JSON
        </TabButton>
        {explainPlan !== null && (
          <TabButton active={tab === 'explain'} onClick={() => setTab('explain')}>
            Plan
          </TabButton>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'graph' && (
          <GraphCanvas
            onExpand={expandNeighbors}
            expandingAnchorId={expandingAnchorId}
          />
        )}
        {tab === 'table' && <TableView />}
        {tab === 'json' && <JsonView />}
        {tab === 'explain' && explainPlan !== null && (
          <ExplainPanel
            plan={explainPlan}
            onClose={() => {
              setExplainPlan(null);
              setTab(mode === 'graph' ? 'graph' : 'table');
            }}
          />
        )}
      </div>

      <footer className={`border-t border-border bg-surface px-4 py-2 text-xs text-fg-subtle ${focusMode ? 'hidden' : ''}`}>
        <StatsLine
          stats={stats}
          mode={mode}
          nodeCount={vertices.size}
          edgeCount={edges.size}
        />
      </footer>

      {/* Canvas overlay modals — controlled via store.modalOpen. Mounted at
          the workspace level so they layer above the canvas / table panes. */}
      <EdgeWeightModal />
      <GraphFilterModal />
    </main>
  );
}

function ParamsPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-bg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
      >
        <span>Parameters {value.trim() ? '· bound' : '· empty'}</span>
        <span>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder='JSON array, e.g. ["alice", 42]'
          className="block w-full resize-y border-t border-border bg-bg px-3 py-2 font-mono text-xs text-fg outline-none"
          rows={3}
        />
      )}
    </div>
  );
}

// Dedicated WHERE input for graph mode. The pattern stays in the editor; this
// rides along as request.where so the server appends a top-level WHERE.
function WherePane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // Open by default once the user has typed something, so a restored draft is
  // visible without a click.
  const [expanded, setExpanded] = useState(() => value.trim().length > 0);
  return (
    <div className="rounded-md border border-border bg-bg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
      >
        <span>WHERE {value.trim() ? '· set' : '· empty'}</span>
        <span>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Top-level predicate, e.g. a.age > 30 OR b.city = 'NYC'"
          className="block w-full resize-y border-t border-border bg-bg px-3 py-2 font-mono text-xs text-fg outline-none"
          rows={2}
        />
      )}
    </div>
  );
}

// LATERAL FROM disclosure. fromText holds newline-separated FROM items;
// lateralAlias names the GRAPH_TABLE reference so outer items can correlate.
function LateralPane({
  fromText,
  onFromChange,
  lateralAlias,
  onAliasChange,
}: {
  fromText: string;
  onFromChange: (v: string) => void;
  lateralAlias: string;
  onAliasChange: (v: string) => void;
}) {
  const active = fromText.trim().length > 0 || lateralAlias.trim().length > 0;
  const [expanded, setExpanded] = useState(active);
  return (
    <div className="rounded-md border border-border bg-bg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
      >
        <span>Lateral FROM {active ? '· set' : '· empty'}</span>
        <span>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="border-t border-border p-2">
          <label className="mb-2 flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="shrink-0">GRAPH_TABLE alias</span>
            <input
              value={lateralAlias}
              onChange={(e) => onAliasChange(e.target.value)}
              placeholder="gt"
              className="w-24 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-fg outline-none focus:border-accent"
            />
          </label>
          <textarea
            value={fromText}
            onChange={(e) => onFromChange(e.target.value)}
            placeholder={'One FROM item per line, e.g.\nfilters f'}
            className="block w-full resize-y rounded border border-border bg-surface px-2 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent"
            rows={2}
          />
        </div>
      )}
    </div>
  );
}

// Small gallery of MATCH templates derived from the selected graph's labels.
function TemplateGallery({
  templates,
  onPick,
}: {
  templates: MatchTemplate[];
  onPick: (pattern: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
        templates
      </span>
      {templates.map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          onClick={() => onPick(tpl.pattern)}
          title={tpl.pattern}
          className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {tpl.label}
        </button>
      ))}
    </div>
  );
}

// Saved/named queries bar. Lists saved queries for the active mode and lets
// the user save the current one or remove existing ones.
function SavedQueriesBar({
  queries,
  mode,
  onSave,
  onApply,
  onDelete,
}: {
  queries: SavedQuery[];
  mode: Mode;
  onSave: () => void;
  onApply: (q: SavedQuery) => void;
  onDelete: (id: string) => void;
}) {
  const forMode = queries.filter((q) => q.mode === mode);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onSave}
        className="rounded-md border border-border bg-surface px-2 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        Save query
      </button>
      {forMode.length > 0 && (
        <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
          saved
        </span>
      )}
      {forMode.map((q) => (
        <span
          key={q.id}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-fg-muted"
        >
          <button
            type="button"
            onClick={() => onApply(q)}
            title={q.text}
            className="hover:text-fg"
          >
            {q.name}
          </button>
          <button
            type="button"
            onClick={() => onDelete(q.id)}
            aria-label={`Delete saved query ${q.name}`}
            className="text-fg-subtle hover:text-danger"
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

function CollapsedEditorBar({
  mode,
  preview,
  busy,
  showCancel,
  canRun,
  onRun,
  onCancel,
  onExpand,
}: {
  mode: Mode;
  preview: string;
  busy: boolean;
  showCancel: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
  onExpand: () => void;
}) {
  // First non-empty line of the current query, so the bar still tells the
  // user what they're about to re-run.
  const previewLine = preview.split('\n').find((l) => l.trim().length > 0) ?? '';
  return (
    <header className="flex items-center gap-2 border-b border-border bg-surface px-4 py-1.5">
      <button
        type="button"
        onClick={onExpand}
        title="Show editor"
        aria-label="Show editor"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <ChevronDownIcon />
      </button>
      <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {mode === 'graph' ? 'Graph' : 'SQL'}
      </span>
      <button
        type="button"
        onClick={onExpand}
        title="Click to edit the query"
        className="min-w-0 flex-1 cursor-text truncate text-left font-mono text-[11px] text-fg-muted transition-colors hover:text-fg"
      >
        {previewLine || <span className="italic text-fg-subtle">empty query</span>}
      </button>
      {showCancel ? (
        <button
          onClick={onCancel}
          className="shrink-0 rounded-md bg-danger px-3 py-1 text-xs font-medium text-danger-fg transition-colors hover:opacity-90"
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={onRun}
          disabled={!canRun}
          className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Run'}
        </button>
      )}
    </header>
  );
}

function ChevronUpIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-bg p-0.5 text-xs">
      <button
        onClick={() => onChange('graph')}
        className={`rounded px-3 py-1 transition-colors ${
          value === 'graph' ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
        }`}
      >
        Graph mode
      </button>
      <button
        onClick={() => onChange('sql')}
        className={`rounded px-3 py-1 transition-colors ${
          value === 'sql' ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'
        }`}
      >
        SQL mode
      </button>
    </div>
  );
}

function TabButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1 text-xs transition-colors ${
        active ? 'bg-bg text-fg shadow-sm' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function StatsLine({
  stats,
  mode,
  nodeCount,
  edgeCount,
}: {
  stats: Stats | null;
  mode: Mode;
  // Unique counts from the store (post-dedup). For graph mode, these are
  // what the user actually sees on the canvas — so they're what we display
  // here instead of the streamed `vertices`/`edges` event counts, which can
  // be 2× the unique count when one row projects both endpoints of an edge.
  nodeCount: number;
  edgeCount: number;
}) {
  if (!stats) return <span>Edit and run a query. Results stream as they arrive.</span>;
  const parts: string[] = [];
  if (mode === 'graph') {
    parts.push(`${stats.rows.toLocaleString()} match rows`);
    parts.push(`${nodeCount.toLocaleString()} nodes`);
    parts.push(`${edgeCount.toLocaleString()} edges`);
  } else {
    parts.push(`${stats.rows.toLocaleString()} rows`);
    if (stats.command) parts.push(stats.command);
  }
  if (stats.elapsed !== undefined) parts.push(`${stats.elapsed}ms`);
  return <span>{parts.join(' · ')}</span>;
}

function suggestMatch(metadata: ReturnType<typeof useApp.getState>['metadata']): string | null {
  if (!metadata) return null;
  const v0 = metadata.vertices[0];
  const e0 = metadata.edges[0];
  if (v0 && e0) {
    const v1 = metadata.vertices[1] ?? v0;
    return `(a IS ${v0.labels[0] ?? v0.alias})-[k IS ${e0.labels[0] ?? e0.alias}]->(b IS ${
      v1.labels[0] ?? v1.alias
    })`;
  }
  if (v0) return `(a IS ${v0.labels[0] ?? v0.alias})`;
  return null;
}

// Splits a newline-separated textarea into trimmed, non-empty lines. Used for
// the LATERAL FROM items list.
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseParams(text: string): unknown[] | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const v = JSON.parse(t) as unknown;
    if (Array.isArray(v)) return v;
    return null;
  } catch {
    return null;
  }
}
