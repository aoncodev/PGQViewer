import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  // Optional footer slot. Pass action buttons here; the modal body handles
  // its own padding so footers stick visually to the bottom.
  footer?: React.ReactNode;
  children: React.ReactNode;
  // Tailwind width class — default is wide enough for the filter rows.
  widthClass?: string;
}

// Minimal portal-mounted modal: backdrop click closes, ESC closes, focus
// is moved into the dialog on open. No animation, no focus trap beyond the
// initial move (keeps the implementation small; the modals we use here are
// single-form and don't have complex interactive layouts behind them).
export function Modal({
  open,
  onClose,
  title,
  footer,
  children,
  widthClass = 'max-w-2xl',
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The App-level focus-mode ESC handler skips when modalOpen !== null,
      // so we just need to dismiss ourselves. No stopPropagation games.
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // Close on backdrop click — but only if the click started on the
        // backdrop. Clicks that begin inside the modal and end outside (e.g.
        // text-selection drag) should not dismiss.
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm"
    >
      <div
        className={`flex w-full ${widthClass} max-h-[80vh] flex-col overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-2xl mx-4`}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/30 px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
