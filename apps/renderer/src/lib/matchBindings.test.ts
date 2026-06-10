// Vitest suite for inferBindings. Run with `pnpm test`.
//
// We exercise the kind-aware, disjunction-rejecting, abbreviated-edge
// behaviour the previous regex couldn't handle. Each assertion maps to
// a row in todo.md items #4 / #5.

import { expect, test } from 'vitest';

import { inferBindings } from './matchBindings.ts';
import type { GraphMetadata } from './api.ts';

const meta: GraphMetadata = {
  graph: { oid: 1, schema: 'public', name: 'g', owner: 'u' },
  definition: '',
  vertices: [
    {
      oid: 100,
      alias: 'people',
      kind: 'v',
      table: { oid: 0, schema: '', name: '' },
      pk: ['id'],
      labels: ['person'],
      properties: [],
    },
    {
      oid: 101,
      alias: 'movies',
      kind: 'v',
      table: { oid: 0, schema: '', name: '' },
      pk: ['id'],
      labels: ['movie'],
      properties: [],
    },
  ],
  edges: [
    {
      oid: 200,
      alias: 'knows',
      kind: 'e',
      table: { oid: 0, schema: '', name: '' },
      pk: ['src', 'dst'],
      labels: ['knows'],
      properties: [],
    },
  ],
};

// Same fixture but with a label name that appears on both kinds —
// exactly the regression case verified against PG19's regression
// graph_table.sql:218.
const metaCrossKind: GraphMetadata = {
  graph: { oid: 2, schema: 'public', name: 'g2', owner: 'u' },
  definition: '',
  vertices: [
    {
      oid: 300,
      alias: 'v1',
      kind: 'v',
      table: { oid: 0, schema: '', name: '' },
      pk: ['id'],
      labels: ['l1'],
      properties: [],
    },
  ],
  edges: [
    {
      oid: 400,
      alias: 'e1',
      kind: 'e',
      table: { oid: 0, schema: '', name: '' },
      pk: ['src', 'dst'],
      labels: ['l1'],
      properties: [],
    },
  ],
};

test('binds vertex alias to vertex element, edge alias to edge element', () => {
  const r = inferBindings('(a IS person)-[k IS knows]->(b IS person)', meta);
  expect(r.error).toBeUndefined();
  expect(r.bindings.sort((x, y) => x.alias.localeCompare(y.alias))).toEqual([
    { alias: 'a', element_oid: 100 },
    { alias: 'b', element_oid: 100 },
    { alias: 'k', element_oid: 200 },
  ]);
});

test('kind-aware lookup: same label name on both kinds binds correctly', () => {
  const r = inferBindings('(a IS l1)-[k IS l1]->(b IS l1)', metaCrossKind);
  expect(r.error).toBeUndefined();
  const byAlias = new Map(r.bindings.map((b) => [b.alias, b.element_oid]));
  expect(byAlias.get('a'), 'vertex alias must bind to vertex 300').toBe(300);
  expect(byAlias.get('b'), 'vertex alias must bind to vertex 300').toBe(300);
  expect(byAlias.get('k'), 'edge alias must bind to edge 400').toBe(400);
});

test('label disjunctions are rejected with an actionable message', () => {
  const r = inferBindings('(a IS person|movie)-[k IS knows]->(b)', meta);
  expect(
    r.error?.includes('disjunctions'),
    `expected disjunction error, got: ${r.error}`,
  ).toBe(true);
});

test('unlabeled vertex alias binds when metadata is unambiguous', () => {
  const singleVertex: GraphMetadata = {
    ...meta,
    vertices: [meta.vertices[0]!],
  };
  const r = inferBindings('(a)-[k IS knows]->(b)', singleVertex);
  expect(r.error).toBeUndefined();
  expect(
    r.bindings.find((b) => b.alias === 'a')?.element_oid,
    'a should bind to the only vertex element',
  ).toBe(100);
});

test('unlabeled vertex alias errors when ambiguous', () => {
  const r = inferBindings('(a)-[k IS knows]->(b)', meta);
  expect(r.error?.includes('cannot infer'), `expected infer error, got: ${r.error}`).toBe(true);
});

test('abbreviated edge (->) without [] produces no edge binding', () => {
  // PG19 grammar: gram.y:18292 accepts `(...)->(...)`. We shouldn't
  // complain about a missing edge binding when the user uses this form.
  const r = inferBindings('(a IS person)->(b IS person)', meta);
  expect(r.error).toBeUndefined();
  const aliases = r.bindings.map((b) => b.alias).sort();
  expect(aliases).toEqual(['a', 'b']);
});

test('alias reused with conflicting kinds is rejected', () => {
  const r = inferBindings('(x IS person)-[x IS knows]->(y IS person)', meta);
  expect(
    r.error?.includes('vertex and an edge'),
    `expected kind-conflict error, got: ${r.error}`,
  ).toBe(true);
});

test('WHERE clause inside element pattern with nested parens is handled', () => {
  // The scanner must not desync on the inner `(a.name)`.
  const r = inferBindings(
    "(a IS person WHERE upper(a.name) = 'ALICE')-[k IS knows]->(b IS person)",
    meta,
  );
  expect(r.error).toBeUndefined();
  const aliases = r.bindings.map((b) => b.alias).sort();
  expect(aliases).toEqual(['a', 'b', 'k']);
});

test('quote-with-escaped-apostrophe inside WHERE does not break the scan', () => {
  const r = inferBindings(
    "(a IS person WHERE a.name = 'O''Brien')-[k IS knows]->(b IS person)",
    meta,
  );
  expect(r.error).toBeUndefined();
});

test('unknown label produces a specific error', () => {
  const r = inferBindings('(a IS nonexistent)', meta);
  expect(
    r.error?.includes('unknown vertex label'),
    `expected unknown-label error, got: ${r.error}`,
  ).toBe(true);
});

// ───────── non-fatal warnings (unprojected positions) ─────────

test('fully-aliased pattern produces no warnings', () => {
  const r = inferBindings('(a IS person)-[k IS knows]->(b IS person)', meta);
  expect(r.error).toBeUndefined();
  expect(r.warnings).toBeUndefined();
});

test('unaliased edge pattern warns that the edge will not be drawn', () => {
  const r = inferBindings('(a IS person)-[IS knows]->(b IS person)', meta);
  expect(r.error).toBeUndefined();
  expect(r.warnings?.some((w) => w.includes("edge") && w.includes("won't be drawn"))).toBe(true);
});

test('abbreviated edge (->) warns even though no edge chunk exists', () => {
  const r = inferBindings('(a IS person)->(b IS person)', meta);
  expect(r.error).toBeUndefined();
  expect(r.warnings?.some((w) => w.includes('abbreviated edge'))).toBe(true);
});

test('abbreviated undirected edge (-) warns too', () => {
  const r = inferBindings('(a IS person) - (b IS person)', meta);
  expect(r.error).toBeUndefined();
  expect(r.warnings?.some((w) => w.includes('abbreviated edge'))).toBe(true);
});

test('unaliased vertex pattern warns', () => {
  const r = inferBindings('(a IS person)-[k IS knows]->(IS person)', meta);
  expect(r.error).toBeUndefined();
  expect(r.warnings?.some((w) => w.includes('vertex pattern'))).toBe(true);
});

test('bracketed edge does not false-positive the abbreviated-edge check', () => {
  const r = inferBindings('(a IS person)-[k IS knows]->(b IS person)', meta);
  expect(r.warnings).toBeUndefined();
});

test('parens inside WHERE do not false-positive the abbreviated-edge check', () => {
  const r = inferBindings(
    "(a IS person WHERE (a.born - 1) > (1900 - 1))-[k IS knows]->(b IS person)",
    meta,
  );
  expect(r.error).toBeUndefined();
  expect(r.warnings).toBeUndefined();
});

test('alias-less IS form ([IS knows]) does not bind a variable named IS', () => {
  // `IS` is the keyword of the alias-less form, never an alias. The old
  // parser bound the edge element to a variable called "IS" and the server
  // projected `"IS"."src"`, which PG rejects.
  const r = inferBindings('(a IS person)-[IS knows]->(b IS person)', meta);
  expect(r.error).toBeUndefined();
  const aliases = r.bindings.map((b) => b.alias).sort();
  expect(aliases).toEqual(['a', 'b']);
});

test('alias-less IS form in a vertex ((IS person)) parses as label-only', () => {
  const r = inferBindings('(a IS person)-[k IS knows]->(IS person)', meta);
  expect(r.error).toBeUndefined();
  const aliases = r.bindings.map((b) => b.alias).sort();
  expect(aliases).toEqual(['a', 'k']);
});
