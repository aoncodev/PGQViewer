// Safe localStorage readers.
//
// Each degrades to a fallback when storage is unavailable (server-side
// render, private mode) instead of throwing, so call sites don't repeat the
// `typeof window` guard and the JSON parse/validate/catch dance.

/** True when `key` holds the string '1' — the convention for persisted flags. */
export function readFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(key) === '1';
}

/** Reads a finite number; returns `fallback` when missing or unparseable. */
export function readNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Reads and JSON-parses a value, passing it through `parse` to validate or
 * narrow the shape. `parse` returns undefined to reject. Returns `fallback`
 * on a missing key, a parse error, or a rejected shape.
 */
export function readJSON<T>(
  key: string,
  parse: (v: unknown) => T | undefined,
  fallback: T,
): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = parse(JSON.parse(raw) as unknown);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}
