import { describe, expect, it } from 'vitest';
import { matchHint, VERIFIED_AGAINST } from './errors';

// Characterization tests for the PG19 error → hint mapping.
//
// Every message below was captured VERBATIM from a live PostgreSQL 19
// Beta 1 server (postgres:19beta1, released 2026-06-04) by running the
// triggering statement against the demo `social` graph. If a future
// beta/RC renames a string, the corresponding test here fails before a
// user ever sees a hint-less error.

describe('matchHint — verbatim 19beta1 rewriter/parser strings', () => {
  it('quantifier ({m,n} form, rewriter message)', () => {
    const h = matchHint('element pattern quantifier is not supported');
    expect(h?.title).toBe('Path quantifiers are not in PG19');
  });

  it('multiple path patterns', () => {
    const h = matchHint(
      'multiple path patterns in one GRAPH_TABLE clause not supported',
    );
    expect(h?.title).toBe('One path per GRAPH_TABLE');
  });

  it('non-local element variable reference (cross-element ref in element WHERE)', () => {
    const h = matchHint('non-local element variable reference is not supported');
    expect(h?.title).toBe('Cross-element refs only in top-level WHERE');
  });

  it('unsupported element pattern kind (nested path pattern)', () => {
    const h = matchHint(
      'unsupported element pattern kind: "nested path pattern"',
    );
    expect(h?.title).toBe('Unsupported element pattern');
  });

  it('subquery inside GRAPH_TABLE', () => {
    const h = matchHint(
      'subqueries within GRAPH_TABLE reference are not supported',
    );
    expect(h?.title).toBe('No subqueries inside GRAPH_TABLE');
  });

  it('qualified star in COLUMNS (a.*)', () => {
    const h = matchHint('"*" is not supported here');
    expect(h?.title).toBe('COLUMNS does not accept *');
  });

  it('property exists in graph but not on the bound element', () => {
    const h = matchHint('property "since" for element variable "a" not found');
    expect(h?.title).toBe('Property not declared on element');
  });

  it('property does not exist anywhere', () => {
    const h = matchHint('property "nope" does not exist');
    expect(h?.title).toBe('Property not declared');
  });

  it('unknown label', () => {
    const h = matchHint(
      'label "nolabel" does not exist in property graph "social"',
    );
    expect(h?.title).toBe('Label not in this graph');
  });

  it('path starts with an edge', () => {
    const h = matchHint('path pattern cannot start with an edge pattern');
    expect(h?.title).toBe('Path must start with a vertex');
  });

  it('path ends with an edge', () => {
    const h = matchHint('path pattern cannot end with an edge pattern');
    expect(h?.title).toBe('Path must end with a vertex');
  });

  it('adjacent vertex patterns', () => {
    const h = matchHint('adjacent vertex patterns are not supported');
    expect(h?.title).toBe('Vertices need an edge between them');
  });

  it('variable reused as vertex and edge', () => {
    const h = matchHint(
      'element patterns with same variable name "x" but different element pattern types',
    );
    expect(h?.title).toBe('Variable used as both vertex and edge');
  });

  it('edge connecting more than two vertices', () => {
    const h = matchHint(
      'an edge cannot connect more than two vertices even in a cyclic pattern',
    );
    expect(h?.title).toBe('Edge connects exactly two vertices');
  });

  it('no equality operator for endpoint key comparison', () => {
    const h = matchHint(
      'no equality operator exists for SOURCE key comparison of edge "eqop_e"',
    );
    expect(h?.title).toBe('Endpoint key types are incompatible');
  });

  it('label on the wrong element kind', () => {
    const h = matchHint(
      'no property graph element of type "edge" has label "person" associated with it in property graph "social"',
    );
    expect(h?.title).toBe('Label exists on the wrong element kind');
  });

  it('UNLOGGED property graph', () => {
    const h = matchHint(
      'property graphs cannot be unlogged because they do not have storage',
    );
    expect(h?.title).toBe('UNLOGGED is not allowed');
  });

  it('invalid privilege type', () => {
    const h = matchHint('invalid privilege type INSERT for property graph');
    expect(h?.title).toBe('Only SELECT applies to property graphs');
  });

  it('temp element table added to a persistent graph (ALTER path)', () => {
    const h = matchHint(
      'cannot add temporary element table to non-temporary property graph',
    );
    expect(h?.title).toBe('Temp table on a persistent graph');
  });

  // 19beta1 dropped the CREATE-time "mixing temporary and persistent"
  // error — a mixed CREATE now succeeds with a NOTICE and the graph
  // becomes temporary. The old pattern must NOT resurface a stale hint.
  it('pre-beta "mixing temporary and persistent" wording no longer maps', () => {
    expect(matchHint('mixing temporary and persistent tables')).toBeNull();
  });
});

describe('matchHint — parser-level syntax-error fallbacks', () => {
  it('bare COLUMNS (*) maps via the query-shape heuristic', () => {
    const h = matchHint(
      'syntax error at or near "*"',
      'SELECT * FROM GRAPH_TABLE (social MATCH (a IS person) COLUMNS (*))',
    );
    expect(h?.title).toBe('COLUMNS does not accept *');
  });

  it('COLUMNS ( * ) with whitespace still maps', () => {
    const h = matchHint(
      'syntax error at or near "*"',
      'SELECT * FROM GRAPH_TABLE (g MATCH (a) COLUMNS (  *  ))',
    );
    expect(h?.title).toBe('COLUMNS does not accept *');
  });

  it('quantifier shapes still map to the quantifier hint', () => {
    const h = matchHint(
      'syntax error at or near "*"',
      'SELECT * FROM GRAPH_TABLE (g MATCH (a)-[k*1..3]->(b) COLUMNS (a.id AS i))',
    );
    expect(h?.title).toBe('Path quantifiers are not in PG19');
  });

  it('a star elsewhere in the query does not trigger the COLUMNS hint', () => {
    expect(
      matchHint('syntax error at or near "*"', 'SELECT 2 * * FROM t'),
    ).toBeNull();
    expect(
      matchHint(
        'syntax error at or near "*"',
        'SELECT * FROM GRAPH_TABLE (g MATCH (a) COLUMNS (a.x AS x))',
      ),
    ).toBeNull();
  });

  it('no query text means no fallback', () => {
    expect(matchHint('syntax error at or near "*"')).toBeNull();
  });
});

describe('matchHint — viewer-synthesized errors (projection.go / introspect.go)', () => {
  // Mirrors projection.go validateBinding. A KEY column simply not being exposed
  // as a property NO LONGER errors (the projection degrades to a property-derived
  // identity); the residual hard error fires only when there's nothing at all to
  // identify a vertex by.
  it('vertex with no identifiable column', () => {
    const h = matchHint(
      'binding "a" (people): the KEY columns [id] are not exposed as properties and the element declares no other property, so the viewer has nothing to identify this vertex by — list at least one column in PROPERTIES (...) (or drop the clause to expose all columns)',
    );
    expect(h?.title).toBe('Vertex has no identifiable column');
  });

  // Mirrors introspect.go refMismatchDiagnostic format string verbatim.
  it('edge REFERENCES columns do not match vertex KEY columns', () => {
    const h = matchHint(
      'edge "knows"\'s SOURCE REFERENCES columns (src) do not match vertex "person"\'s KEY columns (id); the viewer cannot synthesize matching endpoint ids. Recreate the graph with REFERENCES person (id) or change vertex "person"\'s KEY clause.',
    );
    expect(h?.title).toBe('Edge endpoints do not match vertex key');
  });

  // Mirrors matchBindings.ts inferBindings disjunction rejection so the UI
  // can offer a remediation action instead of printing the raw string.
  it('label disjunction rejection from auto-projection', () => {
    const h = matchHint(
      'label disjunctions (`IS a|b`) are not yet supported in graph mode — switch to SQL mode for this query, or pick a single label',
    );
    expect(h?.title).toBe('Label disjunction not supported in graph mode');
  });
});

describe('matchHint — remediation actions', () => {
  it('quantifier hint offers a recursive-CTE switch-to-sql action', () => {
    const h = matchHint('element pattern quantifier is not supported');
    expect(h?.action?.kind).toBe('switch-to-sql');
    expect(h?.action?.label).toBe('Rewrite as recursive CTE in SQL mode');
  });

  it('multiple-path-patterns hint offers a switch-to-sql action', () => {
    const h = matchHint(
      'multiple path patterns in one GRAPH_TABLE clause not supported',
    );
    expect(h?.action?.kind).toBe('switch-to-sql');
  });

  it('non-local element variable hint offers a switch-to-sql action', () => {
    const h = matchHint('non-local element variable reference is not supported');
    expect(h?.action?.kind).toBe('switch-to-sql');
  });

  it('label-disjunction hint offers a wrap-graph-table action', () => {
    const h = matchHint(
      'label disjunctions (`IS a|b`) are not yet supported in graph mode — switch to SQL mode for this query, or pick a single label',
    );
    expect(h?.action?.kind).toBe('wrap-graph-table');
  });
});

describe('errors module markers', () => {
  it('is pinned to the verified PG release', () => {
    expect(VERIFIED_AGAINST).toBe('19beta1');
  });
});
