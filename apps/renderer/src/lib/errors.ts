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

export interface ErrorHint {
  title: string;
  hint: string;
  docsHref?: string;
}

interface Pattern {
  // All needles must appear (case-insensitive) for the rule to match.
  needles: string[];
  hint: ErrorHint;
}

const DOCS_QUERIES = 'https://www.postgresql.org/docs/devel/queries-graph.html';
const DOCS_DDL = 'https://www.postgresql.org/docs/devel/ddl-property-graphs.html';
const DOCS_CREATE = 'https://www.postgresql.org/docs/devel/sql-create-property-graph.html';
const DOCS_ALTER = 'https://www.postgresql.org/docs/devel/sql-alter-property-graph.html';

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
      hint: 'PG19 does not support {m,n}, * or + quantifiers on element patterns. Use Path Finder to generate a recursive CTE over the underlying tables, or write the join manually.',
      docsHref: DOCS_QUERIES,
    },
  },
  {
    needles: ['multiple path patterns', 'graph_table'],
    hint: {
      title: 'One path per GRAPH_TABLE',
      hint: 'PG19 rejects multiple comma-separated paths inside a single GRAPH_TABLE. Split each path into its own GRAPH_TABLE call and join them in SQL.',
      docsHref: DOCS_QUERIES,
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
      title: 'Cannot reference outer aliases here',
      hint: 'PG19 forbids referencing outer aliases inside an element WHERE clause. To correlate with outer rows, move the GRAPH_TABLE call to a LATERAL position — toggle "Lateral join" on the editor and add the outer FROM items there.',
      docsHref: DOCS_QUERIES,
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
    needles: ['unsupported element pattern kind'],
    hint: {
      title: 'Unsupported element pattern',
      hint: 'PG19 only supports vertex patterns in parentheses and edge patterns in brackets. Remove any other syntax — quantifiers, group variables, and path modes are not recognised.',
      docsHref: DOCS_QUERIES,
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
