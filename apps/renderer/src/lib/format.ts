// Shared rendering of arbitrary cell / property values as display strings.
//
// Several views need to "turn an unknown into a readable string": the canvas
// property panel, the canvas footer, the results table, and CSV/GraphML
// export. They differ only in how they render nullish values and whether
// they truncate — both are options here, so the rendering logic lives once.

export interface FormatValueOptions {
  /** Rendered for a SQL NULL. Default: 'null'. */
  nullText?: string;
  /** Rendered for a missing (undefined) value. Default: '—'. */
  undefinedText?: string;
  /** When set, strings / JSON longer than this are truncated with an ellipsis. */
  maxLen?: number;
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen - 3)}…` : s;
}

/**
 * Coerces a property value to a finite number, or null when it isn't one.
 *
 * Accepts numeric strings as well as numbers because the server stringifies
 * PG `numeric` values and integers beyond ±2^53 to preserve precision (see
 * server/internal/api/query.go:jsonify) — so an edge property declared as
 * `numeric` arrives here as "8.8", not 8.8. Whitespace-only and non-numeric
 * strings return null rather than the NaN/0 surprises of bare Number().
 */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Renders an unknown value as a display string. Objects are JSON-encoded,
 * primitives are stringified. Nullish rendering and truncation are
 * controlled via opts so every view can share one implementation.
 */
export function formatValue(v: unknown, opts: FormatValueOptions = {}): string {
  const { nullText = 'null', undefinedText = '—', maxLen } = opts;
  if (v === null) return nullText;
  if (v === undefined) return undefinedText;
  if (typeof v === 'string') return maxLen ? truncate(v, maxLen) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return maxLen ? truncate(s, maxLen) : s;
  } catch {
    return String(v);
  }
}
