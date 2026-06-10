import { useEffect, useRef, useState } from 'react';
import { PALETTES, paletteById, type PaletteId } from '../lib/palettes';
import { useApp } from '../lib/store';

// Compact swatch button + popover for picking the accent palette. Lives in
// the header next to the light/dark toggle.
export function PalettePicker() {
  const palette = useApp((s) => s.palette);
  const setPalette = useApp((s) => s.setPalette);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Click-outside + Escape to dismiss. We register on document so the
  // listener catches clicks anywhere, including other header buttons.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = paletteById(palette);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Accent palette: ${current.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Accent palette: ${current.name}`}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface transition-colors hover:bg-surface-2"
      >
        <span
          className="block h-3.5 w-3.5 rounded-full ring-1 ring-inset ring-black/15"
          style={{ backgroundColor: current.swatch }}
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose accent palette"
          className="absolute right-0 top-9 z-50 w-56 rounded-md border border-border bg-surface p-2 shadow-lg"
        >
          <div className="px-1 pb-1 text-[11px] uppercase tracking-wide text-fg-subtle">
            Accent palette
          </div>
          <ul className="space-y-0.5">
            {PALETTES.map((p) => (
              <PaletteRow
                key={p.id}
                id={p.id}
                name={p.name}
                swatch={p.swatch}
                active={p.id === palette}
                onPick={() => {
                  setPalette(p.id);
                  setOpen(false);
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PaletteRow({
  name,
  swatch,
  active,
  onPick,
}: {
  id: PaletteId;
  name: string;
  swatch: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <li>
      <button
        onClick={onPick}
        className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
          active
            ? 'bg-surface-2 text-fg'
            : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
      >
        <span
          className="block h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15"
          style={{ backgroundColor: swatch }}
        />
        <span className="flex-1">{name}</span>
        {active && <CheckIcon className="h-3.5 w-3.5 text-accent" />}
      </button>
    </li>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
