import { useEffect } from 'react';
import { useApp, type Toast } from '../lib/store';

const AUTO_DISMISS_MS = 6000;

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const handle = window.setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(handle);
  }, [onDismiss]);

  const tone = ({
    error: 'border-danger/40 bg-danger-bg text-danger-fg',
    info: 'border-border bg-surface text-fg',
    success: 'border-accent/40 bg-surface text-fg',
  } as const)[toast.kind];

  const icon = ({
    error: '!',
    info: 'i',
    success: '✓',
  } as const)[toast.kind];

  return (
    <div
      role="status"
      className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur ${tone}`}
    >
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-current/10 text-xs font-bold"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-sm">{toast.message}</div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-fg/10 hover:text-fg"
      >
        ✕
      </button>
    </div>
  );
}
