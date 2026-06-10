import { create } from 'zustand';
import type { Graph, GraphMetadata, LabelCount } from './api';
import { DEFAULT_PALETTE, isPaletteId, type PaletteId } from './palettes';
import { readFlag, readJSON } from './storage';

export interface VertexNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface EdgeLink {
  id: string;
  source: string;
  destination: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface ResultColumn {
  name: string;
  type: string;
  type_oid: number;
}

export type Theme = 'light' | 'dark';

// PendingInsert tells the Workspace to append `text` into the editor for
// `mode`, switching modes if the user is currently elsewhere. `seq` lets
// callers fire the same snippet twice in a row (e.g. clicking the same
// vertex label) and still see the effect re-trigger.
export interface PendingInsert {
  mode: 'graph' | 'sql';
  text: string;
  seq: number;
}

// Toast is a short-lived notification surfaced in the corner.
export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'success';
  message: string;
}

// Edge thickness mapping: pick an edge label + one of its numeric properties
// + the min/max range to map onto Cytoscape's width. Null = uniform width.
// Edges outside the chosen label keep their default width.
export interface EdgeWeightConfig {
  edgeLabel: string;
  property: string;
  // px range — applied via cytoscape `mapData` over the value range
  // observed on rendered edges of that label.
  minWidth: number;
  maxWidth: number;
}

// One row in the per-property filter modal. A canvas element is opacity-
// faded when at least one filter row is non-empty AND no row matches.
export interface PropertyFilter {
  id: string;
  // Element label this rule applies to. Empty string = any label.
  // (The modal UI doesn't currently let the user say "any" explicitly —
  // they pick a (label, property) pair together via the dropdown.)
  label: string;
  property: string;
  // Substring match (case-insensitive). Empty string matches everything,
  // so a freshly-created row doesn't immediately hide the whole canvas.
  keyword: string;
}

export type ModalId = 'edgeWeight' | 'filter' | null;

interface AppState {
  // Session lifecycle.
  sid: string | null;
  label: string | null;
  setSession: (sid: string | null, label?: string | null) => void;

  // Graph catalog.
  graphs: Graph[];
  setGraphs: (graphs: Graph[]) => void;

  selectedGraphOID: number | null;
  selectGraph: (oid: number | null) => void;

  metadata: GraphMetadata | null;
  setMetadata: (md: GraphMetadata | null) => void;

  counts: LabelCount[];
  setCounts: (c: LabelCount[]) => void;

  // Streaming result state.
  // Graph mode: keyed maps so we dedupe across rows.
  vertices: Map<string, VertexNode>;
  edges: Map<string, EdgeLink>;
  /** Bulk merge of streamed events. One mutation per batch instead of one
   *  per row — keeps the cost linear at scale and stops React from
   *  re-rendering on every NDJSON line. */
  bulkApply: (
    vertices: VertexNode[],
    edges: EdgeLink[],
    rows: unknown[][],
  ) => void;
  // SQL mode: columns and an ordered row list.
  resultColumns: ResultColumn[];
  resultRows: unknown[][];
  setResultColumns: (c: ResultColumn[]) => void;
  clearResult: () => void;

  // Status.
  busy: boolean;
  setBusy: (b: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;

  // Theme.
  theme: Theme;
  setTheme: (t: Theme) => void;

  // Accent palette. Independent of light/dark — selects which accent hue
  // (Electric Blue, Olive Green, …) the app uses.
  palette: PaletteId;
  setPalette: (p: PaletteId) => void;

  // Sidebar collapse state, persisted to localStorage.
  leftCollapsed: boolean;
  setLeftCollapsed: (b: boolean) => void;

  // Substring filter applied to the schema browser list AND to canvas
  // element opacity. Matches label names, element aliases, or property
  // names (case-insensitive). Empty string = no filter.
  canvasFilter: string;
  setCanvasFilter: (s: string) => void;

  // Per-property filter rules — applied as canvas opacity overlay in
  // addition to canvasFilter. Empty list = no rule-based filtering.
  propertyFilters: PropertyFilter[];
  setPropertyFilters: (rules: PropertyFilter[]) => void;

  // Render caption inside the node (centered, AGViewer-style) vs below it.
  // Persisted to localStorage. Default false = below-node, our original.
  labelInside: boolean;
  setLabelInside: (b: boolean) => void;

  // Focus mode: hide the editor, sidebar, and header so the graph canvas
  // takes over the visible area. Transient — never persisted. ESC exits.
  focusMode: boolean;
  setFocusMode: (b: boolean) => void;

  // Edge-thickness mapping. null = uniform width.
  edgeWeight: EdgeWeightConfig | null;
  setEdgeWeight: (cfg: EdgeWeightConfig | null) => void;

  // Which canvas-overlay modal is open. Null = no modal.
  modalOpen: ModalId;
  openModal: (id: Exclude<ModalId, null>) => void;
  closeModal: () => void;

  // Toasts.
  toasts: Toast[];
  pushToast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;

  // Snippet insertion (e.g. from sidebar clicks).
  pendingInsert: PendingInsert | null;
  insertSnippet: (mode: 'graph' | 'sql', text: string) => void;
  clearPendingInsert: () => void;
}

const THEME_KEY = 'pgviewer.theme';
const PALETTE_KEY = 'pgviewer.palette';
const LABEL_INSIDE_KEY = 'pgviewer.labelInside';
const SIDEBAR_KEY = (side: 'left' | 'right') => `pgviewer.sidebar.${side}.collapsed`;
const SESSION_KEY = 'pgviewer.session';

interface PersistedSession {
  sid: string;
  label: string | null;
}

function readPersistedSession(): PersistedSession | null {
  return readJSON<PersistedSession | null>(
    SESSION_KEY,
    (v) => {
      const o = v as Partial<PersistedSession> | null;
      if (!o || typeof o.sid !== 'string') return undefined;
      return { sid: o.sid, label: typeof o.label === 'string' ? o.label : null };
    },
    null,
  );
}

function persistSession(sid: string | null, label: string | null): void {
  if (typeof window === 'undefined') return;
  if (!sid) {
    window.localStorage.removeItem(SESSION_KEY);
    return;
  }
  window.localStorage.setItem(SESSION_KEY, JSON.stringify({ sid, label }));
}

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readInitialPalette(): PaletteId {
  if (typeof window === 'undefined') return DEFAULT_PALETTE;
  const saved = window.localStorage.getItem(PALETTE_KEY);
  return isPaletteId(saved) ? saved : DEFAULT_PALETTE;
}

function readSidebarCollapsed(side: 'left' | 'right'): boolean {
  return readFlag(SIDEBAR_KEY(side));
}

function readLabelInside(): boolean {
  return readFlag(LABEL_INSIDE_KEY);
}

function persistSidebarCollapsed(side: 'left' | 'right', collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SIDEBAR_KEY(side), collapsed ? '1' : '0');
}

let toastSeq = 0;
let insertSeq = 0;

const initialSession = readPersistedSession();

export const useApp = create<AppState>((set) => ({
  sid: initialSession?.sid ?? null,
  label: initialSession?.label ?? null,
  setSession: (sid, label = null) => {
    persistSession(sid, label);
    set({ sid, label });
  },

  graphs: [],
  setGraphs: (graphs) => set({ graphs }),

  selectedGraphOID: null,
  // Idempotent on same oid: clicking an already-selected graph is a no-op,
  // not a wipe-and-refetch. Otherwise we'd null-out metadata while the
  // metadata-fetch effect (keyed on selectedGraphOID changing) wouldn't fire,
  // leaving the Run button permanently disabled.
  selectGraph: (oid) =>
    set((s) =>
      s.selectedGraphOID === oid
        ? s
        : { selectedGraphOID: oid, metadata: null, counts: [] },
    ),

  metadata: null,
  setMetadata: (metadata) => set({ metadata }),

  counts: [],
  setCounts: (counts) => set({ counts }),

  vertices: new Map(),
  edges: new Map(),
  // One Map allocation per BATCH instead of per ROW. Cuts the streaming
  // path from O(N²) to O(N) and produces a single React render per flush,
  // instead of one per event.
  bulkApply: (vs, es, rows) =>
    set((s) => {
      let nextV = s.vertices;
      let nextE = s.edges;
      let nextRows = s.resultRows;
      if (vs.length > 0) {
        nextV = new Map(s.vertices);
        for (const v of vs) nextV.set(v.id, v);
      }
      if (es.length > 0) {
        nextE = new Map(s.edges);
        for (const e of es) nextE.set(e.id, e);
      }
      if (rows.length > 0) {
        // concat allocates once; the previous `[...s.resultRows, row]`
        // pattern reallocated per row, totalling O(N²).
        nextRows = s.resultRows.concat(rows);
      }
      return { vertices: nextV, edges: nextE, resultRows: nextRows };
    }),
  resultColumns: [],
  resultRows: [],
  setResultColumns: (resultColumns) => set({ resultColumns, resultRows: [] }),
  clearResult: () =>
    set({
      vertices: new Map(),
      edges: new Map(),
      resultColumns: [],
      resultRows: [],
      error: null,
    }),

  busy: false,
  setBusy: (busy) => set({ busy }),
  error: null,
  setError: (error) => set({ error }),

  theme: readInitialTheme(),
  setTheme: (theme) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_KEY, theme);
    }
    set({ theme });
  },

  palette: readInitialPalette(),
  setPalette: (palette) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PALETTE_KEY, palette);
    }
    set({ palette });
  },

  leftCollapsed: readSidebarCollapsed('left'),
  setLeftCollapsed: (b) => {
    persistSidebarCollapsed('left', b);
    set({ leftCollapsed: b });
  },

  canvasFilter: '',
  setCanvasFilter: (canvasFilter) => set({ canvasFilter }),

  propertyFilters: [],
  setPropertyFilters: (propertyFilters) => set({ propertyFilters }),

  labelInside: readLabelInside(),
  setLabelInside: (labelInside) => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(LABEL_INSIDE_KEY, labelInside ? '1' : '0');
      } catch {
        /* storage disabled — fine, just won't persist across reloads */
      }
    }
    set({ labelInside });
  },

  focusMode: false,
  setFocusMode: (focusMode) => set({ focusMode }),

  edgeWeight: null,
  setEdgeWeight: (edgeWeight) => set({ edgeWeight }),

  modalOpen: null,
  openModal: (modalOpen) => set({ modalOpen }),
  closeModal: () => set({ modalOpen: null }),

  toasts: [],
  pushToast: (kind, message) =>
    set((s) => {
      const t: Toast = { id: ++toastSeq, kind, message };
      return { toasts: [...s.toasts, t] };
    }),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  pendingInsert: null,
  insertSnippet: (mode, text) =>
    set({ pendingInsert: { mode, text, seq: ++insertSeq } }),
  clearPendingInsert: () => set({ pendingInsert: null }),
}));
