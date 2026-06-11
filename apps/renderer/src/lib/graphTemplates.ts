// Generates ready-to-run MATCH-pattern templates from graph metadata so users
// can drop in a 2-hop / triangle / neighbours-of pattern without memorising
// the SQL/PGQ element syntax. Pure: takes metadata, returns labelled snippets.

import type { GraphMetadata } from './api';

export interface MatchTemplate {
  id: string;
  label: string;
  /** The MATCH pattern to insert into the graph-mode editor. */
  pattern: string;
}

// Pick the first label of an element, falling back to its alias so the
// generated pattern is always runnable even on unlabelled elements.
function elemLabel(e: { labels: string[]; alias: string }): string {
  return e.labels[0] ?? e.alias;
}

/**
 * Builds a small gallery of MATCH templates tailored to the current graph.
 * Returns an empty list when metadata is missing or too sparse to build a
 * meaningful pattern (no vertices, or no edges for the multi-hop variants).
 */
export function buildTemplates(metadata: GraphMetadata | null): MatchTemplate[] {
  if (!metadata) return [];
  const v0 = metadata.vertices[0];
  const e0 = metadata.edges[0];
  if (!v0) return [];

  const vLabel = elemLabel(v0);
  const out: MatchTemplate[] = [];

  // Single hop — always available when there's a vertex + edge.
  if (e0) {
    const v1 = metadata.vertices[1] ?? v0;
    const eLabel = elemLabel(e0);
    const v1Label = elemLabel(v1);

    out.push({
      id: 'one-hop',
      label: '1-hop',
      pattern: `(a IS ${vLabel})-[e IS ${eLabel}]->(b IS ${v1Label})`,
    });

    // 2-hop chain a->b->c. Reuse v0/v1 labels; PG19 supports multi-hop
    // fixed-length single paths.
    out.push({
      id: 'two-hop',
      label: '2-hop',
      pattern: `(a IS ${vLabel})-[e1 IS ${eLabel}]->(b IS ${v1Label})-[e2 IS ${eLabel}]->(c IS ${v1Label})`,
    });

    // Triangle a->b->c with a closing hop back to a. Only meaningful when the
    // edge can connect the same vertex label on both ends; we still offer it
    // and let the server validate.
    out.push({
      id: 'triangle',
      label: 'triangle',
      pattern: `(a IS ${vLabel})-[e1 IS ${eLabel}]->(b IS ${vLabel})-[e2 IS ${eLabel}]->(c IS ${vLabel})`,
    });

    // Neighbours-of: a single anchor and its outgoing neighbours. Useful as a
    // starting point with a WHERE on the anchor.
    out.push({
      id: 'neighbours',
      label: 'neighbours-of',
      pattern: `(a IS ${vLabel})-[e IS ${eLabel}]->(n IS ${v1Label})`,
    });
  } else {
    // Edgeless graph — only a single-vertex scan makes sense.
    out.push({
      id: 'vertices',
      label: 'all vertices',
      pattern: `(a IS ${vLabel})`,
    });
  }

  return out;
}
