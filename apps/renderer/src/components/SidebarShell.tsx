import { type ReactNode } from 'react';

interface SidebarShellProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
  /** Title shown next to the collapse button when expanded. */
  title: string;
  /** Icon shown in the collapsed rail (a single character or short string). */
  collapsedIcon: string;
  /** When collapsed, the rail tooltip. */
  collapsedTooltip?: string;
  children: ReactNode;
  /** Pixel width when expanded; defaults to 18rem (288 px). */
  expandedWidthClass?: string;
  /**
   * Optional inline width in pixels. When set, overrides expandedWidthClass
   * and is the natural form for `useDragResize`. The Sidebar parent owns
   * this value; the shell only renders.
   */
  widthPx?: number;
  /**
   * Optional resize handle anchored to the edge nearest to the workspace.
   * Pass the `startDrag` from `useDragResize`. The handle absolutely
   * positions itself; the parent must keep `position: relative` (we already
   * apply it in this component).
   */
  onResize?: (e: React.MouseEvent) => void;
  /** Double-click handler on the resize handle — typically resets to default. */
  onResizeReset?: () => void;
}

/**
 * SidebarShell wraps any sidebar content in a collapsible chrome:
 *   - expanded: header with title + collapse button, content area below
 *   - collapsed: 40px rail with a single expand button
 *
 * The two sides differ only in the position of the collapse chevron and
 * which side the border falls on.
 */
export function SidebarShell({
  side,
  collapsed,
  onToggle,
  title,
  collapsedIcon,
  collapsedTooltip,
  children,
  expandedWidthClass = 'w-72',
  widthPx,
  onResize,
  onResizeReset,
}: SidebarShellProps) {
  if (collapsed) {
    return (
      <aside
        className={`flex h-full w-10 shrink-0 flex-col items-center bg-surface ${
          side === 'left' ? 'border-r border-border' : 'border-l border-border'
        }`}
      >
        <button
          onClick={onToggle}
          title={collapsedTooltip ?? `Expand ${title}`}
          aria-label={`Expand ${title}`}
          className="mt-2 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          {side === 'left' ? <ChevronRight /> : <ChevronLeft />}
        </button>
        <div className="mt-3 flex items-center justify-center text-fg-subtle" title={collapsedTooltip ?? title}>
          <span className="rotate-180 text-[10px] uppercase tracking-wider [writing-mode:vertical-rl]">
            {collapsedIcon}
          </span>
        </div>
      </aside>
    );
  }

  const widthClass = widthPx ? '' : expandedWidthClass;
  const style = widthPx ? { width: widthPx } : undefined;
  return (
    <aside
      style={style}
      className={`relative flex h-full ${widthClass} shrink-0 flex-col bg-surface ${
        side === 'left' ? 'border-r border-border' : 'border-l border-border'
      }`}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
          {title}
        </span>
        <button
          onClick={onToggle}
          title={`Collapse ${title}`}
          aria-label={`Collapse ${title}`}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          {side === 'left' ? <ChevronLeft /> : <ChevronRight />}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {onResize && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
          onMouseDown={onResize}
          onDoubleClick={onResizeReset}
          className={`absolute top-0 bottom-0 z-20 w-1.5 cursor-col-resize select-none transition-colors hover:bg-accent/30 active:bg-accent/50 ${
            side === 'left' ? 'right-[-3px]' : 'left-[-3px]'
          }`}
        />
      )}
    </aside>
  );
}

function ChevronLeft() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
