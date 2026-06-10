import { useEffect, useRef } from 'react';
import {
  PICKER_HUES,
  clearLabelOverride,
  getLabelOverride,
  setLabelOverride,
} from '../lib/labelColors';
import type { Theme } from '../lib/store';

interface Props {
  label: string;
  theme: Theme;
  /** Called when the user changes or clears the override. */
  onChange: () => void;
  /** Called when the user dismisses without picking (Escape / outside click). */
  onClose: () => void;
}

/**
 * Inline picker rendered just below a sidebar element row. Eight swatches +
 * an Auto pill that drops the override.
 *
 * The component owns its own click-outside / Escape handling; the parent
 * only needs to mount/unmount it based on whether it should be open.
 */
export function ColorPicker({ label, theme, onChange, onClose }: Props) {
  const current = getLabelOverride(label);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Colour for ${label}`}
      onClick={(e) => e.stopPropagation()}
      className="mt-1.5 flex items-center gap-1 rounded-md border border-border bg-surface p-1 shadow-sm"
    >
      {PICKER_HUES.map((hue) => {
        const swatch = previewColor(label, theme, hue);
        const selected = current === hue;
        return (
          <button
            key={hue}
            type="button"
            title={`Set colour ${hue}°`}
            onClick={() => {
              setLabelOverride(label, hue);
              onChange();
            }}
            style={{ backgroundColor: swatch }}
            className={`h-4 w-4 rounded-full transition-transform hover:scale-110 ${
              selected ? 'ring-2 ring-fg ring-offset-1 ring-offset-surface' : ''
            }`}
            aria-pressed={selected}
          />
        );
      })}
      <button
        type="button"
        title="Reset to automatic colour"
        onClick={() => {
          clearLabelOverride(label);
          onChange();
        }}
        className={`ml-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
          current === undefined
            ? 'bg-accent/15 text-fg'
            : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        Auto
      </button>
    </div>
  );
}

// previewColor returns the fill that would result from setting this hue,
// independent of any current override. Used so each swatch in the picker
// shows what it'd actually look like on the canvas at the current theme.
function previewColor(_label: string, theme: Theme, hue: number): string {
  // Simulate: the same L / C the live palette uses; just the hue differs.
  // We reuse colorForLabel by picking a label that can never collide with
  // a real one; the hash then routes via the override path we're about to
  // pick. But since we don't want a side effect we go straight to the
  // canvas-side OKLCH and resolve via the existing toRGB shim.
  return resolveOklch(
    theme === 'dark' ? `oklch(0.66 0.16 ${hue})` : `oklch(0.62 0.16 ${hue})`,
  );
}

let _ctx: CanvasRenderingContext2D | null = null;
function resolveOklch(color: string): string {
  if (!_ctx) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    _ctx = cv.getContext('2d');
  }
  if (!_ctx) return color;
  _ctx.clearRect(0, 0, 1, 1);
  _ctx.fillStyle = '#000';
  _ctx.fillStyle = color;
  _ctx.fillRect(0, 0, 1, 1);
  const d = _ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
}
