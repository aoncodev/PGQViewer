import type { ErrorHint, ErrorHintAction } from '../lib/errors';

interface Props {
  hint: ErrorHint;
  rawError?: string;
  onDismiss?: () => void;
  /**
   * Invoked when the user clicks the hint's remediation button. Only rendered
   * when `hint.action` is set. The parent (Workspace) interprets the action —
   * e.g. switch to SQL mode and seed the editor — since this leaf component
   * owns no state and knows nothing about the editor.
   */
  onAction?: (a: ErrorHintAction) => void;
}

/**
 * Renders an actionable hint for a known PG19 SQL/PGQ error. Leaf component:
 * no state, no effects, no store reads. The parent decides when to show it
 * (typically by feeding the latest error string through matchHint() and
 * mounting this when the result is non-null).
 */
export function HintPopover({ hint, rawError, onDismiss, onAction }: Props) {
  return (
    <div
      role="status"
      className="rounded-lg border border-danger/40 bg-surface text-fg shadow-sm"
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-danger/15 text-[11px] font-bold text-danger"
        >
          !
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg">{hint.title}</div>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">{hint.hint}</p>
          {(hint.action || hint.docsHref) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {hint.action && onAction && (
                <button
                  type="button"
                  onClick={() => onAction(hint.action!)}
                  className="rounded border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/20"
                >
                  {hint.action.label}
                </button>
              )}
              {hint.docsHref && (
                <a
                  href={hint.docsHref}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-medium text-accent hover:underline"
                >
                  Open PG docs
                </a>
              )}
            </div>
          )}
          {rawError && (
            <details className="mt-2 text-[11px] text-fg-subtle">
              <summary className="cursor-pointer select-none hover:text-fg-muted">
                Server message
              </summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg px-2 py-1.5 font-mono text-fg-muted">
                {rawError}
              </pre>
            </details>
          )}
        </div>
        {onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss hint"
            className="shrink-0 rounded p-0.5 text-fg-subtle hover:bg-fg/10 hover:text-fg"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
