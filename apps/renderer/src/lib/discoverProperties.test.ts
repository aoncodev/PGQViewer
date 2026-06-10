// Characterization tests for discoverLabelProperties — the shared
// label/property discovery behind the filter and edge-weight modals.

import { describe, expect, it } from 'vitest';

import { discoverLabelProperties } from './discoverProperties.ts';
import type { Element, GraphMetadata, Property } from './api.ts';
import type { EdgeLink, VertexNode } from './store.ts';

function el(kind: 'v' | 'e', labels: string[], props: string[]): Element {
  return {
    oid: 0,
    alias: 'x',
    kind,
    table: { oid: 0, schema: '', name: '' },
    pk: [],
    labels,
    properties: props.map((name): Property => ({ name, type: 'text' })),
  };
}

function metadataOf(vertices: Element[], edges: Element[]): GraphMetadata {
  return {
    graph: { oid: 1, schema: 'public', name: 'g', owner: 'u' },
    definition: '',
    vertices,
    edges,
  };
}

describe('discoverLabelProperties', () => {
  it('returns metadata pairs from both kinds, sorted by label then property', () => {
    const metadata = metadataOf(
      [el('v', ['Person'], ['name', 'age'])],
      [el('e', ['Knows'], ['since'])],
    );
    expect(discoverLabelProperties({ metadata })).toEqual([
      { label: 'Knows', property: 'since' },
      { label: 'Person', property: 'age' },
      { label: 'Person', property: 'name' },
    ]);
  });

  it('scans only edges when kinds is restricted', () => {
    const metadata = metadataOf(
      [el('v', ['Person'], ['name'])],
      [el('e', ['Knows'], ['since'])],
    );
    expect(discoverLabelProperties({ metadata }, { kinds: ['e'] })).toEqual([
      { label: 'Knows', property: 'since' },
    ]);
  });

  it('applies the keep predicate to metadata properties', () => {
    const metadata = metadataOf(
      [
        {
          ...el('v', ['Person'], []),
          properties: [
            { name: 'name', type: 'text' },
            { name: 'age', type: 'integer' },
          ],
        },
      ],
      [],
    );
    const numeric = discoverLabelProperties(
      { metadata },
      { keep: (p) => p.type === 'integer' },
    );
    expect(numeric).toEqual([{ label: 'Person', property: 'age' }]);
  });

  it('merges live canvas elements and deduplicates pairs', () => {
    const metadata = metadataOf([el('v', ['Person'], ['name'])], []);
    const vertices = new Map<string, VertexNode>([
      [
        'v1',
        { id: 'v1', labels: ['Person'], properties: { name: 'Alice', city: 'NYC' } } as VertexNode,
      ],
    ]);
    expect(discoverLabelProperties({ metadata, vertices })).toEqual([
      { label: 'Person', property: 'city' },
      { label: 'Person', property: 'name' },
    ]);
  });

  it('discovers from live elements when metadata is null', () => {
    const edges = new Map<string, EdgeLink>([
      [
        'e1',
        {
          id: 'e1',
          source: 'a',
          destination: 'b',
          labels: ['Rated'],
          properties: { stars: 5 },
        } as EdgeLink,
      ],
    ]);
    expect(discoverLabelProperties({ metadata: null, edges })).toEqual([
      { label: 'Rated', property: 'stars' },
    ]);
  });
});
