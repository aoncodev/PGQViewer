interface SplitterProps {
  axis: 'x' | 'y';
  onMouseDown: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  /**
   * When true the splitter floats absolutely over the edge of its parent.
   * Use this for sidebar handles so they don't take up layout width.
   */
  floating?: boolean;
  /**
   * For floating="x" handles, which edge of the parent to anchor to.
   * Ignored when floating is false or axis is 'y'.
   */
  edge?: 'left' | 'right';
  title?: string;
}

/**
 * Thin drag handle used to resize an adjacent panel. The visible footprint
 * is a 6px bar; the hover state shows a subtle accent line so users can
 * find the affordance without seeing a permanent divider.
 */
export function Splitter({
  axis,
  onMouseDown,
  onDoubleClick,
  floating = false,
  edge,
  title,
}: SplitterProps) {
  const isX = axis === 'x';
  const base = isX
    ? 'cursor-col-resize'
    : 'cursor-row-resize';
  const visual = isX
    ? 'group/splitter relative h-full w-1.5 hover:bg-accent/30 active:bg-accent/50'
    : 'group/splitter relative w-full h-1.5 hover:bg-accent/30 active:bg-accent/50';

  if (floating && isX) {
    const side = edge === 'left' ? 'left-[-3px]' : 'right-[-3px]';
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        title={title ?? 'Drag to resize'}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        className={`absolute top-0 bottom-0 z-20 w-1.5 ${side} ${base} hover:bg-accent/30 active:bg-accent/50 select-none transition-colors`}
      />
    );
  }
  return (
    <div
      role="separator"
      aria-orientation={isX ? 'vertical' : 'horizontal'}
      title={title ?? 'Drag to resize'}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className={`${visual} ${base} select-none transition-colors`}
    />
  );
}
