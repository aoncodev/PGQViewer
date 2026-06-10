import { useCallback, useEffect, useRef, useState } from 'react';
import { readNumber } from './storage';

interface Opts {
  /** localStorage key for persisting the size between sessions. */
  storageKey: string;
  /** Initial size in pixels. Used when nothing is persisted. */
  defaultSize: number;
  min: number;
  max: number;
  axis: 'x' | 'y';
  /**
   * Set to true when increasing size means decreasing cursor coordinate.
   * Use for right-anchored sidebars (dragging the handle left grows the
   * sidebar) and bottom-anchored panels.
   */
  invert?: boolean;
}

function persist(key: string, size: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, String(size));
}

/**
 * useDragResize returns a size value that the caller applies to one side of
 * a layout, plus a startDrag handler bound to a splitter handle's
 * onMouseDown. Listens for mousemove on document during drag so the cursor
 * can leave the handle without losing the drag.
 */
export function useDragResize(opts: Opts) {
  const [size, setSize] = useState<number>(() => readNumber(opts.storageKey, opts.defaultSize));
  const dragRef = useRef<{ start: number; size: number } | null>(null);
  // The latest opts.* used inside event handlers — captured in a ref so we
  // don't have to remove/re-add document listeners on every render.
  const cfgRef = useRef(opts);
  cfgRef.current = opts;

  const onMove = useCallback((e: MouseEvent) => {
    const s = dragRef.current;
    if (!s) return;
    const cfg = cfgRef.current;
    const cur = cfg.axis === 'x' ? e.clientX : e.clientY;
    let delta = cur - s.start;
    if (cfg.invert) delta = -delta;
    const next = Math.max(cfg.min, Math.min(cfg.max, s.size + delta));
    setSize(next);
  }, []);

  const onUp = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Read the latest size from state and persist it. We can't rely on the
    // closure-captured `size` because state updates inside onMove are batched.
    setSize((s) => {
      persist(cfgRef.current.storageKey, s);
      return s;
    });
  }, [onMove]);

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const cfg = cfgRef.current;
      dragRef.current = {
        start: cfg.axis === 'x' ? e.clientX : e.clientY,
        size,
      };
      document.body.style.cursor = cfg.axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [size, onMove, onUp],
  );

  const reset = useCallback(() => {
    setSize(opts.defaultSize);
    persist(opts.storageKey, opts.defaultSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.defaultSize, opts.storageKey]);

  // Cleanup: if the component unmounts mid-drag, drop the listeners.
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [onMove, onUp]);

  return { size, startDrag, reset };
}
