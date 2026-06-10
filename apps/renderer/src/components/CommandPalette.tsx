import { useEffect, useMemo, useRef, useState } from 'react';

export interface CommandAction {
  id: string;
  label: string;
  group?: string;
  hotkey?: string;
  run: () => void;
}

interface Props {
  actions: CommandAction[];
}

export function CommandPalette({ actions }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter(
      (a) => a.label.toLowerCase().includes(needle) || a.group?.toLowerCase().includes(needle),
    );
  }, [q, actions]);

  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered]);

  if (!open) return null;

  function pick(i: number) {
    const a = filtered[i];
    if (!a) return;
    setOpen(false);
    a.run();
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="mt-32 w-full max-w-xl overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(idx);
            }
          }}
          placeholder="Type a command…"
          className="w-full border-b border-border bg-bg px-4 py-3 text-sm text-fg outline-none placeholder:text-fg-subtle"
        />
        <ul role="listbox" className="max-h-96 overflow-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-sm text-fg-subtle">No matches.</li>
          )}
          {filtered.map((a, i) => (
            <li
              key={a.id}
              role="option"
              aria-selected={i === idx}
              onClick={() => pick(i)}
              onMouseEnter={() => setIdx(i)}
              className={`flex cursor-pointer items-center justify-between px-4 py-2 text-sm ${
                i === idx ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-surface-2'
              }`}
            >
              <span>
                {a.group && (
                  <span className="mr-2 text-[10px] uppercase tracking-wider text-fg-subtle">
                    {a.group}
                  </span>
                )}
                {a.label}
              </span>
              {a.hotkey && (
                <kbd className="rounded bg-bg px-1.5 py-0.5 text-[11px] text-fg-subtle">
                  {a.hotkey}
                </kbd>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
