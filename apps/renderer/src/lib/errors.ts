// Maps known PostgreSQL SQL/PGQ (PG19) error strings to actionable UI hints.
//
// PG19 emits ~25 distinct error strings across parser, rewriter, and DDL
// paths. The raw text is technically accurate but rarely tells the user
// what to do next. matchHint() pattern-matches the message (case-insensitive
// substring) and returns a small {title, hint} payload the UI can render.
//
// The patterns are pinned to the official PostgreSQL 19 Beta 1 release
// (2026-06-04); every needle below was verified verbatim against a live
// 19beta1 server in 2026-06 (see errors.test.ts for the captured strings).
// Substrings are chosen to survive interpolation (e.g. "property X does
// not exist" -> we match the fixed bit "does not exist").

// A UI action a hint can offer. The renderer (HintPopover) renders a button
// when `action` is set and calls back into the workspace, which knows how to
// switch modes / seed the SQL editor. Kept declarative (kind + label +
// optional payload) so the leaf component stays state-free.
export type ErrorHintAction = {
  kind: 'switch-to-sql' | 'wrap-graph-table';
  label: string;
  payload?: string;
};

export interface ErrorHint {
  title: string;
  hint: string;
  docsHref?: string;
  /** Optional one-click remediation the UI can offer alongside the prose. */
  action?: ErrorHintAction;
}

interface Pattern {
  // All needles must appear (case-insensitive) for the rule to match.
  needles: string[];
  hint: ErrorHint;
}

// The PG release the verbatim needles below were captured against. A test
// asserts on this so a careless docs/version bump can't silently desync the
// characterization fixtures from the wording they were pinned to.
export const VERIFIED_AGAINST = '19beta1';

// Single source of truth for the docs version path segment. PG renames the
// `/devel/` path to `/19/` once 19 ships GA; centralizing it here means one
// edit flips every hint's docs link.
const DOCS_BASE = 'https://www.postgresql.org/docs/devel';
const DOCS_QUERIES = `${DOCS_BASE}/queries-graph.html`;
const DOCS_DDL = `${DOCS_BASE}/ddl-property-graphs.html`;
const DOCS_CREATE = `${DOCS_BASE}/sql-create-property-graph.html`;
const DOCS_ALTER = `${DOCS_BASE}/sql-alter-property-graph.html`;

// Reused remediation actions. `switch-to-sql` flips the editor to SQL mode
// (Workspace seeds sqlText); `wrap-graph-table` does the same but signals the
// intent was specifically "wrap this MATCH in a hand-written GRAPH_TABLE".
const ACTION_RECURSIVE_CTE: ErrorHintAction = {
  kind: 'switch-to-sql',
  label: 'Rewrite as recursive CTE in SQL mode',
};
const ACTION_SPLIT_IN_SQL: ErrorHintAction = {
  kind: 'switch-to-sql',
  label: 'Split paths in SQL mode',
};
const ACTION_WRAP_GRAPH_TABLE: ErrorHintAction = {
  kind: 'wrap-graph-table',
  label: 'Open as GRAPH_TABLE in SQL mode',
};
const ACTION_MOVE_TO_WHERE: ErrorHintAction = {
  kind: 'switch-to-sql',
  label: 'Edit the full query in SQL mode',
};

// The COLUMNS-star hint is shared by two triggers: the rewriter's friendly
// `"*" is not supported here` (fires for a qualified `a.*`) and the
// matchHint fallback for a bare `COLUMNS (*)`, which 19beta1 rejects in the
// parser with a generic `syntax error at or near "*"` before the rewriter
// ever sees it.
const COLUMNS_STAR_HINT: ErrorHint = {
  title: 'COLUMNS does not accept *',
  hint: 'PG19 requires explicit property references inside the COLUMNS clause. PGQViewer can auto-project every declared property — leave the COLUMNS clause empty and let graph mode build it for you.',
  docsHref: DOCS_QUERIES,
};

// Order matters: more specific patterns first.
const PATTERNS: Pattern[] = [
  {
    needles: ['element pattern quantifier is not supported'],
    hint: {
      title: 'Path quantifiers are not in PG19',
      hint: 'PG19 does not support {m,n}, * or + quantifiers on element patterns. Switch to SQL mode and write a recursive CTE over the underlying tables (a WITH RECURSIVE walk of the edge table), or expand the pattern to a fixed number of hops.',
      docsHref: DOCS_QUERIES,
      action: ACTION_RECURSIVE_CTE,
    },
  },
  {
    needles: ['multiple path patterns', 'graph_table'],
    hint: {
      title: 'One path per GRAPH_TABLE',
      hint: 'PG19 rejects multiple comma-separated paths inside a single GRAPH_TABLE. Split each path into its own GRAPH_TABLE call and join them in SQL.',
      docsHref: DOCS_QUERIES,
      action: ACTION_SPLIT_IN_SQL,
    },
  },
  {
    // 19beta1 wording for a qualified star (`COLUMNS (a.*)`). A bare
    // `COLUMNS (*)` dies earlier, in the parser, with a generic syntax
    // error — that case is caught by the looksLikeColumnsStar fallback.
    needles: ['"*"', 'not supported here'],
    hint: COLUMNS_STAR_HINT,
  },
  {
    needles: ['for element variable', 'not found'],
    hint: {
      title: 'Property not declared on element',
      hint: 'The referenced property is not declared on this element variable\'s label. Add it with ALTER PROPERTY GRAPH ... ALTER LABEL ... ADD PROPERTIES (...), or pick from the declared property list in the sidebar.',
      docsHref: DOCS_ALTER,
    },
  },
  {
    // Must precede the generic property rule below: the label message
    // (`label "x" does not exist in property graph "y"`) contains both
    // "property" and "does not exist" and would otherwise be shadowed.
    needles: ['label', 'does not exist in property graph'],
    hint: {
      title: 'Label not in this graph',
      hint: 'This label is not declared on any element of the current property graph. Check the sidebar for the available label list, or add it with ALTER PROPERTY GRAPH ... ALTER VERTEX|EDGE TABLE ... ADD LABEL.',
      docsHref: DOCS_ALTER,
    },
  },
  {
    needles: ['property', 'does not exist'],
    hint: {
      title: 'Property not declared',
      hint: 'This property is not declared on the bound element. Declare it via ALTER PROPERTY GRAPH ... ALTER LABEL ... ADD PROPERTIES (...), or reference a different property from the sidebar.',
      docsHref: DOCS_ALTER,
    },
  },
  {
    needles: ['non-local element variable reference is not supported'],
    hint: {
      title: 'Cross-element refs only in top-level WHERE',
      hint: 'PG19 forbids referencing another element\'s variable inside an element\'s own WHERE (an element WHERE may only mention its own variable). Move the predicate to a top-level WHERE after the pattern, where cross-element predicates like `a.x OR b.y` are allowed — or edit the full query in SQL mode.',
      docsHref: DOCS_QUERIES,
      action: ACTION_MOVE_TO_WHERE,
    },
  },
  {
    needles: ['path pattern cannot start with an edge pattern'],
    hint: {
      title: 'Path must start with a vertex',
      hint: 'A MATCH path must begin with a vertex pattern in parentheses, not an edge in brackets. Prepend a vertex pattern such as (n) or (n IS LABEL) before the edge.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['path pattern cannot end with an edge pattern'],
    hint: {
      title: 'Path must end with a vertex',
      hint: 'A MATCH path must end with a vertex pattern. Append a vertex pattern such as (m) or (m IS LABEL) after the trailing edge.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['adjacent vertex patterns are not supported'],
    hint: {
      title: 'Vertices need an edge between them',
      hint: 'Two vertex patterns cannot sit next to each other in a path. Connect them with an edge pattern in brackets, e.g. (a)-[r]->(b).',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['edge pattern must be preceded by a vertex pattern'],
    hint: {
      title: 'Edge needs a leading vertex',
      hint: 'Every edge pattern must be preceded by a vertex pattern. Add (source) before the edge, for example (source)-[edge]->(target).',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    // 19beta1 rejects nested element patterns — `((a)->(b))` — with the
    // verbatim `unsupported element pattern kind: "nested path pattern"`.
    needles: ['unsupported element pattern kind'],
    hint: {
      title: 'Unsupported element pattern',
      hint: 'PG19 only supports vertex patterns in parentheses and edge patterns in brackets — nested ((a)->(b)) sub-patterns are not allowed. Flatten the pattern to a single path, or edit it in SQL mode.',
      docsHref: DOCS_QUERIES,
      action: ACTION_MOVE_TO_WHERE,
    },
  },
  {
    // `subqueries within GRAPH_TABLE reference are not supported` — a
    // SELECT inside a COLUMNS expr or element WHERE. Hand-write the query
    // in SQL mode where subqueries are legal.
    needles: ['subqueries within graph_table reference are not supported'],
    hint: {
      title: 'No subqueries inside GRAPH_TABLE',
      hint: 'PG19 does not allow subqueries inside a GRAPH_TABLE reference (neither in COLUMNS nor in an element WHERE). Move the subquery outside the GRAPH_TABLE — wrap the GRAPH_TABLE in an outer SELECT — by editing the query in SQL mode.',
      docsHref: DOCS_QUERIES,
      action: ACTION_WRAP_GRAPH_TABLE,
    },
  },
  {
    needles: ['element patterns with same variable name', 'different element pattern types'],
    hint: {
      title: 'Variable used as both vertex and edge',
      hint: 'A variable cannot be bound to both a vertex and an edge in the same path. Rename one occurrence so vertices and edges have distinct aliases.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['element patterns with same variable name', 'different label expressions are not supported'],
    hint: {
      title: 'Variable rebound to different labels',
      hint: 'Reusing the same variable name with conflicting label expressions is not supported. Either drop the second IS clause or rename the variable so each occurrence has consistent labels.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['edge cannot connect more than two vertices'],
    hint: {
      title: 'Edge connects exactly two vertices',
      hint: 'PG19 edges are strictly binary, even in cyclic patterns. Split the pattern so each edge sits between exactly two vertex patterns.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['no equality operator exists for source key comparison'],
    hint: {
      title: 'Endpoint key types are incompatible',
      hint: 'The edge\'s source key column type has no equality operator against the referenced vertex PK type. Recreate the edge table\'s SOURCE/DESTINATION keys with types that match the target vertex PK, or add a comparison cast.',
      docsHref: DOCS_CREATE,
    },
  },
  {
    needles: ['no property graph element of type', 'has label'],
    hint: {
      title: 'Label exists on the wrong element kind',
      hint: 'The referenced label is declared on the other element kind in this graph (vertex vs edge). Use a vertex pattern (parentheses) or an edge pattern (brackets) to match the kind the label belongs to.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['property graphs cannot be unlogged'],
    hint: {
      title: 'UNLOGGED is not allowed',
      hint: 'PG19 does not permit UNLOGGED property graphs. Remove the UNLOGGED keyword from the CREATE PROPERTY GRAPH statement — the underlying tables can still be unlogged if needed.',
      docsHref: DOCS_CREATE,
    },
  },
  {
    needles: ['invalid privilege type', 'for property graph'],
    hint: {
      title: 'Only SELECT applies to property graphs',
      hint: 'Property graphs only accept the SELECT privilege; INSERT, UPDATE, DELETE, TRUNCATE and the rest are rejected. Grant the privilege on the underlying tables instead if write access is needed.',
      docsHref: DOCS_DDL,
    },
  },
  {
    // 19beta1 only rejects temp/persistent mixing on the ALTER path. A
    // CREATE that mixes them succeeds with a NOTICE — the whole graph is
    // silently made temporary (mirrors temp-view behaviour).
    needles: ['cannot add temporary element table'],
    hint: {
      title: 'Temp table on a persistent graph',
      hint: 'ALTER PROPERTY GRAPH cannot add a temporary element table to a non-temporary property graph. Use a persistent table, or recreate the graph with the temp table included — CREATE then makes the whole graph temporary.',
      docsHref: DOCS_ALTER,
    },
  },

  // ───────── viewer-synthesized errors (not from PG) ─────────
  // The next two are produced by PGQViewer's own projection/introspection
  // code (server/internal/sqlpgq/projection.go and introspect.go), not by
  // PostgreSQL. They surface as ordinary `error` events, so they ride the
  // same matchHint path; needles below mirror those Go format strings.
  {
    // projection.go validateBinding: the residual hard error after the viewer
    // learned to DEGRADE most keyless graphs. A vertex whose KEY isn't exposed
    // as a property now falls back to a property-derived identity and renders
    // fine; this fires only when there's ALSO no other property — i.e. nothing
    // at all to identify the vertex by, which PG can't surface to a query
    // either. (A KEY column simply being unexposed is no longer an error.)
    needles: ['nothing to identify this vertex by'],
    hint: {
      title: 'Vertex has no identifiable column',
      hint: 'This vertex exposes neither its KEY columns nor any other property, so there is no column the viewer can use to tell its rows apart on the canvas. List at least one column in PROPERTIES (...) — or drop the clause entirely to expose all columns (PostgreSQL\'s default).',
      docsHref: DOCS_CREATE,
    },
  },
  {
    // introspect.go refMismatchDiagnostic: an edge's SOURCE/DESTINATION
    // `REFERENCES columns (...) do not match vertex "..."'s KEY columns (...)`.
    // The viewer can't synthesize matching endpoint ids across the mismatch.
    needles: ['references columns', 'do not match', 'key columns'],
    hint: {
      title: 'Edge endpoints do not match vertex key',
      hint: 'This edge\'s SOURCE/DESTINATION REFERENCES columns don\'t equal the referenced vertex\'s KEY columns, so the viewer can\'t link edges to their endpoints. Recreate the graph so the edge REFERENCES the vertex\'s KEY columns, or change the vertex\'s KEY clause to match.',
      docsHref: DOCS_CREATE,
    },
  },
  {
    // matchBindings.ts rejects label disjunctions (`(x IS a|b)`) during
    // auto-projection — the server can't yet project one alias to multiple
    // elements. The needle mirrors the inferBindings() message so the UI can
    // offer a remediation action rather than just printing the string.
    needles: ['label disjunctions', 'not yet supported in graph mode'],
    hint: {
      title: 'Label disjunction not supported in graph mode',
      hint: 'PG19 accepts `(x IS a|b)`, but the viewer\'s auto-projection can\'t yet map one alias to multiple elements. Pick a single label, or open the query as a hand-written GRAPH_TABLE in SQL mode and choose the COLUMNS yourself.',
      docsHref: DOCS_QUERIES,
      action: ACTION_WRAP_GRAPH_TABLE,
    },
  },
];

// User-typed quantifier shapes PG19 rejects with a generic
// `syntax error at or near "X"` instead of the friendlier
// `element pattern quantifier is not supported`. The friendlier message
// only fires for the `{m,n}` form; everything else dies in the parser
// before the SQL/PGQ rewriter runs. Catch the common shapes so the user
// gets the same recursive-CTE advice regardless of which form they tried.
//
// The patterns are deliberately narrow — we look for tokens that only
// appear inside an edge bracket `[...]` or right after `]->`, so a stray
// `*` in (say) a SELECT column list won't trigger a misleading hint.
const QUANTIFIER_SHAPES: RegExp[] = [
  /\[\s*[^\]]*\*\s*\d/, //  [k*1..3]   [k*]   [k*1]
  /\]\s*-?\s*[*+]/, //      ]->* / ]->+ / ]-+ / ]+ — superset of every `]…[*+]` form
];

// PATTERNS[0] is the canonical "element pattern quantifier" rule; pulled
// to a module-level const so the matchHint fallback path doesn't need a
// runtime nullable-index dance.
const QUANTIFIER_HINT: ErrorHint = PATTERNS[0]!.hint;

function looksLikeQuantifier(query: string | undefined): boolean {
  if (!query) return false;
  return QUANTIFIER_SHAPES.some((re) => re.test(query));
}

// A bare star at the start of the COLUMNS list (`COLUMNS (*)`, with optional
// whitespace) — 19beta1's parser rejects it with a generic `syntax error at
// or near "*"` before the rewriter can emit the friendlier `"*" is not
// supported here` it uses for qualified stars (`a.*`). Narrow on purpose: a
// `*` elsewhere in the query (SELECT list, multiplication) won't match.
const COLUMNS_STAR_RE = /\bCOLUMNS\s*\(\s*\*/i;

function looksLikeColumnsStar(query: string | undefined): boolean {
  if (!query) return false;
  return COLUMNS_STAR_RE.test(query);
}

/**
 * Returns a friendly UI hint for a known PG19 SQL/PGQ error string, or null
 * if no rule matches. Matching is case-insensitive substring; the message
 * just needs to contain every needle for a rule to fire.
 *
 * Pass `query` to enable client-side heuristics for cases where PG returns
 * a generic `syntax error` for what is semantically a quantifier — e.g.
 * `[k*1..3]` and `]->+`. Without the query text those errors look like
 * any other syntax error and skip the hint path entirely.
 */
export function matchHint(err: string, query?: string): ErrorHint | null {
  if (!err) return null;
  const haystack = err.toLowerCase();
  for (const p of PATTERNS) {
    let ok = true;
    for (const n of p.needles) {
      if (!haystack.includes(n.toLowerCase())) {
        ok = false;
        break;
      }
    }
    if (ok) return p.hint;
  }
  // Fallbacks: PG19 emits a generic `syntax error at or near "*"` (or `+`)
  // for shapes that die in the parser before the SQL/PGQ rewriter sees
  // them. Detect those via the query shape and return the same hint we'd
  // return for the rewriter-level wording.
  if (haystack.includes('syntax error')) {
    if (looksLikeColumnsStar(query)) return COLUMNS_STAR_HINT;
    if (looksLikeQuantifier(query)) return QUANTIFIER_HINT;
  }
  return null;
}
