import { useMemo, useState } from 'react';
import { useApp } from '../lib/store';
import {
  downloadBlob,
  exportCSV,
  exportCypher,
  exportGraphML,
} from '../lib/exports';

// JsonView renders the current result set as pretty-printed JSON. For graph
// mode we emit a single object with `vertices` and `edges` arrays so the
// shape mirrors what a downstream consumer would receive. For SQL mode we
// emit a 2D rows array under `rows` with `columns` describing types.
//
// In addition to Copy, the toolbar exposes export buttons:
//   - SQL mode (columns present): CSV, JSON.
//   - Graph mode (vertices/edges present): GraphML, Cypher, JSON.

export function JsonView() {
  const vertices = useApp((s) => s.vertices);
  const edges = useApp((s) => s.edges);
  const columns = useApp((s) => s.resultColumns);
  const rows = useApp((s) => s.resultRows);
  const [copied, setCopied] = useState(false);

  // SQL mode is identified by the presence of declared result columns; graph
  // mode by the presence of vertex/edge events. Both can be empty if no
  // query has run yet.
  const sqlMode = columns.length > 0;
  const hasGraph = vertices.size > 0 || edges.size > 0;

  const text = useMemo(() => {
    const body = sqlMode
      ? { columns, rows }
      : {
          vertices: Array.from(vertices.values()),
          edges: Array.from(edges.values()),
        };
    return JSON.stringify(body, null, 2);
  }, [vertices, edges, columns, rows, sqlMode]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard can be blocked; user can select+copy manually.
    }
  }

  function onExportJSON() {
    downloadBlob('result.json', 'application/json', text);
  }

  function onExportCSV() {
    const out = exportCSV(columns, rows);
    downloadBlob('result.csv', 'text/csv;charset=utf-8', out);
  }

  function onExportGraphML() {
    const out = exportGraphML(Array.from(vertices.values()), Array.from(edges.values()));
    downloadBlob('result.graphml', 'application/xml', out);
  }

  function onExportCypher() {
    const out = exportCypher(Array.from(vertices.values()), Array.from(edges.values()));
    downloadBlob('result.cypher', 'text/plain;charset=utf-8', out);
  }

  if (!sqlMode && !hasGraph) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
        Run a query to see JSON here.
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1">
        {sqlMode && (
          <>
            <ToolbarButton onClick={onExportCSV}>Export CSV</ToolbarButton>
            <ToolbarButton onClick={onExportJSON}>Export JSON</ToolbarButton>
          </>
        )}
        {hasGraph && !sqlMode && (
          <>
            <ToolbarButton onClick={onExportGraphML}>Export GraphML</ToolbarButton>
            <ToolbarButton onClick={onExportCypher}>Export Cypher</ToolbarButton>
            <ToolbarButton onClick={onExportJSON}>Export JSON</ToolbarButton>
          </>
        )}
        <ToolbarButton onClick={copy}>{copied ? 'Copied' : 'Copy'}</ToolbarButton>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-fg">
        {text}
      </pre>
    </div>
  );
}

function ToolbarButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </button>
  );
}
