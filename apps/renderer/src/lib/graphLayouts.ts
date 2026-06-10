// Cytoscape layout registry, stylesheet, and perf tuning for the graph
// canvas.
//
// Extracted from GraphCanvas.tsx: this is pure configuration — no React, no
// component state — so it lives apart from the canvas component that
// consumes it. styleFor builds the theme-aware stylesheet; layoutOpts maps a
// LayoutId to the option literal Cytoscape consumes; pickLayout swaps heavy
// force layouts for fast equivalents above the perf cliff.

import type cytoscape from 'cytoscape';
import {
  edgeLabelBgColor,
  edgeLabelTextColor,
  selectionColor,
  selectionGlow,
} from './colors';
import type { Theme } from './store';

// System font stack — matches the rest of the UI and renders sharp at small
// sizes on every OS.
const UI_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif';

// Perf thresholds (counted as nodes + edges combined):
//   - RENDER: above this, drop the per-element 180ms CSS transitions. The
//     transitions are the silent killer at scale — every selection / theme
//     tweak triggers a whole-graph repaint that lasts 180ms × N elements.
//   - LAYOUT: above this, force layouts cut their iteration counts down so
//     they finish in under a second.
//   - HEAVY: above this, refuse force layouts entirely. fcose / cola / cose
//     run on the main thread and hit their O(n²) cliff around 1000 nodes —
//     even with the heavy-mode iter cap, the layout pass blocks for several
//     seconds. We substitute 'concentric' (instant O(n log n) on degree),
//     toast the user, and let them hand-pick dagre / circle / etc. if they
//     want a different structured view.
export const PERF = {
  RENDER: 500,
  LAYOUT: 700,
  HEAVY: 1000,
} as const;

export function styleFor(
  theme: Theme,
  lean: boolean,
  // When true, render the vertex caption INSIDE the node (centered) instead
  // of below it. Nodes get a bit bigger and the caption is ellipsis-clipped
  // to fit the node radius — long captions truncate rather than overflow.
  labelInside: boolean,
): cytoscape.StylesheetCSS[] {
  // The inside-label variant needs slightly larger nodes so 4–8 chars of
  // caption fit comfortably; the outside variant uses the historic compact
  // sizing because text doesn't compete with the node radius.
  const widthExpr = labelInside
    ? 'mapData(degree, 0, 20, 52, 84)'
    : 'mapData(degree, 0, 20, 36, 64)';
  const labelPlacement: Record<string, unknown> = labelInside
    ? {
        'text-valign': 'center',
        'text-halign': 'center',
        'text-margin-y': 0,
        // Wrap caption so the node circle visually contains the text. The
        // max-width is degree-scaled (bigger nodes wrap wider) and bumped
        // further at high zoom by a runtime listener — so zooming in shows
        // more chars instead of staying truncated.
        'text-wrap': 'ellipsis',
        'text-max-width': 'mapData(degree, 0, 20, 44, 74)',
        // No outline — text sits on the node fill, contrast comes from
        // labelColor (computed against fill in lib/colors.ts).
        'text-outline-width': 0,
      }
    : {
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 7,
        'text-outline-width': 0,
      };
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(fill)',
        'border-width': 0,
        // mapData scales node radius with degree.
        width: widthExpr,
        height: widthExpr,
        label: 'data(label)',
        color: 'data(labelColor)',
        'font-family': UI_FONT,
        'font-size': labelInside ? 10 : 11,
        'font-weight': labelInside ? 600 : 500,
        ...labelPlacement,
        // Keep the original 6px floor — Cytoscape hides labels entirely
        // below this rendered size, so a generous floor preserves labels at
        // every reasonable zoom.
        'min-zoomed-font-size': 6,
        ...(lean
          ? {}
          : {
              'transition-property': 'opacity, background-color, border-width',
              'transition-duration': 180,
            }),
      },
    },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        // Pulls parallel edges apart so a Person→Person pair carrying multiple
        // labels doesn't render as a single stroke.
        'control-point-step-size': 80,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.9,
        'target-arrow-color': 'data(color)',
        'line-color': 'data(color)',
        width: 1.5,
        label: 'data(label)',
        color: edgeLabelTextColor(theme),
        'font-family': UI_FONT,
        'font-size': 9,
        'font-weight': 500,
        'text-rotation': 'autorotate',
        'text-background-color': edgeLabelBgColor(theme),
        'text-background-opacity': 0.92,
        'text-background-padding': '3px',
        'text-background-shape': 'roundrectangle',
        'min-zoomed-font-size': 6,
        ...(lean
          ? {}
          : {
              'transition-property': 'opacity, line-color, width',
              'transition-duration': 180,
            }),
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-color': selectionColor(theme),
        'border-width': 2,
        'overlay-color': selectionGlow(theme),
        'overlay-opacity': 0.22,
        'overlay-padding': 10,
      },
    },
    // Opacity filter — elements that don't match the sidebar substring
    // filter keep their geometry but fade to the background so the user can
    // see them in context without losing detail.
    {
      selector: '.g-filtered',
      style: {
        opacity: 0.12,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        'line-color': selectionColor(theme),
        'target-arrow-color': selectionColor(theme),
        width: 2.5,
        'overlay-color': selectionGlow(theme),
        'overlay-opacity': 0.22,
        'overlay-padding': 8,
      },
    },
  ] as unknown as cytoscape.StylesheetCSS[];
}

// Layout registry. Each entry exposes the options object Cytoscape consumes;
// `LAYOUT_LABELS` is the human-readable name shown in the toolbar dropdown.
// Keeping the option literals in one place makes it easy to tune them later
// without grep-finding fragments scattered around the canvas component.
export const LAYOUT_LABELS = {
  fcose: 'Force (fcose)',
  cola: 'Force (cola)',
  cose: 'Force (cose)',
  coseBilkent: 'Force (cose-bilkent)',
  euler: 'Force (euler)',
  dagre: 'Hierarchy (dagre)',
  klay: 'Hierarchy (klay)',
  breadthfirst: 'Breadth-first',
  concentric: 'Concentric',
  circle: 'Circle',
  grid: 'Grid',
  avsdf: 'Adjacent (avsdf)',
  spread: 'Spread',
  random: 'Random',
} as const;
export type LayoutId = keyof typeof LAYOUT_LABELS;
export const LAYOUT_IDS: LayoutId[] = Object.keys(LAYOUT_LABELS) as LayoutId[];

// Force / physics layouts that scale O(n²) per iteration and get substituted
// above PERF.HEAVY so a stray big query doesn't freeze the main thread.
// The substitution preserves layout intent where possible — a user who
// picked a hierarchical layout (klay) gets dagre, not concentric.
export const HEAVY_LAYOUTS: ReadonlySet<LayoutId> = new Set([
  'fcose',
  'cola',
  'cose',
  'coseBilkent',
  'euler',
  'spread',
  'klay',
]);

// Per-layout substitution map for the heavy path. Anything not listed here
// (or whose mapped target is itself heavy) falls back to 'concentric'.
const HEAVY_SUB: Partial<Record<LayoutId, LayoutId>> = {
  klay: 'dagre',           // both hierarchical; dagre is faster
  coseBilkent: 'fcose',    // fcose in draft mode is the closest fast force layout
  cose: 'fcose',           // same family
  spread: 'fcose',         // spread uses cose internally; fcose-draft is a faster shape match
};

/** Returns the layout that should actually run given the current element count.
 * Above PERF.HEAVY, heavy force/hierarchical layouts swap to the nearest
 * fast equivalent (HEAVY_SUB) or fall back to 'concentric'. */
export function pickLayout(requested: LayoutId, total: number): LayoutId {
  if (total <= PERF.HEAVY || !HEAVY_LAYOUTS.has(requested)) return requested;
  const sub = HEAVY_SUB[requested];
  if (sub && !HEAVY_LAYOUTS.has(sub)) return sub;
  return 'concentric';
}

// Shared spacing knobs. Tuned so every layout produces a bounding box of
// roughly the same size for the same input — dagre is the reference (it
// packs tightly because rank/node sep are bounded), and every other layout
// is dialled down toward that density so fit-to-view zooms similarly and
// the rendered node size matches across layouts.
const SPACING = {
  padding: 50,
  // fcose / cose family — was 140/200/12000, dropped to match dagre's
  // visual compactness for a typical small/medium graph.
  nodeSeparation: 80,
  idealEdgeLength: 110,
  nodeRepulsion: 5000,
  gravity: 0.2,
  // cola — was 60/180.
  colaNodeSpacing: 28,
  colaEdgeLength: 100,
  // dagre (reference). Leave as-is.
  dagreNodeSep: 80,
  dagreEdgeSep: 30,
  dagreRankSep: 130,
  // concentric / circle / breadthfirst — was 70 / 1.6 / 1.6 / 1.4.
  // spacingFactor multiplies the natural placement; values near 1 keep
  // positional layouts from spreading further than dagre does.
  concentricMinSpacing: 45,
  concentricSpacing: 1.0,
  breadthfirstSpacing: 1.2,
  circleSpacing: 1.2,
  gridSpacing: 1.1,
} as const;

const FCOSE_BASE = {
  name: 'fcose',
  fit: true,
  padding: SPACING.padding,
  nodeSeparation: SPACING.nodeSeparation,
  idealEdgeLength: SPACING.idealEdgeLength,
  nodeRepulsion: SPACING.nodeRepulsion,
  gravity: SPACING.gravity,
  // Tighten the spring a touch so the final layout settles instead of jitters.
  edgeElasticity: 0.45,
  // Cap iterations at 1200 (default is 2500) — at ~1k elements that single
  // change cuts layout time by half. The remaining iters still produce a
  // visually settled graph for typical viewer queries.
  numIter: 1200,
  // randomize is overridden per-call in layoutOpts: true on first reveal
  // (fresh layout), false on subsequent re-runs so settled positions are
  // preserved instead of re-explored from scratch.
  randomize: true,
  quality: 'default',
} as const;

// ANIMATION feel. cubic deceleration reads as "decided" — fast at the start
// then a graceful settle — without feeling rubbery the way bounce/elastic do.
// 620ms is long enough to read the transition but short enough that you don't
// wait on it when iterating on layouts.
const ANIM_DURATION = 620;
const ANIM_EASING = 'ease-out-cubic' as const;

export function layoutOpts(
  id: LayoutId,
  animated: boolean,
  total = 0,
  firstRun = true,
): cytoscape.LayoutOptions {
  const anim = animated
    ? {
        animate: 'end' as const,
        animationDuration: ANIM_DURATION,
        animationEasing: ANIM_EASING,
      }
    : { animate: false as const };
  // Above PERF.LAYOUT, slash iteration budgets so a force layout finishes
  // in under a second instead of locking the main thread.
  const heavy = total > PERF.LAYOUT;
  switch (id) {
    case 'fcose':
      return {
        ...FCOSE_BASE,
        // Re-runs (firstRun=false) preserve settled positions so the layout
        // refines an existing arrangement rather than re-exploring it.
        randomize: firstRun,
        // 'draft' skips the post-processing pass and slashes inner iters.
        ...(heavy ? { quality: 'draft', numIter: 350 } : {}),
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'cola':
      return {
        name: 'cola',
        fit: true,
        padding: SPACING.padding,
        nodeSpacing: SPACING.colaNodeSpacing,
        edgeLengthVal: SPACING.colaEdgeLength,
        // Longer simulation = positions stabilise instead of "almost there"
        // when the user picks the layout. Capped harder at scale.
        maxSimulationTime: heavy ? 800 : 2000,
        // Cola does its own per-step animation — silkier than 'end'-snapping
        // because every iteration moves visible. We still drive duration from
        // the same constant so the perceived speed matches other layouts.
        ...(animated
          ? { animate: true as const, animationDuration: ANIM_DURATION, animationEasing: ANIM_EASING }
          : { animate: false as const }),
        randomize: false,
      } as unknown as cytoscape.LayoutOptions;
    case 'cose':
      return {
        name: 'cose',
        fit: true,
        padding: SPACING.padding,
        idealEdgeLength: SPACING.idealEdgeLength,
        nodeRepulsion: SPACING.nodeRepulsion,
        gravity: SPACING.gravity * 8, // cose's gravity scale differs from fcose
        // More iterations = positions converge instead of leaving "drifted"
        // clusters. Cheap on small graphs; cropped hard at scale.
        numIter: heavy ? 300 : 1000,
        randomize: firstRun,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'dagre':
      return {
        name: 'dagre',
        fit: true,
        padding: SPACING.padding,
        rankDir: 'TB',
        nodeSep: SPACING.dagreNodeSep,
        edgeSep: SPACING.dagreEdgeSep,
        rankSep: SPACING.dagreRankSep,
        // network-simplex gives the most balanced rank assignment for graphs
        // with branchy structure; longest-path is faster but produces taller
        // diagrams than necessary.
        ranker: 'network-simplex',
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'concentric':
      return {
        name: 'concentric',
        fit: true,
        padding: SPACING.padding,
        // Higher-degree nodes sit closer to the centre — turns the layout
        // into a quick "who's a hub" visualisation.
        concentric: (node: cytoscape.NodeSingular) => node.degree(false),
        levelWidth: () => 1,
        minNodeSpacing: SPACING.concentricMinSpacing,
        spacingFactor: SPACING.concentricSpacing,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        fit: true,
        padding: SPACING.padding,
        directed: true,
        spacingFactor: SPACING.breadthfirstSpacing,
        // Lay tree roots more evenly across the available width.
        avoidOverlap: true,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'circle':
      return {
        name: 'circle',
        fit: true,
        padding: SPACING.padding,
        spacingFactor: SPACING.circleSpacing,
        avoidOverlap: true,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'grid':
      return {
        name: 'grid',
        fit: true,
        padding: SPACING.padding,
        spacingFactor: SPACING.gridSpacing,
        avoidOverlap: true,
        avoidOverlapPadding: 20,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'random':
      return {
        name: 'random',
        fit: true,
        padding: SPACING.padding,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'coseBilkent':
      // The AGViewer default — slower per-iteration than fcose but produces
      // very settled positions with little post-tweaking. Cap iterations at
      // scale via `numIter` so it doesn't outpace fcose's perf budget.
      return {
        name: 'cose-bilkent',
        fit: true,
        padding: SPACING.padding,
        idealEdgeLength: SPACING.idealEdgeLength,
        nodeRepulsion: heavy ? 4500 : 9500,
        nodeDimensionsIncludeLabels: true,
        randomize: firstRun,
        numIter: heavy ? 600 : 1500,
        refresh: 30,
        gravity: SPACING.gravity * 4,
        gravityRange: 3.8,
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'klay':
      // Layered/orthogonal — best for DAGs and small org-chart-like graphs.
      // Heavy at scale because of network-simplex node layering; the perf
      // substitution above PERF.HEAVY handles the cliff.
      return {
        name: 'klay',
        fit: true,
        padding: SPACING.padding,
        nodeDimensionsIncludeLabels: true,
        klay: {
          spacing: SPACING.dagreNodeSep,
          borderSpacing: 20,
          direction: 'DOWN',
          edgeRouting: 'ORTHOGONAL',
          edgeSpacingFactor: 0.6,
          nodeLayering: heavy ? 'LONGEST_PATH' : 'NETWORK_SIMPLEX',
          nodePlacement: 'BRANDES_KOEPF',
          crossingMinimization: 'LAYER_SWEEP',
          cycleBreaking: 'GREEDY',
          thoroughness: heavy ? 3 : 7,
          aspectRatio: 1.6,
          separateConnectedComponents: true,
        },
        ...anim,
      } as unknown as cytoscape.LayoutOptions;
    case 'euler':
      // Spring-electrical with Barnes-Hut acceleration — fast for medium
      // graphs, lays out clusters loosely. Animated by default in the plugin;
      // we drive duration through our shared constant.
      return {
        name: 'euler',
        fit: true,
        padding: SPACING.padding,
        springLength: () => SPACING.idealEdgeLength * 0.9,
        springCoeff: () => 0.0008,
        mass: () => 4,
        gravity: -1.2,
        pull: 0.001,
        theta: 0.666,
        dragCoeff: 0.02,
        movementThreshold: 1,
        timeStep: heavy ? 30 : 20,
        refresh: 10,
        maxIterations: heavy ? 350 : 1000,
        maxSimulationTime: heavy ? 1500 : 4000,
        randomize: firstRun,
        ungrabifyWhileSimulating: false,
        ...(animated
          ? { animate: true as const, animationDuration: ANIM_DURATION, animationEasing: ANIM_EASING }
          : { animate: false as const }),
      } as unknown as cytoscape.LayoutOptions;
    case 'avsdf':
      // "Adjacent Vertices with Similar Degree First" — circular packing
      // that keeps related nodes near each other on the ring. Cheap at scale.
      return {
        name: 'avsdf',
        fit: true,
        padding: SPACING.padding,
        refresh: 30,
        nodeSeparation: 60,
        ungrabifyWhileSimulating: false,
        ...(animated
          ? { animate: 'end' as const, animationDuration: ANIM_DURATION, animationEasing: ANIM_EASING }
          : { animate: false as const }),
      } as unknown as cytoscape.LayoutOptions;
    case 'spread':
      // Two-phase: cose prelayout, then expand nodes outward to enforce a
      // minimum distance. Looks like fcose but with more breathing room.
      return {
        name: 'spread',
        fit: true,
        padding: SPACING.padding,
        minDist: 25,
        expandingFactor: -1.0,
        prelayout: { name: 'cose', numIter: heavy ? 200 : 800 },
        maxExpandIterations: heavy ? 2 : 4,
        randomize: firstRun,
        ...(animated
          ? { animate: true as const, animationDuration: ANIM_DURATION, animationEasing: ANIM_EASING }
          : { animate: false as const }),
      } as unknown as cytoscape.LayoutOptions;
  }
}

// Cap animation at a size where it stays smooth.
export const ANIMATE_LIMIT = 300;

export const LAYOUT_KEY = 'pgviewer.graph.layout';

export function readInitialLayout(): LayoutId {
  if (typeof window === 'undefined') return 'fcose';
  const saved = window.localStorage.getItem(LAYOUT_KEY);
  return (LAYOUT_IDS as readonly string[]).includes(saved ?? '')
    ? (saved as LayoutId)
    : 'fcose';
}
