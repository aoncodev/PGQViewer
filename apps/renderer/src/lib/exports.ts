// Pure export helpers used by the result panels.
//
// Everything here is plain TS — no React, no DOM types beyond Blob/anchor for
// downloadBlob. This makes the formatters trivial to test in isolation and
// keeps the dependency surface zero (no `papaparse`, no `xmlbuilder`).
//
// Shapes:
//   - exportCSV / exportJSON consume the table-mode `{columns, rows}` payload
//     the Workspace stores in Zustand.
//   - exportGraphML / exportCypher consume the graph-mode vertex/edge maps
//     the Workspace builds from streaming vertex/edge events.
//
// Identity in graph exports follows the same `<elemOID>:<pk>` synthesis the
// server emits, so GraphML/Cypher outputs round-trip with the IDs the user
// sees in the Workspace.
//
// CSV escaping is RFC4180-ish: only quote fields containing `,`, `"`, or
// newline; double internal `"`. Strings outside that set are written raw.

import { formatValue } from './format';

export interface ExportColumn {
  name: string;
  type?: string;
}

export interface ExportVertex {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface ExportEdge {
  id: string;
  source: string;
  destination: string;
  labels: string[];
  properties: Record<string, unknown>;
}

// --- CSV / JSON ----------------------------------------------------------

/** exportCSV renders `{columns, rows}` as RFC4180-ish CSV. */
export function exportCSV(columns: ExportColumn[], rows: unknown[][]): string {
  const out: string[] = [];
  out.push(columns.map((c) => csvField(c.name)).join(','));
  for (const row of rows) {
    out.push(row.map((cell) => csvField(cellToString(cell))).join(','));
  }
  // Excel and most tools expect CRLF; we emit LF for git-friendliness and
  // because every modern tool accepts it.
  return out.join('\n') + '\n';
}

function csvField(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Export formats render nullish cells as an empty string.
function cellToString(v: unknown): string {
  return formatValue(v, { nullText: '', undefinedText: '' });
}

/** exportJSON renders the table payload as a pretty-printed object. */
export function exportJSON(columns: ExportColumn[], rows: unknown[][]): string {
  return JSON.stringify({ columns, rows }, null, 2);
}

// --- GraphML -------------------------------------------------------------

// Minimal GraphML following the standard at
//   http://graphml.graphdrawing.org/specification.html
// — one <node>/<edge> per element with a <data> child per property. Property
// keys are declared up front via <key>; type is always "string" because the
// streaming events erase the underlying PG type. The renderer/consumer is
// expected to coerce if needed.

/** exportGraphML serialises vertices + edges as GraphML XML. */
export function exportGraphML(vertices: ExportVertex[], edges: ExportEdge[]): string {
  // Collect distinct property keys across both vertices and edges so we can
  // emit <key> declarations once.
  const nodeKeys = new Set<string>();
  const edgeKeys = new Set<string>();
  for (const v of vertices) for (const k of Object.keys(v.properties)) nodeKeys.add(k);
  for (const e of edges) for (const k of Object.keys(e.properties)) edgeKeys.add(k);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">',
  );
  // Reserve `labels` as a dedicated key so consumers can recover the label
  // list without it colliding with a user-defined property.
  lines.push(
    `  <key id="labels" for="node" attr.name="labels" attr.type="string"/>`,
  );
  lines.push(
    `  <key id="labels" for="edge" attr.name="labels" attr.type="string"/>`,
  );
  // Property keys. We prefix node keys with `n_` and edge keys with `e_` so
  // overlapping property names (e.g. both a vertex `name` and an edge `name`)
  // don't collide in the GraphML <key> id space.
  for (const k of nodeKeys) {
    lines.push(
      `  <key id="${attr('n_' + k)}" for="node" attr.name="${attr(k)}" attr.type="string"/>`,
    );
  }
  for (const k of edgeKeys) {
    lines.push(
      `  <key id="${attr('e_' + k)}" for="edge" attr.name="${attr(k)}" attr.type="string"/>`,
    );
  }
  lines.push('  <graph id="G" edgedefault="directed">');
  for (const v of vertices) {
    lines.push(`    <node id="${attr(v.id)}">`);
    if (v.labels.length > 0) {
      lines.push(`      <data key="labels">${escapeText(v.labels.join(','))}</data>`);
    }
    for (const [k, val] of Object.entries(v.properties)) {
      lines.push(
        `      <data key="${attr('n_' + k)}">${escapeText(cellToString(val))}</data>`,
      );
    }
    lines.push('    </node>');
  }
  for (const e of edges) {
    lines.push(
      `    <edge id="${attr(e.id)}" source="${attr(e.source)}" target="${attr(e.destination)}">`,
    );
    if (e.labels.length > 0) {
      lines.push(`      <data key="labels">${escapeText(e.labels.join(','))}</data>`);
    }
    for (const [k, val] of Object.entries(e.properties)) {
      lines.push(
        `      <data key="${attr('e_' + k)}">${escapeText(cellToString(val))}</data>`,
      );
    }
    lines.push('    </edge>');
  }
  lines.push('  </graph>');
  lines.push('</graphml>');
  return lines.join('\n') + '\n';
}

// --- Cypher --------------------------------------------------------------

// Cypher export emits MERGE statements idempotently so re-running the same
// output against an empty (or partially populated) Neo4j-compatible store
// yields the same graph. Label sanitisation: anything that isn't a valid
// Cypher identifier becomes a backtick-quoted label so we don't generate
// invalid syntax for labels with spaces or hyphens.

/** exportCypher serialises vertices + edges as MERGE statements. */
export function exportCypher(vertices: ExportVertex[], edges: ExportEdge[]): string {
  const out: string[] = [];
  for (const v of vertices) {
    const label = cypherLabel(v.labels[0] ?? 'Vertex');
    out.push(
      `MERGE (n:${label} {id: ${cypherStr(v.id)}}) SET n += ${cypherMap(v.properties)};`,
    );
  }
  for (const e of edges) {
    const label = cypherLabel(e.labels[0] ?? 'EDGE').toUpperCase();
    out.push(
      `MATCH (a {id: ${cypherStr(e.source)}}), (b {id: ${cypherStr(e.destination)}}) ` +
        `MERGE (a)-[r:${label}]->(b) SET r += ${cypherMap(e.properties)};`,
    );
  }
  return out.join('\n') + (out.length > 0 ? '\n' : '');
}

function cypherLabel(s: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  // Backtick-quote and escape internal backticks.
  return '`' + s.replace(/`/g, '``') + '`';
}

function cypherMap(props: Record<string, unknown>): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return '{}';
  const parts = entries.map(([k, v]) => `${cypherKey(k)}: ${cypherValue(v)}`);
  return '{' + parts.join(', ') + '}';
}

function cypherKey(k: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return k;
  return '`' + k.replace(/`/g, '``') + '`';
}

function cypherValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return cypherStr(JSON.stringify(v));
  return cypherStr(String(v));
}

function cypherStr(s: string): string {
  // Cypher single-quoted strings: escape `\`, `'`, and newlines.
  return (
    "'" +
    s
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r') +
    "'"
  );
}

// --- XML escape helpers --------------------------------------------------

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- download ------------------------------------------------------------

/**
 * downloadBlob creates a Blob with the given content and triggers a browser
 * download via a temporary anchor element. Safe to call from any event
 * handler.
 */
export function downloadBlob(filename: string, mime: string, content: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Some browsers require the anchor to be in the DOM before clicking.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the object URL on the next tick — too eagerly and the click
  // may not have completed in Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
