// Floating toolbar for the graph canvas: layout picker, zoom / fit / focus
// controls, filter & edge-weight toggles, and PNG/JPG export. Extracted
// from GraphCanvas.tsx — purely presentational, driven entirely by props.

import type { ReactNode } from 'react';
import { LAYOUT_IDS, LAYOUT_LABELS, type LayoutId } from '../lib/graphLayouts';

export function GraphToolbar({
  layoutId,
  onLayoutChange,
  onRelayout,
  onZoomIn,
  onZoomOut,
  onFit,
  onPNG,
  onJPG,
  onFilter,
  onEdgeWeight,
  filterActive,
  edgeWeightActive,
  labelInside,
  onToggleLabelInside,
  focusMode,
  onToggleFocusMode,
  enabled,
}: {
  layoutId: LayoutId;
  onLayoutChange: (id: LayoutId) => void;
  onRelayout: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onPNG: () => void;
  onJPG: () => void;
  onFilter: () => void;
  onEdgeWeight: () => void;
  filterActive: boolean;
  edgeWeightActive: boolean;
  labelInside: boolean;
  onToggleLabelInside: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  enabled: boolean;
}) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-surface/95 px-1.5 py-1 shadow-sm backdrop-blur-sm">
      <select
        value={layoutId}
        onChange={(e) => onLayoutChange(e.target.value as LayoutId)}
        disabled={!enabled}
        title="Layout"
        className="pointer-events-auto rounded border border-transparent bg-surface px-1 py-0.5 text-xs text-fg outline-none hover:border-border focus:border-accent disabled:cursor-not-allowed disabled:opacity-40"
      >
        {LAYOUT_IDS.map((id) => (
          <option
            key={id}
            value={id}
            className="bg-surface text-fg"
          >
            {LAYOUT_LABELS[id]}
          </option>
        ))}
      </select>
      <ToolbarBtn onClick={onRelayout} disabled={!enabled} title="Re-run layout" aria-label="Re-run layout">
        <IconRefresh />
      </ToolbarBtn>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <ToolbarBtn onClick={onZoomOut} disabled={!enabled} title="Zoom out" aria-label="Zoom out">
        <IconMinus />
      </ToolbarBtn>
      <ToolbarBtn onClick={onZoomIn} disabled={!enabled} title="Zoom in" aria-label="Zoom in">
        <IconPlus />
      </ToolbarBtn>
      <ToolbarBtn onClick={onFit} disabled={!enabled} title="Fit to view" aria-label="Fit to view">
        <IconMaximize />
      </ToolbarBtn>
      <ToolbarBtn
        onClick={onToggleFocusMode}
        title={focusMode ? 'Exit focus mode (ESC)' : 'Focus mode — hide chrome, maximise canvas'}
        aria-label={focusMode ? 'Exit focus mode' : 'Enter focus mode'}
      >
        {focusMode ? <IconShrink /> : <IconExpand />}
      </ToolbarBtn>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        onClick={onToggleLabelInside}
        disabled={!enabled}
        title={
          labelInside
            ? 'Label inside — click to move below node'
            : 'Label below — click to center inside node'
        }
        aria-label="Toggle label placement"
        aria-pressed={labelInside}
        className={`pointer-events-auto rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          labelInside
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        {labelInside ? 'Label◉' : 'Label◯'}
      </button>
      <button
        type="button"
        onClick={onFilter}
        disabled={!enabled}
        title={filterActive ? 'Filter active — click to edit' : 'Filter by property'}
        aria-label="Filter graph"
        className={`pointer-events-auto rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          filterActive
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        Filter
      </button>
      <button
        type="button"
        onClick={onEdgeWeight}
        disabled={!enabled}
        title={edgeWeightActive ? 'Edge weight active — click to edit' : 'Edge thickness by property'}
        aria-label="Edge thickness"
        className={`pointer-events-auto rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          edgeWeightActive
            ? 'border-accent bg-accent/15 text-accent'
            : 'border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        Weight
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        onClick={onPNG}
        disabled={!enabled}
        title="Download as PNG"
        className="pointer-events-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        PNG
      </button>
      <button
        type="button"
        onClick={onJPG}
        disabled={!enabled}
        title="Download as JPG"
        className="pointer-events-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        JPG
      </button>
    </div>
  );
}

function ToolbarBtn({
  onClick,
  disabled,
  title,
  'aria-label': ariaLabel,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  'aria-label': string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

// --- icons (tiny stroke set) ---------------------------------------------

function strokeProps(className = 'h-3.5 w-3.5') {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}
function IconPlus() {
  return (
    <svg {...strokeProps()}>
      <line x1="12" y1="6" x2="12" y2="18" />
      <line x1="6" y1="12" x2="18" y2="12" />
    </svg>
  );
}
function IconMinus() {
  return (
    <svg {...strokeProps()}>
      <line x1="6" y1="12" x2="18" y2="12" />
    </svg>
  );
}
function IconMaximize() {
  return (
    <svg {...strokeProps()}>
      <polyline points="8 4 4 4 4 8" />
      <polyline points="16 4 20 4 20 8" />
      <polyline points="16 20 20 20 20 16" />
      <polyline points="8 20 4 20 4 16" />
    </svg>
  );
}
// 4-arrow-outward — enter focus mode. Distinct from IconMaximize (which is
// fit-to-view rectangle corners) so the two toolbar buttons read differently.
function IconExpand() {
  return (
    <svg {...strokeProps()}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
// 4-arrow-inward — exit focus mode.
function IconShrink() {
  return (
    <svg {...strokeProps()}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg {...strokeProps()}>
      <polyline points="21 4 21 10 15 10" />
      <path d="M3.51 15a9 9 0 0 0 14.85 3.36L21 16" />
      <polyline points="3 20 3 14 9 14" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L3 8" />
    </svg>
  );
}
