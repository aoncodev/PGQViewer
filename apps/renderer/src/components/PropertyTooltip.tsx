// Hover tooltip for a graph vertex / edge — title, kind badge, and a
// property grid. Extracted from GraphCanvas.tsx; purely presentational.

import { formatValue } from '../lib/format';

// TooltipState is both this component's props and the state GraphCanvas
// holds for the currently-hovered element.
export interface TooltipState {
  left: number;
  top: number;
  title: string;
  subtitle: string;
  kind: 'v' | 'e';
  properties: [string, unknown][];
}

export function PropertyTooltip({
  left,
  top,
  title,
  subtitle,
  kind,
  properties,
}: TooltipState) {
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left,
        top,
        transform: 'translate(-50%, -100%)',
        zIndex: 6,
      }}
      className="pointer-events-none max-w-xs rounded-md border border-border bg-surface/95 px-2.5 py-2 text-[11px] shadow-lg backdrop-blur-sm"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate font-medium text-fg">{title || '—'}</span>
        <span className="shrink-0 rounded bg-bg px-1 py-px text-[9px] font-medium uppercase tracking-wider text-fg-subtle">
          {kind === 'v' ? 'vertex' : 'edge'}
        </span>
      </div>
      {subtitle && (
        <div className="mb-1.5 truncate text-[10px] font-mono text-fg-subtle">{subtitle}</div>
      )}
      {properties.length === 0 ? (
        <div className="italic text-fg-subtle">no properties</div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {properties.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="truncate font-mono text-fg-subtle">{k}</dt>
              <dd className="truncate font-mono text-fg" title={String(v)}>
                {formatValue(v, { maxLen: 40 })}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
