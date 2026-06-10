// Theme-aware label color palette.
//
// We want:
//   - Same label → same hue forever, across themes.
//   - Stays readable on both backgrounds (different L/C per theme).
//   - Predictable; we skip muddy lime/yellow hues.
//
// IMPORTANT: Cytoscape's color parser doesn't understand `oklch(...)` — it
// only knows hex / rgb / rgba / hsl / hsla / named colors. We author the
// palette in OKLCH (uniform perceptual lightness) but resolve to rgb at the
// boundary via a one-pixel canvas. Browsers parse the modern color function
// for us and hand back a normalized rgba string. Results are memoised so
// each label is converted at most once per theme.

import { getLabelOverride, PICKER_HUES } from './labelColors';
import type { Theme } from './store';

export interface LabelColors {
  fill: string;
  stroke: string;
  label: string;
  labelOutline: string;
}

// --- oklch → rgb shim -----------------------------------------------------

let _ctx: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D {
  if (!_ctx) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    // willReadFrequently: true keeps the backing store CPU-side. We do
    // many getImageData() reads here (one per unique label colour) and
    // the GPU readback path is much slower per call.
    _ctx = cv.getContext('2d', { willReadFrequently: true });
  }
  if (!_ctx) throw new Error('canvas 2d context unavailable');
  return _ctx;
}

const colorCache = new Map<string, string>();

/**
 * Resolves any CSS color string (including modern `oklch(...)` /
 * `color(display-p3 ...)`) to an `rgb(r, g, b)` string that Cytoscape can
 * parse. We paint a single pixel and read its sRGB bytes back — that's the
 * only form guaranteed to round-trip through every browser version.
 *
 * Reading `ctx.fillStyle` after assignment is unreliable: some browsers
 * return the original OKLCH string verbatim, others return `color(srgb …)`.
 * Cytoscape's parser handles neither.
 */
function toRGB(color: string): string {
  const hit = colorCache.get(color);
  if (hit) return hit;
  const c = ctx2d();
  c.clearRect(0, 0, 1, 1);
  c.fillStyle = '#000';
  c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  const d = c.getImageData(0, 0, 1, 1).data;
  const out = `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
  colorCache.set(color, out);
  return out;
}

// --- public API -----------------------------------------------------------

const labelCache = new Map<string, LabelColors>();

/**
 * Clears cached LabelColors for `label`. Called whenever a user override
 * for that label changes so the next `colorForLabel(label, ...)` recomputes
 * with the new hue.
 */
export function invalidateLabelColor(label?: string): void {
  if (label === undefined) {
    labelCache.clear();
    return;
  }
  for (const k of [...labelCache.keys()]) {
    // Cache keys are `<theme>:<label>`; we can't predict which themes have
    // populated entries so scan and strip every match.
    if (k.endsWith(`:${label}`)) labelCache.delete(k);
  }
}

export function colorForLabel(label: string, theme: Theme): LabelColors {
  const key = `${theme}:${label}`;
  const cached = labelCache.get(key);
  if (cached) return cached;

  // A user-set override beats the hash. The override is just a hue value
  // from PICKER_HUES, so the rest of the L/C math is unchanged.
  const override = getLabelOverride(label);
  let hue: number;
  if (override !== undefined) {
    hue = override;
  } else {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
    hue = PICKER_HUES[h % PICKER_HUES.length]!;
  }

  const v: LabelColors =
    theme === 'dark'
      ? {
          fill: toRGB(`oklch(0.66 0.16 ${hue})`),
          stroke: toRGB('oklch(0.18 0.018 240)'),
          label: '#f8fafc',
          labelOutline: toRGB('oklch(0.12 0.02 240)'),
        }
      : {
          fill: toRGB(`oklch(0.62 0.16 ${hue})`),
          stroke: '#ffffff',
          label: '#0f172a',
          labelOutline: '#ffffff',
        };
  labelCache.set(key, v);
  return v;
}

export function edgeColor(theme: Theme): string {
  return theme === 'dark'
    ? toRGB('oklch(0.55 0.02 240)')
    : toRGB('oklch(0.50 0.02 240)');
}

export function edgeLabelTextColor(theme: Theme): string {
  return theme === 'dark' ? '#cbd5e1' : '#334155';
}

export function edgeLabelBgColor(theme: Theme): string {
  return theme === 'dark' ? toRGB('oklch(0.155 0.018 240)') : '#ffffff';
}

export function canvasBgColor(theme: Theme): string {
  return theme === 'dark'
    ? toRGB('oklch(0.12 0.02 240)')
    : toRGB('oklch(0.97 0.003 240)');
}

// Crisp selection outline. Always the inverse of the canvas background so
// the ring contrasts against every label colour in the palette regardless
// of which one the user happened to select — using the accent here would
// vanish on an accent-coloured node / edge.
export function selectionColor(theme: Theme): string {
  return theme === 'dark' ? '#ffffff' : '#0f172a';
}

// Soft halo around the selected element, rendered as a Cytoscape
// `overlay-color`. Follows the active accent palette so the selection
// reads as branded regardless of node fill; the crisp outline above
// guarantees contrast on top.
//
// The `theme` arg is kept so GraphCanvas can pass it as a memo key — the
// resolved accent changes when either theme or palette changes, and the
// computed-style read picks up both.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function selectionGlow(_theme: Theme): string {
  const accent = readVar('--accent');
  return accent ? toRGB(accent) : toRGB('oklch(0.65 0.14 240)');
}

// Reads a CSS custom property off <html>. Returns '' when called in non-DOM
// contexts (SSR / tests) so callers fall back to a sane default.
function readVar(name: string): string {
  if (typeof document === 'undefined') return '';
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim();
}
