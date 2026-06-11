import { useMemo, useState } from 'react';

interface Props {
  /** Raw planner JSON captured from the {type:'explain', plan} event. */
  plan: unknown;
  onClose?: () => void;
}

/**
 * Renders the JSON query plan returned by an EXPLAIN / EXPLAIN ANALYZE run.
 * Shown as an overlay panel above the result tabs. Pretty-prints the plan and
 * offers a Copy button; the parent owns when it's mounted (plan != null).
 */
export function ExplainPanel({ plan, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => {
    try {
      return JSON.stringify(plan, null, 2);
    } catch {
      return String(plan);
    }
  }, [plan]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — selectable fallback */
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs font-medium text-fg">Query plan</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close plan"
              className="rounded p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-fg">
        {text}
      </pre>
    </div>
  );
}
