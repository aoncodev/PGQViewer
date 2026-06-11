import { useState } from 'react';
import type { MetaEvent } from '../lib/api';

interface Props {
  /** The projected GRAPH_TABLE SQL captured from the meta event. */
  sql: string;
  /** Per-binding projection summary captured from the meta event. */
  bindings?: MetaEvent['bindings'];
  /** Hand the SQL to SQL mode (setMode('sql') + setSqlText(sql)). */
  onOpenInSql: (sql: string) => void;
}

/**
 * Collapsible "Generated SQL" panel shown below the editor in graph mode
 * after a run. Surfaces the exact GRAPH_TABLE query the server projected so
 * users can learn the SQL/PGQ shape, copy it, or open it in SQL mode to tweak
 * the COLUMNS list by hand.
 *
 * Leaf-ish: owns only its expand/copy UI state; the SQL + bindings are pushed
 * down from the Workspace's meta-event capture.
 */
export function GeneratedSqlPanel({ sql, bindings, onOpenInSql }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard can be blocked; the <pre> is selectable as a fallback.
    }
  }

  return (
    <div className="rounded-md border border-border bg-bg">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center justify-between px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
        >
          <span>Generated SQL{bindings?.length ? ` · ${bindings.length} bindings` : ''}</span>
          <span>{expanded ? '▾' : '▸'}</span>
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border">
          <div className="flex items-center justify-end gap-1 px-2 py-1.5">
            <button
              type="button"
              onClick={() => onOpenInSql(sql)}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              Open in SQL mode
            </button>
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="max-h-48 overflow-auto border-t border-border bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-fg">
            {sql}
          </pre>
          {bindings && bindings.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
              {bindings.map((b) => (
                <span
                  key={b.alias}
                  title={`${b.kind === 'v' ? 'vertex' : 'edge'} · ${b.labels.join(', ') || 'no label'}${
                    b.properties.length ? ` · ${b.properties.join(', ')}` : ''
                  }`}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-fg-muted"
                >
                  <span className="font-medium text-fg">{b.alias}</span>
                  <span className="text-fg-subtle">{b.kind === 'v' ? '◯' : '→'}</span>
                  <span>{b.labels[0] ?? '?'}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
