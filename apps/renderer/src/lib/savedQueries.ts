// Named saved queries, persisted to localStorage. Distinct from the per-mode
// query history (which is an unnamed rolling buffer in Workspace): saved
// queries are explicitly named and never evicted, so users can keep a small
// library of patterns they re-run often.

import { readJSON } from './storage';

export interface SavedQuery {
  id: string;
  name: string;
  mode: 'graph' | 'sql';
  /** For graph mode: the MATCH pattern. For SQL mode: the SQL text. */
  text: string;
  /** Optional WHERE predicate captured alongside a graph-mode pattern. */
  where?: string;
  created_at: number;
}

const KEY = 'pgviewer.savedQueries';

function isSavedQuery(v: unknown): v is SavedQuery {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    (o.mode === 'graph' || o.mode === 'sql') &&
    typeof o.text === 'string' &&
    typeof o.created_at === 'number'
  );
}

/** Reads the saved-query library; returns [] on missing/invalid storage. */
export function loadSavedQueries(): SavedQuery[] {
  return readJSON<SavedQuery[]>(
    KEY,
    (v) => (Array.isArray(v) ? v.filter(isSavedQuery) : undefined),
    [],
  );
}

function persist(list: SavedQuery[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or disabled — fine to drop the write. */
  }
}

// id generator — crypto.randomUUID where available, timestamp+rand fallback.
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Adds a saved query and returns the new list. A name collision within the
 * same mode overwrites the existing entry (so re-saving under the same name
 * updates it rather than duplicating).
 */
export function addSavedQuery(
  existing: SavedQuery[],
  input: Omit<SavedQuery, 'id' | 'created_at'>,
): SavedQuery[] {
  const filtered = existing.filter(
    (q) => !(q.mode === input.mode && q.name === input.name),
  );
  const next: SavedQuery[] = [
    ...filtered,
    { ...input, id: newId(), created_at: Date.now() },
  ];
  persist(next);
  return next;
}

/** Removes the saved query with `id` and returns the new list. */
export function removeSavedQuery(existing: SavedQuery[], id: string): SavedQuery[] {
  const next = existing.filter((q) => q.id !== id);
  persist(next);
  return next;
}
