import { useEffect, useState } from 'react';
import {
  closeSession,
  getGraphCounts,
  getGraphMetadata,
  listGraphs,
  type Element,
  type LabelCount,
  type Property,
} from '../lib/api';
import { useApp, type Theme } from '../lib/store';
import { colorForLabel } from '../lib/colors';
import { subscribeLabelOverrides } from '../lib/labelColors';
import { useDragResize } from '../lib/useDragResize';
import { ColorPicker } from './ColorPicker';
import { DatabaseIcon, PowerIcon } from './Icons';
import { SidebarShell } from './SidebarShell';

export function Sidebar() {
  const sid = useApp((s) => s.sid);
  const label = useApp((s) => s.label);
  const graphs = useApp((s) => s.graphs);
  const setGraphs = useApp((s) => s.setGraphs);
  const selectedOID = useApp((s) => s.selectedGraphOID);
  const selectGraph = useApp((s) => s.selectGraph);
  const metadata = useApp((s) => s.metadata);
  const setMetadata = useApp((s) => s.setMetadata);
  const counts = useApp((s) => s.counts);
  const setCounts = useApp((s) => s.setCounts);
  const setSession = useApp((s) => s.setSession);
  const clearResult = useApp((s) => s.clearResult);
  const pushToast = useApp((s) => s.pushToast);
  const theme = useApp((s) => s.theme);
  const insertSnippet = useApp((s) => s.insertSnippet);

  const collapsed = useApp((s) => s.leftCollapsed);
  const setCollapsed = useApp((s) => s.setLeftCollapsed);
  const { size: width, startDrag, reset } = useDragResize({
    storageKey: 'pgviewer.sidebar.left.width',
    defaultSize: 296,
    min: 240,
    max: 560,
    axis: 'x',
  });

  useEffect(() => {
    if (!sid) return;
    let cancelled = false;
    listGraphs(sid)
      .then((g) => {
        if (cancelled) return;
        setGraphs(g);
        if (g.length === 1 && g[0]) selectGraph(g[0].oid);
      })
      .catch((e) => {
        if (cancelled) return;
        pushToast('error', String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [sid, setGraphs, selectGraph, pushToast]);

  useEffect(() => {
    if (!sid || !selectedOID) return;
    // Guard against stale responses: if the user switches graphs again
    // before this fetch completes, the older response would otherwise
    // overwrite the newer one. The cleanup sets `cancelled`, after which
    // the resolved promise's branch is a no-op.
    let cancelled = false;
    clearResult();
    Promise.all([getGraphMetadata(sid, selectedOID), getGraphCounts(sid, selectedOID)])
      .then(([md, c]) => {
        if (cancelled) return;
        setMetadata(md);
        setCounts(c);
      })
      .catch((e) => {
        if (cancelled) return;
        pushToast('error', String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [sid, selectedOID, setMetadata, setCounts, clearResult, pushToast]);

  async function disconnect() {
    if (!sid) return;
    try {
      await closeSession(sid);
    } finally {
      setSession(null, null);
      setGraphs([]);
      selectGraph(null);
      setMetadata(null);
      setCounts([]);
      clearResult();
    }
  }

  return (
    <SidebarShell
      side="left"
      collapsed={collapsed}
      onToggle={() => setCollapsed(!collapsed)}
      title="Connection · Schema"
      collapsedIcon="SCHEMA"
      collapsedTooltip={label ?? 'Schema'}
      widthPx={width}
      onResize={startDrag}
      onResizeReset={reset}
    >
      <ConnectionCard label={label} onDisconnect={disconnect} />
      <GraphList
        graphs={graphs}
        selectedOID={selectedOID}
        onSelect={selectGraph}
      />
      {metadata && (
        <SchemaSection
          metadata={metadata}
          counts={counts}
          theme={theme}
          onInsert={(text) => insertSnippet('graph', text)}
        />
      )}
    </SidebarShell>
  );
}

function ConnectionCard({
  label,
  onDisconnect,
}: {
  label: string | null;
  onDisconnect: () => void;
}) {
  return (
    <section className="border-b border-border px-3 py-2.5">
      <div className="group flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-2">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-mono text-[12px] font-medium text-fg"
            title={label ?? ''}
          >
            {label ?? '—'}
          </div>
        </div>
        <button
          onClick={onDisconnect}
          title="Disconnect"
          aria-label="Disconnect"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-danger/15 hover:text-danger"
        >
          <PowerIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </section>
  );
}

function GraphList({
  graphs,
  selectedOID,
  onSelect,
}: {
  graphs: ReturnType<typeof useApp.getState>['graphs'];
  selectedOID: number | null;
  onSelect: (oid: number) => void;
}) {
  return (
    <section className="border-b border-border px-3 py-3">
      <SectionHeader title="Property graphs" count={graphs.length} />
      {graphs.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-2.5 py-4 text-center text-xs text-fg-subtle">
          None visible.
        </div>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {graphs.map((g) => {
            const active = selectedOID === g.oid;
            return (
              <li key={g.oid}>
                <button
                  onClick={() => onSelect(g.oid)}
                  className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
                    active
                      ? 'bg-accent/12 text-fg'
                      : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                  }`}
                >
                  <span
                    className={`h-4 w-0.5 shrink-0 rounded-full transition-colors ${
                      active ? 'bg-accent' : 'bg-transparent group-hover:bg-border-strong'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-fg-subtle">{g.schema}.</span>
                    <span className={active ? 'font-medium' : ''}>{g.name}</span>
                  </span>
                  {g.owner && (
                    <span className="hidden text-[10px] text-fg-subtle group-hover:inline">
                      {g.owner}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SchemaSection({
  metadata,
  counts,
  theme,
  onInsert,
}: {
  metadata: NonNullable<ReturnType<typeof useApp.getState>['metadata']>;
  counts: LabelCount[];
  theme: Theme;
  onInsert: (snippet: string) => void;
}) {
  // Filter is held in the store so the canvas can mirror it as an opacity
  // fade — typing "person" here both narrows the schema list AND dims
  // canvas elements whose labels/properties don't match.
  const filter = useApp((s) => s.canvasFilter);
  const setFilter = useApp((s) => s.setCanvasFilter);
  const f = filter.trim().toLowerCase();

  const matches = (e: Element): boolean => {
    if (!f) return true;
    if (e.alias.toLowerCase().includes(f)) return true;
    if (e.labels.some((l) => l.toLowerCase().includes(f))) return true;
    if (e.properties.some((p) => p.name.toLowerCase().includes(f))) return true;
    return false;
  };

  const vertices = (metadata.vertices ?? []).filter(matches);
  const edges = (metadata.edges ?? []).filter(matches);

  return (
    <section className="px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <SectionHeader title="Schema" />
        <span className="text-[10px] text-fg-subtle">
          {metadata.vertices?.length ?? 0}v · {metadata.edges?.length ?? 0}e
        </span>
      </div>
      <input
        type="text"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter labels / properties…"
        className="mb-3 w-full rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg placeholder:text-fg-subtle outline-none focus:border-accent focus:ring-1 focus:ring-[var(--focus-ring)]"
      />
      <ElementGroup
        kind="v"
        title="Vertices"
        items={vertices}
        counts={counts}
        theme={theme}
        onInsert={onInsert}
        vertexLookup={vertexLookup(metadata.vertices)}
      />
      <ElementGroup
        kind="e"
        title="Edges"
        items={edges}
        counts={counts}
        theme={theme}
        onInsert={onInsert}
        vertexLookup={vertexLookup(metadata.vertices)}
      />
      {f && vertices.length === 0 && edges.length === 0 && (
        <div className="rounded-md border border-dashed border-border px-2.5 py-3 text-center text-xs text-fg-subtle">
          No matches for "{filter}".
        </div>
      )}
    </section>
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
        {title}
      </span>
      {count !== undefined && (
        <span className="text-[10px] text-fg-subtle">{count}</span>
      )}
    </div>
  );
}

// vertexLookup builds an alias → label map so edges can render
// `srcLabel → dstLabel` without re-scanning the vertex list per row.
function vertexLookup(vertices: Element[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const v of vertices) {
    m.set(v.alias, v.labels[0] ?? v.alias);
  }
  return m;
}

function ElementGroup({
  kind,
  title,
  items,
  counts,
  theme,
  onInsert,
  vertexLookup,
}: {
  kind: 'v' | 'e';
  title: string;
  items: Element[];
  counts: LabelCount[];
  theme: Theme;
  onInsert: (snippet: string) => void;
  vertexLookup: Map<string, string>;
}) {
  // openPickerLabel: which label currently has its inline ColorPicker
  // expanded (single-open semantics — opening one closes the rest).
  const [openPickerLabel, setOpenPickerLabel] = useState<string | null>(null);
  // expandedOid: which row has its property list expanded.
  const [expandedOid, setExpandedOid] = useState<number | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    return subscribeLabelOverrides(() => bump((n) => n + 1));
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold text-fg-muted">{title}</span>
        <span className="text-[10px] text-fg-subtle">{items.length}</span>
      </div>
      <ul className="space-y-1">
        {items.map((e) => (
          <ElementRow
            key={e.oid}
            kind={kind}
            element={e}
            count={counts.find((x) => x.element_oid === e.oid)?.count}
            theme={theme}
            pickerOpen={openPickerLabel === (e.labels[0] ?? e.alias)}
            onTogglePicker={() => {
              const key = e.labels[0] ?? e.alias;
              setOpenPickerLabel((cur) => (cur === key ? null : key));
            }}
            expanded={expandedOid === e.oid}
            onToggleExpand={() =>
              setExpandedOid((cur) => (cur === e.oid ? null : e.oid))
            }
            onInsert={onInsert}
            vertexLookup={vertexLookup}
          />
        ))}
      </ul>
    </div>
  );
}

function ElementRow({
  kind,
  element,
  count,
  theme,
  pickerOpen,
  onTogglePicker,
  expanded,
  onToggleExpand,
  onInsert,
  vertexLookup,
}: {
  kind: 'v' | 'e';
  element: Element;
  count: number | undefined;
  theme: Theme;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onInsert: (snippet: string) => void;
  vertexLookup: Map<string, string>;
}) {
  const labelKey = element.labels[0] ?? element.alias;
  // Don't memoize: colorForLabel has its own cache (invalidated when the user
  // changes an override), and ElementGroup already forces a re-render on
  // override events. A useMemo here would lock onto a stale value because
  // `labelKey` and `theme` don't change when only the override flips.
  const swatch = colorForLabel(labelKey, theme);
  const primaryLabel = element.labels[0] ?? element.alias;

  const srcLabel =
    kind === 'e' && element.source ? vertexLookup.get(element.source.vertex) ?? element.source.vertex : null;
  const dstLabel =
    kind === 'e' && element.destination
      ? vertexLookup.get(element.destination.vertex) ?? element.destination.vertex
      : null;

  function insert() {
    const snippet = kind === 'v'
      ? vertexSnippet(primaryLabel)
      : edgeSnippet(primaryLabel, srcLabel, dstLabel);
    onInsert(snippet);
  }

  return (
    <li className="overflow-hidden rounded-md border border-transparent bg-surface-2/40 hover:border-border hover:bg-surface-2">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            onTogglePicker();
          }}
          title={`Change colour for "${labelKey}"`}
          aria-label={`Change colour for ${labelKey}`}
          style={{ backgroundColor: swatch.fill }}
          className="h-3 w-3 shrink-0 rounded-full transition-transform hover:scale-125 focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
        />
        <button
          type="button"
          onClick={insert}
          title={`Replace editor with ${kind === 'v' ? 'vertex' : 'edge'} pattern`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="truncate text-[13px] font-medium text-fg">{element.alias}</span>
          {kind === 'e' && srcLabel && dstLabel && (
            <span className="hidden truncate text-[10px] text-fg-subtle md:inline">
              <span className="font-mono">{srcLabel}</span>
              <span className="mx-1">→</span>
              <span className="font-mono">{dstLabel}</span>
            </span>
          )}
        </button>
        {count !== undefined && (
          <span
            className="rounded bg-bg px-1.5 py-0.5 text-[10px] tabular-nums text-fg-subtle"
            title={
              count < 0
                ? 'No statistics yet — run ANALYZE on the underlying table for an estimate.'
                : `Approximate rows (from pg_class.reltuples). Run ANALYZE for a fresh number.`
            }
          >
            {formatApproxCount(count)}
          </span>
        )}
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? 'Collapse details' : 'Expand details'}
          aria-expanded={expanded}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <Chevron open={expanded} />
        </button>
      </div>

      {!expanded && (element.labels.length > 0 || element.properties.length > 0) && (
        <div className="-mt-0.5 truncate px-2 pb-1.5 pl-7 text-[11px] text-fg-subtle">
          {element.labels.join(', ') || 'no label'}
          {element.properties.length > 0 && (
            <> · <span>{element.properties.length} prop{element.properties.length === 1 ? '' : 's'}</span></>
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-border bg-bg px-3 py-2 text-[11px] text-fg-muted">
          {element.labels.length > 0 && (
            <Detail term="labels">
              <span className="font-mono">{element.labels.join(', ')}</span>
            </Detail>
          )}
          {kind === 'e' && srcLabel && dstLabel && (
            <Detail term="endpoints">
              <span className="font-mono">{srcLabel}</span>
              <span className="mx-1 text-fg-subtle">→</span>
              <span className="font-mono">{dstLabel}</span>
            </Detail>
          )}
          {element.properties.length > 0 ? (
            <Detail term="props">
              <span className="flex flex-wrap gap-1">
                {element.properties.map((p) => (
                  <PropertyChip key={p.name} prop={p} />
                ))}
              </span>
            </Detail>
          ) : (
            <Detail term="props"><span className="italic text-fg-subtle">none</span></Detail>
          )}
        </div>
      )}

      {pickerOpen && (
        <div className="border-t border-border px-2 pb-2">
          <ColorPicker
            label={labelKey}
            theme={theme}
            onChange={() => {
              /* override events propagate via subscribeLabelOverrides */
            }}
            onClose={onTogglePicker}
          />
        </div>
      )}
    </li>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="mb-1 flex gap-2 last:mb-0">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-fg-subtle">
        {term}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function PropertyChip({ prop }: { prop: Property }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[10px] text-fg"
      title={prop.expression ? `${prop.name}: ${prop.type} = ${prop.expression}` : `${prop.name}: ${prop.type}`}
    >
      <span>{prop.name}</span>
      <span className="text-fg-subtle">{prop.type}</span>
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// --- snippet helpers -----------------------------------------------------

// Pick an alphabetic alias from the first letter of `label`, normalised. Two
// callers in the same click don't share state — collisions inside a single
// insertion get suffixed (`p`, `p2`), but collisions against text already in
// the editor are tolerated; the user can rename, or the server will surface
// the SQL/PGQ error.
function aliasFor(label: string, used: Set<string>): string {
  const base = (label[0] ?? 'x').toLowerCase().replace(/[^a-z]/g, '') || 'x';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let n = 2; n < 100; n++) {
    const cand = `${base}${n}`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
  used.add(base);
  return base;
}

function vertexSnippet(label: string): string {
  const used = new Set<string>();
  const a = aliasFor(label, used);
  return `(${a} IS ${label})`;
}

function edgeSnippet(label: string, srcLabel: string | null, dstLabel: string | null): string {
  const used = new Set<string>();
  const src = srcLabel ?? 'a';
  const dst = dstLabel ?? 'b';
  const a = aliasFor(src, used);
  const k = aliasFor(label, used);
  const b = aliasFor(dst, used);
  return `(${a} IS ${src})-[${k} IS ${label}]->(${b} IS ${dst})`;
}

// formatApproxCount renders pg_class.reltuples for the sidebar badge.
//   • -1 (or any negative value) → "—". PG has never analyzed the table
//     so any number we'd show would be a fabrication.
//   •  0 → "0". An empty table is a real, valid state.
//   •  < 1k → exact value, since the planner stores small counts precisely.
//   •  1k–999k → "1.2K", "12K".
//   •  ≥ 1M → "1.2M", "12M".
// We prefix with "~" once we abbreviate so users see the truncation
// is theirs, not ours.
function formatApproxCount(n: number): string {
  if (n < 0) return '—';
  if (n < 1000) return n.toLocaleString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return '~' + (Math.round(k * 10) / 10).toString().replace(/\.0$/, '') + 'K';
  }
  const m = n / 1_000_000;
  return '~' + (Math.round(m * 10) / 10).toString().replace(/\.0$/, '') + 'M';
}
