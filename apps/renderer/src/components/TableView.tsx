import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/store';
import { downloadBlob, exportCSV, exportJSON } from '../lib/exports';
import { formatValue } from '../lib/format';

// Default number of rows shown before the user clicks "Load more". Increments
// of the same size are appended on each click; the dataset itself is always
// in memory (the streaming query already pulled it).
const DEFAULT_WINDOW = 200;

type SortDir = 'asc' | 'desc' | null;

// Lightweight tri-state header sort. We track the *column index* being
// sorted plus its direction; clicking the same header cycles asc -> desc ->
// none. Manual implementation (no tanstack-table) per the M8 scope.
interface SortState {
  col: number | null;
  dir: SortDir;
}

export function TableView() {
  const columns = useApp((s) => s.resultColumns);
  const rows = useApp((s) => s.resultRows);

  // Per-column filter (case-insensitive substring against the formatted cell).
  // Initialised to empty strings whenever the column list changes.
  const [filters, setFilters] = useState<string[]>([]);
  const [sort, setSort] = useState<SortState>({ col: null, dir: null });
  const [windowSize, setWindowSize] = useState<number>(DEFAULT_WINDOW);

  useEffect(() => {
    setFilters(columns.map(() => ''));
    setSort({ col: null, dir: null });
    setWindowSize(DEFAULT_WINDOW);
  }, [columns]);

  // Filter step: any row that fails any active per-column filter drops out.
  // We intentionally re-derive on every dep change rather than caching; even
  // at 50k rows the filter is a fast scan and avoids stale-cache bugs.
  const filtered = useMemo(() => {
    const active = filters
      .map((f, i) => ({ i, q: f.trim().toLowerCase() }))
      .filter((x) => x.q.length > 0);
    if (active.length === 0) return rows;
    return rows.filter((row) =>
      active.every(({ i, q }) => formatCell(row[i]).toLowerCase().includes(q)),
    );
  }, [rows, filters]);

  // Sort step: stable Array.sort with a comparator that special-cases
  // numbers (so "10" doesn't sort before "2") but falls back to string
  // compare for everything else.
  const sorted = useMemo(() => {
    if (sort.col === null || sort.dir === null) return filtered;
    const col = sort.col;
    const factor = sort.dir === 'asc' ? 1 : -1;
    const copy = filtered.slice();
    copy.sort((a, b) => compareCells(a[col], b[col]) * factor);
    return copy;
  }, [filtered, sort]);

  const visible = useMemo(() => sorted.slice(0, windowSize), [sorted, windowSize]);

  const hasMore = sorted.length > visible.length;
  const totalRows = rows.length;
  const filteredRows = filtered.length;

  function toggleSort(col: number) {
    setSort((cur) => {
      if (cur.col !== col) return { col, dir: 'asc' };
      if (cur.dir === 'asc') return { col, dir: 'desc' };
      return { col: null, dir: null };
    });
  }

  function updateFilter(i: number, value: string) {
    setFilters((cur) => {
      const next = cur.slice();
      next[i] = value;
      return next;
    });
    // Filter changes invalidate the load-more window.
    setWindowSize(DEFAULT_WINDOW);
  }

  function loadMore() {
    setWindowSize((n) => n + DEFAULT_WINDOW);
  }

  function onExportCSV() {
    // Export the *current view* (post-filter, post-sort) so what the user
    // sees is what they get. The window cap is ignored on export — they
    // asked for the whole result.
    const text = exportCSV(columns, sorted);
    downloadBlob('result.csv', 'text/csv;charset=utf-8', text);
  }

  function onExportJSON() {
    const text = exportJSON(columns, sorted);
    downloadBlob('result.json', 'application/json', text);
  }

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
        Run a query to see rows here.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className="border-b border-border px-3 py-2 text-left align-bottom font-medium text-fg"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(i)}
                    className="group flex w-full items-baseline justify-between gap-2 text-left"
                    title="Click to sort"
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-xs text-fg-subtle group-hover:text-fg">
                      {sortGlyph(sort, i)}
                    </span>
                  </button>
                  <div className="text-xs font-normal text-fg-subtle">{c.type}</div>
                </th>
              ))}
            </tr>
            <tr>
              {columns.map((_c, i) => (
                <th
                  key={i}
                  className="border-b border-border bg-surface/60 px-2 py-1 align-top font-normal"
                >
                  <input
                    type="text"
                    value={filters[i] ?? ''}
                    onChange={(e) => updateFilter(i, e.target.value)}
                    placeholder="filter…"
                    className="w-full rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, ri) => (
              <tr
                key={ri}
                className={
                  ri % 2 === 0
                    ? 'bg-bg hover:bg-surface'
                    : 'bg-surface/50 hover:bg-surface'
                }
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="max-w-md truncate border-b border-border px-3 py-1.5 align-top font-mono text-xs text-fg"
                    title={formatCell(cell)}
                  >
                    {formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-surface px-3 py-1.5 text-xs text-fg-muted">
        <div>
          {filteredRows === totalRows
            ? `${visible.length.toLocaleString()} of ${totalRows.toLocaleString()} rows`
            : `${visible.length.toLocaleString()} of ${filteredRows.toLocaleString()} filtered (from ${totalRows.toLocaleString()})`}
        </div>
        <div className="flex items-center gap-2">
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              className="rounded border border-border bg-bg px-2 py-1 text-xs text-fg hover:bg-surface-2"
            >
              Load more (+{DEFAULT_WINDOW.toLocaleString()})
            </button>
          )}
          <button
            type="button"
            onClick={onExportCSV}
            className="rounded border border-border bg-bg px-2 py-1 text-xs text-fg hover:bg-surface-2"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={onExportJSON}
            className="rounded border border-border bg-bg px-2 py-1 text-xs text-fg hover:bg-surface-2"
          >
            Export JSON
          </button>
        </div>
      </div>
    </div>
  );
}

// The table shows a null glyph rather than an empty string so the user can
// still see something is there.
function formatCell(v: unknown): string {
  return formatValue(v, { nullText: '∅', undefinedText: '∅' });
}

function sortGlyph(s: SortState, col: number): string {
  if (s.col !== col || s.dir === null) return '↕'; // ↕
  return s.dir === 'asc' ? '↑' : '↓'; // ↑ / ↓
}

// compareCells is a generic comparator for sort. It treats nulls as smaller
// than any value, numbers comparably to numbers, and falls back to string
// compare. Stable order across consecutive equal values is preserved by
// Array.prototype.sort (ECMAScript 2019+).
function compareCells(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // Numeric strings — best-effort. We only fast-path when *both* strings
  // parse cleanly so partial numeric content still falls back to lexical.
  if (typeof a === 'string' && typeof b === 'string') {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && a.trim() !== '' && b.trim() !== '') {
      return na - nb;
    }
    return a.localeCompare(b);
  }
  const sa = formatCell(a);
  const sb = formatCell(b);
  return sa.localeCompare(sb);
}
