// Discovers the (label, property) pairs present in a graph.
//
// Both the filter modal and the edge-weight modal need a dropdown of the
// properties available on the current graph. They merge two sources so the
// list isn't empty before the schema loads: declared properties from the
// graph metadata, plus whatever is actually rendered on the canvas. The
// modals differ only in which element kinds they scan and whether they
// filter (e.g. to numeric properties) — both are options here.

import { useApp } from './store';

export interface LabelProperty {
  label: string;
  property: string;
}

type AppState = ReturnType<typeof useApp.getState>;

export interface GraphSource {
  metadata: AppState['metadata'];
  /** Live canvas vertices. Omit when only edges are of interest. */
  vertices?: AppState['vertices'];
  /** Live canvas edges. Omit when only vertices are of interest. */
  edges?: AppState['edges'];
}

export interface DiscoverOptions {
  /** Which graph element kinds to scan. Default: both vertices and edges. */
  kinds?: ('v' | 'e')[];
  /**
   * Optional filter on each property. Receives the name plus whichever
   * signal the source carries — `type` from schema metadata, `value` from a
   * rendered element. Return false to drop the (label, property) pair.
   */
  keep?: (prop: { name: string; type?: string; value?: unknown }) => boolean;
}

/**
 * Returns the deduplicated (label, property) pairs of a graph, sorted by
 * label then property. Metadata-declared properties and live canvas
 * elements are both scanned; the first occurrence of a pair wins.
 */
export function discoverLabelProperties(
  src: GraphSource,
  opts: DiscoverOptions = {},
): LabelProperty[] {
  const kinds = opts.kinds ?? ['v', 'e'];
  const keep = opts.keep ?? (() => true);
  const out = new Map<string, LabelProperty>(); // key = label|property
  const add = (label: string, property: string) => {
    const k = `${label}|${property}`;
    if (!out.has(k)) out.set(k, { label, property });
  };

  if (src.metadata) {
    const els = [
      ...(kinds.includes('v') ? src.metadata.vertices : []),
      ...(kinds.includes('e') ? src.metadata.edges : []),
    ];
    for (const el of els) {
      for (const p of el.properties) {
        if (!keep({ name: p.name, type: p.type })) continue;
        // Pair the property only with the labels it is actually declared on —
        // SQL/PGQ scopes properties per label, so an element's labels do not all
        // share its property set. Fall back to the element's labels for older
        // server metadata that doesn't carry per-property labels.
        const labels = p.labels && p.labels.length > 0 ? p.labels : el.labels;
        for (const lab of labels) add(lab, p.name);
      }
    }
  }

  if (kinds.includes('v') && src.vertices) {
    for (const v of src.vertices.values()) {
      for (const lab of v.labels) {
        for (const [name, value] of Object.entries(v.properties)) {
          if (keep({ name, value })) add(lab, name);
        }
      }
    }
  }
  if (kinds.includes('e') && src.edges) {
    for (const e of src.edges.values()) {
      for (const lab of e.labels) {
        for (const [name, value] of Object.entries(e.properties)) {
          if (keep({ name, value })) add(lab, name);
        }
      }
    }
  }

  return Array.from(out.values()).sort((a, b) =>
    a.label === b.label
      ? a.property.localeCompare(b.property)
      : a.label.localeCompare(b.label),
  );
}
