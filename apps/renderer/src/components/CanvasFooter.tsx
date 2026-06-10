import { useEffect, useState } from 'react';
import { formatValue } from '../lib/format';
import {
  clearLabelCaption,
  getLabelCaption,
  setLabelCaption,
  subscribeLabelCaptions,
} from '../lib/labelCaptions';

// SelectionData mirrors what GraphCanvas reads from a Cytoscape element's
// `.data()` plus the kind discriminator from element type. It's defined here
// so the footer can be rendered independently of Cytoscape internals (and so
// React can re-render on store changes without touching cy).
export interface SelectionData {
  kind: 'v' | 'e';
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  source?: string;
  destination?: string;
}

interface CanvasFooterProps {
  selection: SelectionData | null;
  nodeCount: number;
  edgeCount: number;
  /** Edges in the result set that are NOT rendered — their endpoint vertex
   * never arrived (cap/limit truncation) or the user hid it. Zero when the
   * canvas shows everything the counts claim. */
  hiddenEdgeCount?: number;
  /** Schema-derived list of properties for the selected label, if known.
   * Used to populate the caption picker dropdown. When null/empty, the
   * caption picker falls back to the keys present on the selected element. */
  selectedLabelProperties?: string[];
}

export function CanvasFooter({
  selection,
  nodeCount,
  edgeCount,
  hiddenEdgeCount = 0,
  selectedLabelProperties,
}: CanvasFooterProps) {
  // Track caption override version so the dropdown reflects external changes.
  const [, bump] = useState(0);
  useEffect(() => subscribeLabelCaptions(() => bump((n) => n + 1)), []);

  if (!selection) {
    return (
      <div className="pointer-events-auto absolute bottom-3 left-3 z-10 inline-flex items-center gap-2 rounded-md border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-fg-muted shadow-sm backdrop-blur-sm">
        <span className="text-fg-subtle">Displaying</span>
        <span className="font-semibold tabular-nums text-fg">{nodeCount.toLocaleString()}</span>
        <span className="text-fg-subtle">nodes ·</span>
        <span className="font-semibold tabular-nums text-fg">{edgeCount.toLocaleString()}</span>
        <span className="text-fg-subtle">edges</span>
        {hiddenEdgeCount > 0 && (
          <span
            className="text-warning"
            title="These edges are part of the result but can't be rendered — an endpoint vertex is missing from the canvas (row limit / element cap truncation, or hidden by you). They still appear in JSON/GraphML/Cypher exports."
          >
            · {hiddenEdgeCount.toLocaleString()} not drawn
          </span>
        )}
      </div>
    );
  }

  const primaryLabel = selection.labels[0] ?? '';
  const propEntries = Object.entries(selection.properties);
  const propsFromSchema = selectedLabelProperties && selectedLabelProperties.length > 0
    ? selectedLabelProperties
    : propEntries.map(([k]) => k);
  const currentCaption = primaryLabel ? getLabelCaption(primaryLabel) : undefined;

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 right-3 z-10 flex max-h-[42%] flex-col rounded-md border border-border bg-surface/95 shadow-md backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${
          selection.kind === 'v' ? 'bg-accent/15 text-accent' : 'bg-fg-muted/15 text-fg-muted'
        }`}>
          {selection.kind === 'v' ? 'vertex' : 'edge'}
        </span>
        <span className="truncate font-semibold text-fg">{primaryLabel || '(unlabelled)'}</span>
        {selection.labels.length > 1 && (
          <span className="truncate font-mono text-[10px] text-fg-subtle">
            · {selection.labels.slice(1).join(', ')}
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle" title={selection.id}>
          gid: {truncateId(selection.id)}
        </span>
      </div>

      {selection.kind === 'e' && selection.source && selection.destination && (
        <div className="border-b border-border px-3 py-1 text-[10px] font-mono text-fg-subtle">
          {truncateId(selection.source)}
          <span className="mx-1.5 text-fg-muted">→</span>
          {truncateId(selection.destination)}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {propEntries.length === 0 ? (
          <div className="italic text-[11px] text-fg-subtle">no properties</div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            {propEntries.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="truncate font-mono text-fg-subtle">{k}</dt>
                <dd className="break-all font-mono text-fg" title={String(v)}>
                  {formatValue(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {selection.kind === 'v' && primaryLabel && propsFromSchema.length > 0 && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-[10px]">
          <span className="text-fg-subtle">Caption for "{primaryLabel}":</span>
          <select
            value={currentCaption ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') clearLabelCaption(primaryLabel);
              else setLabelCaption(primaryLabel, v);
            }}
            className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-fg outline-none focus:border-accent"
          >
            <option value="" className="bg-surface text-fg">auto</option>
            {propsFromSchema.map((p) => (
              <option key={p} value={p} className="bg-surface text-fg">
                {p}
              </option>
            ))}
          </select>
          {currentCaption && (
            <button
              type="button"
              onClick={() => clearLabelCaption(primaryLabel)}
              className="rounded px-1.5 py-0.5 text-[10px] text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              reset
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function truncateId(id: string): string {
  if (id.length <= 28) return id;
  return id.slice(0, 12) + '…' + id.slice(-12);
}
