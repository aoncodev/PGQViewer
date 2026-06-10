import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition, type EventObject } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import dagre from 'cytoscape-dagre';
import cola from 'cytoscape-cola';
// @ts-expect-error - no types ship for cytoscape-cxtmenu
import cxtmenu from 'cytoscape-cxtmenu';
// @ts-expect-error - no types ship for cytoscape-cose-bilkent
import coseBilkent from 'cytoscape-cose-bilkent';
// @ts-expect-error - no types ship for cytoscape-klay
import klay from 'cytoscape-klay';
// @ts-expect-error - no types ship for cytoscape-euler
import euler from 'cytoscape-euler';
// @ts-expect-error - no types ship for cytoscape-avsdf
import avsdf from 'cytoscape-avsdf';
// @ts-expect-error - no types ship for cytoscape-spread
import spread from 'cytoscape-spread';
import { useApp, type EdgeLink, type PropertyFilter, type VertexNode } from '../lib/store';
import { canvasBgColor, colorForLabel, type LabelColors } from '../lib/colors';
import {
  ANIMATE_LIMIT,
  HEAVY_LAYOUTS,
  LAYOUT_KEY,
  LAYOUT_LABELS,
  PERF,
  layoutOpts,
  pickLayout,
  readInitialLayout,
  styleFor,
  type LayoutId,
} from '../lib/graphLayouts';
import { parseElementId } from '../lib/elementId';
import { toFiniteNumber } from '../lib/format';
import { subscribeLabelOverrides } from '../lib/labelColors';
import { getLabelCaption, subscribeLabelCaptions } from '../lib/labelCaptions';
import { CanvasFooter, type SelectionData } from './CanvasFooter';
import { GraphToolbar } from './GraphToolbar';
import { PropertyTooltip, type TooltipState } from './PropertyTooltip';

cytoscape.use(fcose);
cytoscape.use(dagre);
cytoscape.use(cola);
cytoscape.use(cxtmenu);
// Some of these plugins ship as CommonJS and may be imported as either the
// plugin function (`module.exports = fn`) or wrapped in `{ default: fn }`
// depending on the bundler's ESM interop. Normalise before registering so a
// future bundler tweak can't silently disable a layout.
function registerPlugin(plugin: unknown) {
  const fn = (plugin as { default?: unknown }).default ?? plugin;
  if (typeof fn === 'function') cytoscape.use(fn as never);
}
registerPlugin(coseBilkent);
registerPlugin(klay);
registerPlugin(euler);
registerPlugin(avsdf);
registerPlugin(spread);

function vertexLabel(labels: string[], props: Record<string, unknown>): string {
  // User-chosen caption per label wins; the first label is checked first so
  // a vertex carrying ["Person", "Customer"] reads "Person"'s setting if both
  // labels have captions.
  for (const lab of labels) {
    const cap = getLabelCaption(lab);
    if (cap && props[cap] !== undefined && props[cap] !== null) {
      return String(props[cap]);
    }
  }
  for (const k of ['name', 'title', 'label', 'display_name']) {
    if (typeof props[k] === 'string') return String(props[k]);
  }
  for (const k of ['id', 'uuid', 'key']) {
    if (props[k] !== undefined) return String(props[k]);
  }
  return '';
}

// Centroid of the current canvas content. New streamed nodes are seeded
// near it (with jitter) so a burst grows outward from the existing cluster
// instead of piling at the origin.
interface Centroid {
  hasExisting: boolean;
  x: number;
  y: number;
}

function computeCentroid(cy: Core): Centroid {
  if (cy.nodes().length === 0) return { hasExisting: false, x: 0, y: 0 };
  const bb = cy.elements().boundingBox();
  return { hasExisting: true, x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
}

// buildNodeDefs turns streamed vertices not yet on the canvas into Cytoscape
// node definitions, seeding their positions near `centroid` when the canvas
// already has content.
function buildNodeDefs(
  cy: Core,
  vertices: Map<string, VertexNode>,
  colorCache: (label: string) => LabelColors,
  centroid: Centroid,
): ElementDefinition[] {
  const defs: ElementDefinition[] = [];
  vertices.forEach((v) => {
    if (cy.getElementById(v.id).length === 0) {
      const c = colorCache(v.labels[0] ?? 'node');
      const def: ElementDefinition = {
        data: {
          id: v.id,
          label: vertexLabel(v.labels, v.properties),
          fill: c.fill,
          stroke: c.stroke,
          labelColor: c.label,
          labelOutline: c.labelOutline,
          kind: 'v',
          labels: v.labels,
          properties: v.properties,
          degree: 0,
        },
        group: 'nodes',
      };
      if (centroid.hasExisting) {
        def.position = {
          x: centroid.x + (Math.random() - 0.5) * 120,
          y: centroid.y + (Math.random() - 0.5) * 120,
        };
      }
      defs.push(def);
    }
  });
  return defs;
}

// buildEdgeDefs turns streamed edges not yet on the canvas into Cytoscape
// edge definitions. Endpoint validity is filtered separately at add time
// (filterValidEdges) because vertices and edges can stream out of order.
function buildEdgeDefs(
  cy: Core,
  edges: Map<string, EdgeLink>,
  colorCache: (label: string) => LabelColors,
): ElementDefinition[] {
  const defs: ElementDefinition[] = [];
  edges.forEach((e) => {
    if (cy.getElementById(e.id).length === 0) {
      const ec = colorCache(e.labels[0] ?? 'edge');
      defs.push({
        data: {
          id: e.id,
          source: e.source,
          target: e.destination,
          label: e.labels[0] ?? '',
          color: ec.fill,
          kind: 'e',
          labels: e.labels,
          properties: e.properties,
        },
        group: 'edges',
      });
    }
  });
  return defs;
}

// parseVertexId is the canvas-side mirror of joinKey in projection.go.
// The shared parser handles both the JSON-array form (current) and the
// legacy comma-joined form so older sessions that still hold stale
// node ids don't break expand.
const parseVertexId = parseElementId;

interface ExpandAffordancePos {
  left: number;
  top: number;
  vertexId: string;
}

export interface GraphCanvasProps {
  onExpand?: (anchorOID: number, anchorPK: string[]) => void;
  /** Canvas id of the anchor for an in-flight expand. While set, new
   *  elements stream in through the delta-only-layout path: existing nodes
   *  are locked, new ones are laid out concentrically around the anchor,
   *  the global force layout is suppressed. Cleared by Workspace when the
   *  expand completes. */
  expandingAnchorId?: string | null;
}

export function GraphCanvas({
  onExpand,
  expandingAnchorId = null,
}: GraphCanvasProps = {}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  // Layout-pass debouncer. During a streaming query we get many batches in
  // quick succession; without debouncing we'd run a full layout per batch.
  const layoutDebounceRef = useRef<number | null>(null);
  // First layout of the current query runs immediately (so the user sees the
  // result snap into place); subsequent additions go through the debouncer.
  // Reset to false in the "canvas cleared" effect.
  const firstLayoutDoneRef = useRef<boolean>(false);
  // Mirror the expandingAnchorId prop into a ref so the ingestion effect can
  // read it without adding the prop to its dependency array (which would
  // re-fire the effect when an expand starts/ends even though no new
  // elements arrived yet).
  const expandingAnchorRef = useRef<string | null>(expandingAnchorId);
  expandingAnchorRef.current = expandingAnchorId;
  const onExpandRef = useRef(onExpand);
  onExpandRef.current = onExpand;
  const [affordance, setAffordance] = useState<ExpandAffordancePos | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [layoutId, setLayoutId] = useState<LayoutId>(readInitialLayout);
  const [selection, setSelection] = useState<SelectionData | null>(null);
  // Edges in the store whose endpoints never made it onto the canvas
  // (element-cap truncation, LIMIT cutting the vertex row, unprojected
  // endpoint). They exist in counts/exports but can't be drawn — surfaced
  // in the footer so "N edges" never silently overstates the canvas.
  const [hiddenEdgeCount, setHiddenEdgeCount] = useState(0);
  // Dismiss timer for the expand button.
  const dismissTimerRef = useRef<number | null>(null);
  const cancelDismiss = useRef(() => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }).current;
  const scheduleDismiss = useRef((ms: number) => {
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = window.setTimeout(() => {
      setAffordance(null);
      dismissTimerRef.current = null;
    }, ms);
  }).current;
  // Tooltip uses its own debounce — appear after a short dwell, hide instantly
  // so the user isn't fighting a sticky overlay.
  const tooltipTimerRef = useRef<number | null>(null);
  const cancelTooltipTimer = useRef(() => {
    if (tooltipTimerRef.current !== null) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }).current;

  const vertices = useApp((s) => s.vertices);
  const edges = useApp((s) => s.edges);
  const theme = useApp((s) => s.theme);
  const palette = useApp((s) => s.palette);
  const canvasFilter = useApp((s) => s.canvasFilter);
  const propertyFilters = useApp((s) => s.propertyFilters);
  const edgeWeight = useApp((s) => s.edgeWeight);
  const labelInside = useApp((s) => s.labelInside);
  const setLabelInside = useApp((s) => s.setLabelInside);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusMode = useApp((s) => s.setFocusMode);
  const openModal = useApp((s) => s.openModal);
  const pushToast = useApp((s) => s.pushToast);
  // Tracks whether the current stylesheet is the lean variant. Avoids the
  // O(N) cost of re-applying the stylesheet on every batch when the answer
  // hasn't actually changed.
  const leanRef = useRef(false);

  const [overrideVersion, setOverrideVersion] = useState(0);
  useEffect(() => {
    return subscribeLabelOverrides(() => setOverrideVersion((n) => n + 1));
  }, []);

  // Apply or remove scale-aware perf optimisations. Called after every
  // element batch.
  //
  // Caveat: `hideEdgesOnViewport` and `textureOnViewport` are
  // **constructor-only** flags in Cytoscape 3.x — there's no runtime
  // accessor for them (despite older docs implying otherwise; calling them
  // throws TypeError). We bake `hideEdgesOnViewport: true` in at cy
  // construction time so the perf benefit applies at any scale, and accept
  // the negligible "edges briefly hidden during pan" cost on small graphs.
  // The other big win — dropping per-element 180 ms CSS transitions — is
  // genuinely runtime-toggleable via `cy.style()`, so that stays here.
  function applyPerfMode(cy: Core, total: number) {
    const lean = total > PERF.RENDER;
    if (lean !== leanRef.current) {
      cy.style(styleFor(theme, lean, labelInside));
      leanRef.current = lean;
    }
  }

  // Re-render node text when a caption override changes — we re-poke every
  // node's `label` data field so Cytoscape redraws without a query.
  // Wrapped in cy.batch so each data() write doesn't trigger an isolated
  // style recalc; at 1k nodes that recalc burst was hundreds of ms.
  useEffect(() => {
    return subscribeLabelCaptions(() => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const labels = (n.data('labels') as string[]) ?? [];
          const props = (n.data('properties') as Record<string, unknown>) ?? {};
          n.data('label', vertexLabel(labels, props));
        });
      });
    });
  }, []);

  const colorCache = useMemo(() => {
    const cache = new Map<string, LabelColors>();
    return (label: string) => {
      let v = cache.get(label);
      if (!v) {
        v = colorForLabel(label, theme);
        cache.set(label, v);
      }
      return v;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, overrideVersion]);

  const dispatchExpand = useRef((vertexId: string) => {
    const cb = onExpandRef.current;
    if (!cb) return;
    const cy = cyRef.current;
    if (!cy) return;
    const el = cy.getElementById(vertexId);
    if (el.length === 0) return;
    if (el.data('kind') !== 'v') return;
    const parsed = parseVertexId(vertexId);
    if (!parsed) return;
    cb(parsed.elementOID, parsed.pk);
  }).current;

  // Persist layout selection so the user's preference survives reloads.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LAYOUT_KEY, layoutId);
    }
  }, [layoutId]);

  // Initialize Cytoscape once.
  useEffect(() => {
    if (!hostRef.current) return;
    const cy = cytoscape({
      container: hostRef.current,
      style: styleFor(theme, false, labelInside),
      layout: layoutOpts(layoutId, false),
      wheelSensitivity: 0.25,
      minZoom: 0.2,
      maxZoom: 3,
      // Perf: hide edges during pan/zoom and skip re-rendering them until
      // the gesture settles. Effectively free at small scale (you barely
      // notice edges blink); huge win on hundreds-of-edges canvases. There's
      // no runtime toggle for this in Cytoscape 3.x — it's a constructor
      // option only.
      hideEdgesOnViewport: true,
    });
    cyRef.current = cy;

    const onDblTap = (ev: EventObject) => {
      const t = ev.target;
      if (!t || t === cy) return;
      if (typeof t.isNode !== 'function' || !t.isNode()) return;
      dispatchExpand(String(t.id()));
    };
    cy.on('dbltap', 'node', onDblTap);

    // Right-click radial menu on nodes.
    //
    //   Expand        — fetch 1-hop neighbourhood (delegates to dblclick handler).
    //   Hide          — remove this node and its incident edges from the canvas.
    //   Copy id       — write the canvas id (<elemOID>:<pk>) to the clipboard.
    //   Copy MATCH    — write a `(p IS Label)` snippet for the node's primary label.
    //
    // Constructed lazily via the cy.cxtmenu extension. Menu radius scales
    // with zoom so it feels right whether the user is zoomed out (smaller
    // nodes → smaller menu) or in close.
    const menu = (
      cy as unknown as {
        cxtmenu: (opts: unknown) => { destroy: () => void };
      }
    ).cxtmenu({
      selector: 'node',
      menuRadius: (ele: cytoscape.NodeSingular) =>
        ele.cy().zoom() <= 1 ? 60 : 76,
      fillColor: 'rgba(20, 20, 20, 0.78)',
      activeFillColor: 'rgba(95, 95, 215, 0.85)',
      activePadding: 4,
      indicatorSize: 18,
      separatorWidth: 2,
      spotlightPadding: 4,
      itemColor: '#f8fafc',
      itemTextShadowColor: 'rgba(0,0,0,0.6)',
      zIndex: 9999,
      commands: [
        {
          content: 'Expand',
          contentStyle: { fontSize: '11px', fontWeight: 600 },
          select: (ele: cytoscape.NodeSingular) => {
            dispatchExpand(String(ele.id()));
          },
        },
        {
          content: 'Hide',
          contentStyle: { fontSize: '11px', fontWeight: 600 },
          select: (ele: cytoscape.NodeSingular) => {
            ele.connectedEdges().remove();
            ele.remove();
            // Degree drives mapData node sizing; without the refresh the
            // hidden node's former neighbours keep their stale size.
            refreshDegrees(cy);
          },
        },
        {
          content: 'Copy id',
          contentStyle: { fontSize: '11px', fontWeight: 600 },
          select: (ele: cytoscape.NodeSingular) => {
            const id = String(ele.id());
            navigator.clipboard?.writeText(id).catch(() => {
              /* clipboard blocked — silently fail; user can read the id in
                 the canvas footer. */
            });
          },
        },
        {
          content: 'Copy MATCH',
          contentStyle: { fontSize: '11px', fontWeight: 600 },
          select: (ele: cytoscape.NodeSingular) => {
            const labels = (ele.data('labels') as string[]) ?? [];
            const label = labels[0] ?? 'element';
            const alias = (label[0] ?? 'v').toLowerCase().replace(/[^a-z]/g, '') || 'v';
            const snippet = `(${alias} IS ${label})`;
            navigator.clipboard?.writeText(snippet).catch(() => {
              /* clipboard blocked */
            });
          },
        },
      ],
    });

    const positionAffordance = (node: cytoscape.NodeSingular) => {
      if (node.data('kind') !== 'v') return;
      const rp = node.renderedPosition();
      const rW = node.renderedWidth();
      setAffordance({
        left: rp.x + rW / 2 + 4,
        top: rp.y - rW / 2 - 4,
        vertexId: String(node.id()),
      });
    };
    const onNodeMouseOver = (ev: EventObject) => {
      const t = ev.target as cytoscape.NodeSingular;
      if (typeof t.isNode !== 'function' || !t.isNode()) return;
      cancelDismiss();
      positionAffordance(t);
      scheduleTooltipFor(t, 'v');
    };
    const onEdgeMouseOver = (ev: EventObject) => {
      const t = ev.target as cytoscape.EdgeSingular;
      if (typeof t.isEdge !== 'function' || !t.isEdge()) return;
      scheduleTooltipFor(t, 'e');
    };
    const onNodeMouseOut = () => {
      cancelTooltipTimer();
      setTooltip(null);
    };
    const onCanvasMouseOut = (ev: EventObject) => {
      if (ev.target === cy) {
        scheduleDismiss(250);
        cancelTooltipTimer();
        setTooltip(null);
      }
    };
    const onPanZoom = () => {
      cancelDismiss();
      setAffordance(null);
      cancelTooltipTimer();
      setTooltip(null);
    };

    function scheduleTooltipFor(ele: cytoscape.NodeSingular | cytoscape.EdgeSingular, kind: 'v' | 'e') {
      cancelTooltipTimer();
      tooltipTimerRef.current = window.setTimeout(() => {
        const rp = ele.isNode()
          ? (ele as cytoscape.NodeSingular).renderedPosition()
          : (ele as cytoscape.EdgeSingular).midpoint();
        const offsetY = ele.isNode() ? -((ele as cytoscape.NodeSingular).renderedHeight() / 2) - 8 : -10;
        const labels = (ele.data('labels') as string[]) ?? [];
        const props = (ele.data('properties') as Record<string, unknown>) ?? {};
        const entries = Object.entries(props).slice(0, 8);
        setTooltip({
          left: rp.x,
          top: rp.y + offsetY,
          title: ele.data('label') || (labels[0] ?? ''),
          subtitle: labels.join(' · '),
          kind,
          properties: entries,
        });
      }, 350);
    }

    // Selection → footer state. Reading element data on select/unselect
    // means the footer shows whatever the canvas currently has, including
    // labels/properties that arrive from expand events later.
    const onSelect = (ev: EventObject) => {
      const t = ev.target as cytoscape.NodeSingular | cytoscape.EdgeSingular;
      if (typeof t.isNode !== 'function') return;
      const labels = (t.data('labels') as string[]) ?? [];
      const properties = (t.data('properties') as Record<string, unknown>) ?? {};
      const kind = (t.data('kind') as 'v' | 'e') ?? (t.isNode() ? 'v' : 'e');
      setSelection({
        kind,
        id: String(t.id()),
        labels,
        properties,
        source: kind === 'e' ? String((t as cytoscape.EdgeSingular).source().id()) : undefined,
        destination: kind === 'e' ? String((t as cytoscape.EdgeSingular).target().id()) : undefined,
      });
    };
    const onUnselect = () => setSelection(null);

    cy.on('mouseover', 'node', onNodeMouseOver);
    cy.on('mouseover', 'edge', onEdgeMouseOver);
    cy.on('mouseout', 'node', onNodeMouseOut);
    cy.on('mouseout', 'edge', onNodeMouseOut);
    cy.on('mouseout', onCanvasMouseOut);
    cy.on('pan zoom', onPanZoom);
    cy.on('select', 'node, edge', onSelect);
    cy.on('unselect', 'node, edge', onUnselect);

    return () => {
      cy.off('dbltap', 'node', onDblTap);
      cy.off('mouseover', 'node', onNodeMouseOver);
      cy.off('mouseover', 'edge', onEdgeMouseOver);
      cy.off('mouseout', 'node', onNodeMouseOut);
      cy.off('mouseout', 'edge', onNodeMouseOut);
      cy.off('mouseout', onCanvasMouseOut);
      cy.off('pan zoom', onPanZoom);
      cy.off('select', 'node, edge', onSelect);
      cy.off('unselect', 'node, edge', onUnselect);
      cancelDismiss();
      cancelTooltipTimer();
      try {
        menu.destroy();
      } catch {
        /* cxtmenu may have already been removed if cy was destroyed first */
      }
      cy.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply stylesheet on theme change + refresh per-element colors.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(styleFor(theme, leanRef.current, labelInside));
    cy.nodes().forEach((n) => {
      const labels = (n.data('labels') as string[]) ?? [];
      const c = colorCache(labels[0] ?? 'node');
      n.data({
        fill: c.fill,
        stroke: c.stroke,
        labelColor: c.label,
        labelOutline: c.labelOutline,
      });
    });
    cy.edges().forEach((e) => {
      const labels = (e.data('labels') as string[]) ?? [];
      const c = colorCache(labels[0] ?? 'edge');
      e.data({ color: c.fill });
    });
    if (hostRef.current) {
      hostRef.current.style.backgroundColor = canvasBgColor(theme);
    }
    // labelInside is a dep so flipping the toggle re-applies the stylesheet
    // (text-valign / text-wrap / node radius all change in one go).
  }, [theme, palette, colorCache, labelInside]);

  // Recompute every node's degree data so the mapData(degree, ...) sizing
  // stays in sync after additions or removals. Cytoscape recomputes degree on
  // demand, but mapData reads from data() — so we mirror it explicitly.
  function refreshDegrees(cy: Core) {
    cy.nodes().forEach((n) => {
      n.data('degree', n.degree(false));
    });
  }

  // Drop edge defs whose source or target isn't in cy yet. The server can
  // stream events out of order — `vertex a, edge a→b, vertex b` is a valid
  // sequence — so a batch can carry an edge whose target hasn't shown up
  // until a later batch. Cytoscape's cy.add() throws if any single element
  // is invalid, which would take the whole batch down. Orphans wait in the
  // store; the ingestion effect re-runs on the next batch and the edge
  // resolves once its endpoint arrives.
  function filterValidEdges(
    cy: Core,
    defs: ElementDefinition[],
  ): ElementDefinition[] {
    return defs.filter((def) => {
      const d = def.data as { source?: string; target?: string };
      const src = d.source ? cy.getElementById(d.source) : null;
      const tgt = d.target ? cy.getElementById(d.target) : null;
      return src && !src.empty() && tgt && !tgt.empty();
    });
  }

  // Run a layout and guarantee the viewport fits the result.
  //
  // Cytoscape's layout option `fit: true` should auto-fit at the end of the
  // layout, but in practice — especially with fcose + animate:'end' — the
  // fit can fail to land (the viewport stays at its pre-layout pan/zoom).
  // We listen for `layoutstop` and explicitly call cy.fit() to be sure.
  // Also call cy.fit() synchronously for non-animated layouts as a safety
  // net in case `stop` fires too early to retrigger React.
  function runLayoutWithFit(
    c: Core,
    id: LayoutId,
    animate: boolean,
    total: number,
    firstRun: boolean,
  ) {
    if (c.nodes().length === 0) return;
    const layout = c.layout(layoutOpts(id, animate, total, firstRun));
    // one() registers a one-time listener — auto-removed after firing.
    layout.one('layoutstop', () => {
      try {
        c.fit(undefined, 60);
      } catch {
        /* layout torn down between stop and fit — ignore. */
      }
    });
    layout.run();
    if (!animate) {
      // Non-animated layouts complete synchronously; fit immediately so the
      // first frame already shows the right viewport. (The layoutstop fit
      // also fires, but on the next tick — without this, a snap-layout
      // would briefly render at the old viewport.)
      try {
        c.fit(undefined, 60);
      } catch {
        /* ignore */
      }
    }
  }

  // Sync store → Cytoscape. Two-phase to avoid main-thread blocking during
  // a streaming query:
  //   Phase 1 (this effect, immediate): diff store maps against cy and add
  //     missing elements. Cheap — O(adds), no layout work.
  //   Phase 2 (debounced layout, below): once additions stop for ~120 ms,
  //     run one layout pass over everything. Without the debounce, every
  //     batch flush re-triggered a full O(n²) force layout, which was the
  //     dominant cause of the streaming freeze.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    // Nodes and edges are collected separately: cy.add() rejects the whole
    // batch if an edge references a missing endpoint, so nodes are added
    // first and edges are endpoint-filtered at add time.
    const centroid = computeCentroid(cy);
    const nodeDefs = buildNodeDefs(cy, vertices, colorCache, centroid);
    const pendingEdgeDefs = buildEdgeDefs(cy, edges, colorCache);

    if (nodeDefs.length === 0 && pendingEdgeDefs.length === 0) return;
    const wasEmpty = !centroid.hasExisting;

    // --- Delta-only layout path (expand-on-click) ----------------------
    // If an expand is in flight and its anchor exists on the canvas, lay
    // out just the new neighbourhood around the anchor and lock everything
    // else. This stops fcose from disturbing settled positions for the
    // rest of the graph.
    const anchorId = expandingAnchorRef.current;
    const anchor = anchorId ? cy.getElementById(anchorId) : null;
    if (anchor && !anchor.empty() && !wasEmpty) {
      const ap = anchor.position();
      // Pre-position around the anchor so new nodes don't flash at (0,0)
      // before the local layout runs.
      nodeDefs.forEach((def, i) => {
        const angle = (2 * Math.PI * i) / Math.max(1, nodeDefs.length);
        const r = 130 + Math.random() * 30;
        def.position = {
          x: ap.x + r * Math.cos(angle),
          y: ap.y + r * Math.sin(angle),
        };
      });
      if (nodeDefs.length > 0) cy.add(nodeDefs);
      const safeEdgeDefs = filterValidEdges(cy, pendingEdgeDefs);
      if (safeEdgeDefs.length > 0) cy.add(safeEdgeDefs);
      refreshDegrees(cy);
      const total = cy.nodes().length + cy.edges().length;
      applyPerfMode(cy, total);
      // Build a collection of just-added cytoscape elements by id-filter.
      const newIds = new Set(
        nodeDefs.map((d) => (d.data as { id: string }).id),
      );
      const addedNodes = cy.nodes().filter((n) => newIds.has(String(n.id())));
      // Lock everything else so the concentric layout can't drag settled
      // nodes around.
      const settled = cy.elements().not(addedNodes);
      settled.lock();
      try {
        addedNodes
          .union(anchor)
          .layout({
            name: 'concentric',
            fit: false,
            animate: false,
            avoidOverlap: true,
            minNodeSpacing: 30,
            spacingFactor: 1,
            // Anchor at level 0 (highest concentric value → centre); new
            // nodes ring around it.
            concentric: (n: cytoscape.NodeSingular) =>
              n.id() === anchorId ? 10 : 1,
            levelWidth: () => 1,
            // Keep the anchor exactly where it was; the concentric layout
            // would otherwise re-centre on the canvas centroid.
            startAngle: (3 / 2) * Math.PI,
          } as cytoscape.LayoutOptions)
          .run();
      } finally {
        settled.unlock();
      }
      // Skip both the first-reveal and debounced layout paths — the delta
      // path has already placed the new elements.
      return;
    }
    // -------------------------------------------------------------------

    // Nodes first so subsequent edge adds can resolve their endpoints.
    if (nodeDefs.length > 0) cy.add(nodeDefs);
    const safeEdgeDefs = filterValidEdges(cy, pendingEdgeDefs);
    if (safeEdgeDefs.length > 0) cy.add(safeEdgeDefs);
    // If nothing actually got added (e.g. all edges were orphans waiting on
    // their endpoints), skip the layout — we'll re-run next batch.
    if (nodeDefs.length === 0 && safeEdgeDefs.length === 0) return;
    refreshDegrees(cy);

    const total = cy.nodes().length + cy.edges().length;
    applyPerfMode(cy, total);

    // First reveal: run layout immediately so the user sees the result
    // snap into place. Animate when small enough that animation is cheap.
    if (wasEmpty || !firstLayoutDoneRef.current) {
      firstLayoutDoneRef.current = true;
      const effective = pickLayout(layoutId, total);
      const animate = total <= ANIMATE_LIMIT;
      runLayoutWithFit(cy, effective, animate, total, /*firstRun*/ true);
      return;
    }

    // Subsequent batches in the same query: debounce the layout so a stream
    // of N batches results in 1 layout pass, not N. 120 ms is short enough
    // that the final layout follows the last batch closely, long enough
    // that mid-stream batches collapse into a single pass.
    if (layoutDebounceRef.current !== null) {
      window.clearTimeout(layoutDebounceRef.current);
    }
    layoutDebounceRef.current = window.setTimeout(() => {
      layoutDebounceRef.current = null;
      const cyy = cyRef.current;
      if (!cyy) return;
      const t = cyy.nodes().length + cyy.edges().length;
      applyPerfMode(cyy, t);
      const effective = pickLayout(layoutId, t);
      // firstRun:false — settled positions from the previous layout pass
      // are preserved so fcose just refines, not re-explores.
      runLayoutWithFit(cyy, effective, false, t, /*firstRun*/ false);
    }, 120);
  }, [vertices, edges, colorCache, layoutId]);

  // Reconcile the store-vs-canvas edge delta after every ingestion pass.
  // Declared AFTER the ingestion effect so it observes the canvas state
  // post-add; orphan edges that resolve on a later batch zero this out.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    setHiddenEdgeCount(Math.max(0, edges.size - cy.edges().length));
  }, [vertices, edges]);

  // Tear down the layout debouncer when the component unmounts.
  useEffect(() => {
    return () => {
      if (layoutDebounceRef.current !== null) {
        window.clearTimeout(layoutDebounceRef.current);
        layoutDebounceRef.current = null;
      }
    };
  }, []);

  // Apply BOTH the sidebar substring filter and the per-property filter
  // rules to canvas elements as a single opacity overlay. An element passes
  // the full filter set when:
  //   1. The sidebar substring filter is empty OR matches a label/property
  //      name (case-insensitive).
  //   2. The propertyFilters list is empty OR at least one rule matches the
  //      element's label + property value.
  //
  // The classifier is hoisted so we can reuse it for two distinct triggers:
  //   - Filter-change: classify EVERY element (full sweep).
  //   - Element-change (streaming batch): classify NEW elements only.
  // Without this split, every NDJSON batch during a streaming query would
  // re-walk the whole canvas — quadratic in the stream length.
  const filterStateRef = useRef<{ noActive: boolean }>({ noActive: true });
  const classifyEl = (
    el: cytoscape.SingularElementArgument,
    f: string,
    rules: PropertyFilter[],
    noSubstr: boolean,
    noRules: boolean,
  ) => {
    const labels = (el.data('labels') as string[]) ?? [];
    const props = (el.data('properties') as Record<string, unknown>) ?? {};
    let ok = noSubstr;
    if (!ok) {
      ok =
        labels.some((l) => l.toLowerCase().includes(f)) ||
        Object.keys(props).some((k) => k.toLowerCase().includes(f));
    }
    if (ok && !noRules) {
      ok = rules.some((rule) => {
        if (rule.label && !labels.includes(rule.label)) return false;
        const keyword = rule.keyword.toLowerCase();
        if (!rule.property) {
          if (!keyword) return true;
          return Object.values(props).some((v) =>
            String(v ?? '').toLowerCase().includes(keyword),
          );
        }
        if (!(rule.property in props)) return false;
        if (!keyword) return true;
        return String(props[rule.property] ?? '').toLowerCase().includes(keyword);
      });
    }
    if (ok) el.removeClass('g-filtered');
    else el.addClass('g-filtered');
  };

  // Effect A — filter rules changed: re-classify ALL elements.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const f = canvasFilter.trim().toLowerCase();
    const noSubstr = f === '';
    const noRules = propertyFilters.length === 0;
    filterStateRef.current.noActive = noSubstr && noRules;
    if (filterStateRef.current.noActive) {
      // Wrap in cy.batch so a 10k-element clear isn't a 10k-style-recalc burst.
      cy.batch(() => {
        cy.elements('.g-filtered').removeClass('g-filtered');
      });
      return;
    }
    cy.batch(() => {
      cy.elements().forEach((el) => classifyEl(el, f, propertyFilters, noSubstr, noRules));
    });
  }, [canvasFilter, propertyFilters]);

  // Effect B — element stream advanced: classify ONLY elements that don't
  // yet carry the .g-filtered marker decision. Cheap no-op when filters are
  // inactive (early exit on the ref flag).
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (filterStateRef.current.noActive) return;
    const f = canvasFilter.trim().toLowerCase();
    const noSubstr = f === '';
    const noRules = propertyFilters.length === 0;
    cy.batch(() => {
      // We can't tell which elements are "new" without a separate set, so
      // we classify everything but it's a no-op for already-correct
      // elements (removeClass/addClass on the existing class is cheap).
      cy.elements().forEach((el) => classifyEl(el, f, propertyFilters, noSubstr, noRules));
    });
    // canvasFilter / propertyFilters intentionally NOT in deps — those trigger
    // effect A. We only run on stream advances here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vertices, edges]);

  // Edge thickness mapping. When edgeWeight is set, we compute the value
  // range of the chosen numeric property across matching rendered edges and
  // assign each edge an inline `width` style linearly mapped between
  // minWidth and maxWidth. Edges of other labels — and non-numeric values —
  // fall back to the stylesheet default.
  //
  // The "previously applied" ref skips the per-edge removeStyle sweep when
  // both the prior and current edgeWeight are null — at 50k edges streaming
  // 50 batches/sec that sweep was the dominant cost.
  const prevEdgeWeightRef = useRef(edgeWeight);
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const prev = prevEdgeWeightRef.current;
    prevEdgeWeightRef.current = edgeWeight;
    // Reset only when there WAS an applied width to remove. Wrapping in
    // cy.batch coalesces the style updates into a single repaint.
    if (prev !== null) {
      cy.batch(() => {
        cy.edges().forEach((e) => {
          e.removeStyle('width');
        });
      });
    }
    if (!edgeWeight) return;
    const { edgeLabel, property, minWidth, maxWidth } = edgeWeight;
    // Fold to find min/max — Math.min(...values) blows the call-stack arg
    // limit around 65k elements on some engines, and is hot during streaming.
    let minVal = Infinity;
    let maxVal = -Infinity;
    const matched: cytoscape.EdgeSingular[] = [];
    const matchedVals: number[] = [];
    cy.edges().forEach((e) => {
      const labels = (e.data('labels') as string[] | undefined) ?? [];
      if (!labels.includes(edgeLabel)) return;
      // toFiniteNumber, not a typeof check: the server stringifies PG
      // `numeric` values for precision, so a numeric-typed weight property
      // arrives as "8.8". A typeof-number gate silently mapped 0 edges.
      const v = toFiniteNumber(
        (e.data('properties') as Record<string, unknown> | undefined)?.[property],
      );
      if (v === null) return;
      matched.push(e);
      matchedVals.push(v);
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    });
    if (matched.length === 0) return;
    // Avoid div-by-zero when every edge carries the same value — map them
    // all to the midpoint width so they still stand out from non-matching
    // edges (which keep the stylesheet default of 2px).
    const span = maxVal - minVal;
    cy.batch(() => {
      for (let i = 0; i < matched.length; i++) {
        const v = matchedVals[i]!;
        const norm = span === 0 ? 0.5 : (v - minVal) / span;
        const w = minWidth + norm * (maxWidth - minWidth);
        matched[i]!.style('width', w);
      }
    });
  }, [edgeWeight, vertices, edges]);

  // Zoom-aware text-max-width for label-inside mode. The stylesheet sets a
  // degree-scaled baseline (44..74 model units); this effect grows that
  // baseline as the user zooms in so longer captions fit instead of staying
  // truncated. Without this, "Engineering Department" reads "Engineeri..."
  // even when the node fills half the screen.
  //
  // Critically, deps are JUST [labelInside] — not vertices/edges. Streaming
  // batches were re-attaching the zoom listener and re-tuning every node on
  // every flush, which at 1k+ elements was a major hot path. Newly-streamed
  // nodes get tuned on the next zoom event; for the streaming-burst case
  // the ingestion effect already runs the layout pass which fires zoom.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (!labelInside) {
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          n.removeStyle('text-max-width');
        });
      });
      return;
    }
    function tune() {
      const cyy = cyRef.current;
      if (!cyy) return;
      const z = cyy.zoom();
      const zoomMul = Math.max(1, z * 0.85);
      cyy.batch(() => {
        cyy.nodes().forEach((n) => {
          const degree = (n.data('degree') as number | undefined) ?? n.degree(false);
          const baseline = 44 + Math.min(degree, 20) * 1.5;
          const maxWidth = Math.min(baseline * zoomMul, 220);
          n.style('text-max-width', maxWidth);
        });
      });
    }
    tune();
    let rafId: number | null = null;
    function onZoom() {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        tune();
      });
    }
    cy.on('zoom', onZoom);
    return () => {
      cy.off('zoom', onZoom);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [labelInside]);

  // When the store is cleared (new query), wipe the canvas and dismiss any
  // dangling hover affordance.
  useEffect(() => {
    if (vertices.size === 0 && edges.size === 0) {
      cyRef.current?.elements().remove();
      // Cancel any pending layout pass — there's nothing to layout, and we
      // don't want a stale timer to fire on the empty canvas.
      if (layoutDebounceRef.current !== null) {
        window.clearTimeout(layoutDebounceRef.current);
        layoutDebounceRef.current = null;
      }
      // Reset so the next query's first batch gets the "snap into place"
      // immediate-layout treatment again.
      firstLayoutDoneRef.current = false;
      setAffordance(null);
      setTooltip(null);
      setSelection(null);
    }
  }, [vertices, edges]);

  const hasContent = vertices.size > 0 || edges.size > 0;

  // Compute the candidate caption properties for the currently selected
  // vertex's primary label. Three sources, in priority order:
  //   1. UNION of property keys across every rendered element carrying that
  //      label (AGViewer pattern) — guaranteed to be present on the visible
  //      canvas, so any chosen caption renders for every node.
  //   2. Schema-declared properties from metadata — guaranteed-stable list
  //      even if the canvas is empty; useful for offering options that the
  //      current view doesn't happen to expose.
  //   3. Fallback: the properties on the selected element itself
  //      (handled inside CanvasFooter when this prop is undefined).
  //
  // We prefer (1) over (2): keys actually present beat keys declared but
  // never projected. Union with (2) so options that exist in the schema
  // but aren't on the rendered set still appear (no surprise that "city"
  // shows up after expanding more nodes).
  const metadata = useApp((s) => s.metadata);
  const selectedLabelProperties = useMemo<string[] | undefined>(() => {
    if (!selection || selection.kind !== 'v') return undefined;
    const primary = selection.labels[0];
    if (!primary) return undefined;
    const seen = new Set<string>();
    const cy = cyRef.current;
    if (cy) {
      // Scan all rendered vertices that share this label and collect their
      // property keys. Triggered to recompute when the selection or the
      // rendered set changes (vertices/edges dep below).
      cy.nodes().forEach((n) => {
        const labels = (n.data('labels') as string[]) ?? [];
        if (!labels.includes(primary)) return;
        const props = (n.data('properties') as Record<string, unknown>) ?? {};
        for (const k of Object.keys(props)) seen.add(k);
      });
    }
    if (metadata) {
      const el = metadata.vertices.find((v) => v.labels.includes(primary));
      if (el) for (const p of el.properties) seen.add(p.name);
    }
    return seen.size > 0 ? Array.from(seen) : undefined;
    // vertices dep — re-run when the rendered set changes (expand etc.).
  }, [selection, metadata, vertices]);

  function runCurrentLayout(animated = true) {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    const total = cy.nodes().length + cy.edges().length;
    const effective = pickLayout(layoutId, total);
    // User-driven re-run: treat as a fresh layout so it actually rearranges
    // (firstRun:true triggers randomize for force layouts).
    cy.layout(
      layoutOpts(effective, animated && total <= ANIMATE_LIMIT, total, true),
    ).run();
  }

  function changeLayout(id: LayoutId) {
    setLayoutId(id);
    // The layout state update fires on next render; defer the run to the
    // next tick so the new id is in effect when we read it.
    queueMicrotask(() => {
      const cy = cyRef.current;
      if (!cy || cy.nodes().length === 0) return;
      const total = cy.nodes().length + cy.edges().length;
      const effective = pickLayout(id, total);
      // Toast once when the user explicitly picks a heavy layout that we
      // refuse to run at this scale. We only toast on user action (here),
      // not during streaming, to avoid noise.
      if (effective !== id && HEAVY_LAYOUTS.has(id)) {
        // Message names the actual replacement (HEAVY_SUB targets vary:
        // klay→dagre, coseBilkent→fcose, cose/spread→fcose, others fall
        // through to Concentric). Without the lookup it always lied
        // "substituting Concentric" even when fcose was actually run.
        pushToast(
          'info',
          `${LAYOUT_LABELS[id]} blocks the UI above ${PERF.HEAVY.toLocaleString()} elements — running ${LAYOUT_LABELS[effective]} instead. Pick it explicitly to silence this notice.`,
        );
      }
      cy.layout(
        layoutOpts(effective, total <= ANIMATE_LIMIT, total, true),
      ).run();
    });
  }

  function zoomBy(factor: number) {
    const cy = cyRef.current;
    const host = hostRef.current;
    if (!cy || !host) return;
    const rect = host.getBoundingClientRect();
    cy.zoom({
      level: cy.zoom() * factor,
      // Anchor the zoom on the visible centre of the canvas so the user's
      // current focus stays put while the scale changes.
      renderedPosition: { x: rect.width / 2, y: rect.height / 2 },
    });
  }
  function fitView() {
    cyRef.current?.fit(undefined, 60);
  }

  function downloadImage(format: 'png' | 'jpg') {
    const cy = cyRef.current;
    if (!cy) return;
    const opts = {
      output: 'blob' as const,
      full: true,
      bg: canvasBgColor(theme),
      scale: 2,
    };
    const blob = (format === 'png' ? cy.png(opts) : cy.jpg({ ...opts, quality: 0.92 })) as Blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pgqviewer-graph-${Date.now()}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="cy-host" />
      <GraphToolbar
        layoutId={layoutId}
        onLayoutChange={changeLayout}
        onRelayout={() => runCurrentLayout(true)}
        onZoomIn={() => zoomBy(1.25)}
        onZoomOut={() => zoomBy(0.8)}
        onFit={fitView}
        onPNG={() => downloadImage('png')}
        onJPG={() => downloadImage('jpg')}
        onFilter={() => openModal('filter')}
        onEdgeWeight={() => openModal('edgeWeight')}
        filterActive={propertyFilters.length > 0}
        edgeWeightActive={edgeWeight !== null}
        labelInside={labelInside}
        onToggleLabelInside={() => setLabelInside(!labelInside)}
        focusMode={focusMode}
        onToggleFocusMode={() => setFocusMode(!focusMode)}
        enabled={hasContent}
      />
      {hasContent && (
        <CanvasFooter
          selection={selection}
          nodeCount={vertices.size}
          edgeCount={edges.size}
          hiddenEdgeCount={hiddenEdgeCount}
          selectedLabelProperties={selectedLabelProperties}
        />
      )}
      {tooltip && <PropertyTooltip {...tooltip} />}
      {affordance && (
        <button
          type="button"
          title="Expand neighbourhood (or double-click the node)"
          onMouseDown={(e) => {
            e.stopPropagation();
          }}
          onMouseEnter={() => cancelDismiss()}
          onMouseLeave={() => scheduleDismiss(250)}
          onClick={(e) => {
            e.stopPropagation();
            cancelDismiss();
            dispatchExpand(affordance.vertexId);
          }}
          style={{
            position: 'absolute',
            left: affordance.left,
            top: affordance.top,
            transform: 'translate(-0%, -100%)',
            zIndex: 5,
          }}
          className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-fg shadow-sm hover:bg-accent hover:text-accent-fg"
        >
          Expand
        </button>
      )}
    </div>
  );
}
