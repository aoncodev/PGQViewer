// A localStorage-backed, string-keyed map with an in-memory cache and a
// tiny pub-sub.
//
// Used for per-label user overrides (colours, captions) that must survive
// reloads and notify the Cytoscape canvas without coupling to React state.
// The cache means repeated reads don't re-parse JSON; writes are
// immediately reflected and persisted best-effort.

import { readJSON } from './storage';

export interface PersistentMap<T> {
  /** Current value for a key, or undefined if unset. */
  get(key: string): T | undefined;
  /** Sets a key, persists, and notifies subscribers. */
  set(key: string, value: T): void;
  /** Removes a key, persists, and notifies subscribers. No-op if absent. */
  remove(key: string): void;
  /** Subscribe to changes; returns an unsubscribe handle. */
  subscribe(cb: () => void): () => void;
}

/**
 * Creates a PersistentMap stored under `storageKey`. `onChange`, if given,
 * is invoked with the affected key on every set/remove (before subscribers
 * are notified) — used to invalidate downstream caches.
 */
export function createPersistentMap<T>(
  storageKey: string,
  onChange?: (key: string) => void,
): PersistentMap<T> {
  type Entries = Record<string, T>;

  const read = (): Entries =>
    readJSON<Entries>(
      storageKey,
      (v) => (v && typeof v === 'object' ? (v as Entries) : undefined),
      {},
    );

  const write = (e: Entries): void => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(e));
    } catch {
      // localStorage may be full / disabled; ignore.
    }
  };

  let cache: Entries | null = null;
  const entries = (): Entries => {
    if (cache === null) cache = read();
    return cache;
  };

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const cb of listeners) cb();
  };

  return {
    get(key) {
      return entries()[key];
    },
    set(key, value) {
      cache = { ...entries(), [key]: value };
      write(cache);
      onChange?.(key);
      notify();
    },
    remove(key) {
      const cur = entries();
      if (!(key in cur)) return;
      // Rebuild without the key so no stale "undefined" value lingers.
      const next: Entries = {};
      for (const k of Object.keys(cur)) {
        if (k !== key) next[k] = cur[k]!;
      }
      cache = next;
      write(next);
      onChange?.(key);
      notify();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
