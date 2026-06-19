// Bindings inference for the graph-mode `MATCH` pattern.
//
// Goal: take the user's `MATCH (a IS person)-[k IS knows]->(b IS person)`
// (or any abbreviated variant PG19 accepts), plus the graph metadata, and
// produce the list of `{alias, element_oid}` pairs the server's
// auto-projection needs.
//
// Behaviour worth knowing:
//
//   • The scan is kind-aware. `(...)` only matches vertex elements;
//     `[...]` only matches edge elements. SQL/PGQ allows the same label
//     name on both a vertex element and an edge element (graph_table.sql
//     in the PG19 test suite exercises this at line 218), so a regex
//     that ignored the bracket kind could mis-bind silently.
//
//   • Unlabeled aliases (`(x)`, `[k]`) are bound only when the metadata
//     is unambiguous in that kind — exactly one vertex / edge element
//     exists, or all elements share the chosen alias's element. Returns
//     a hint error otherwise.
//
//   • Label disjunctions (`(x IS a|b)`) are explicitly rejected with a
//     "use SQL mode" hint rather than silently binding to the first
//     match. PG19 accepts the syntax; we just don't support it in
//     auto-projection yet (the server can't project one alias to
//     multiple elements). The rejection string is deliberately kept in
//     sync with a pattern in lib/errors.ts (needles "label disjunctions"
//     + "not yet supported in graph mode") so the UI can surface a
//     one-click remediation action (wrap as GRAPH_TABLE / switch to SQL)
//     instead of just printing the raw message.
//     FOLLOWUP: true multi-element projection — letting one alias bind to
//     every element matched by `IS a|b` and unioning their COLUMNS —
//     needs server support in projection.go before it can be enabled here.
//
//   • Abbreviated edges (`()->()`, `()-()`) don't bind an edge alias —
//     there's no `[...]` to parse — so no edge binding is produced.
//     The user still gets vertex bindings.
//
//   • The scanner ignores brackets that live inside SQL string
//     literals (`'…'`, with `''` as the standard PG escape) so a
//     filter like `WHERE c.name = 'O''Brien'` doesn't desync depth
//     counting.

import type { Binding, GraphMetadata } from './api';

export interface InferResult {
  bindings: Binding[];
  error?: string;
  /** Non-fatal pattern issues worth telling the user about — today, the
   *  "this element matched but won't be drawn" cases. Only populated on a
   *  successful inference (errors short-circuit). */
  warnings?: string[];
}

interface Chunk {
  kind: 'vertex' | 'edge';
  body: string;
}

// ───────── public ─────────

export function inferBindings(
  match: string,
  metadata: GraphMetadata,
): InferResult {
  const chunks = extractElementChunks(match);
  if (chunks.length === 0) {
    return {
      bindings: [],
      error:
        'No element patterns found. Use `(alias IS label)` for vertices and `[alias IS label]` for edges.',
    };
  }

  // Resolve each chunk to a Binding. Track per-alias resolution so we
  // can detect alias reuse with conflicting kinds.
  const byAlias = new Map<string, Binding & { kind: 'vertex' | 'edge' }>();
  let unaliasedVertices = 0;
  let unaliasedEdges = 0;

  for (const chunk of chunks) {
    const parsed = parseChunkBody(chunk.body);
    if (parsed.error) {
      return { bindings: [], error: parsed.error };
    }
    if (!parsed.alias) {
      // `()` or `[]` with no alias — not bindable, that's fine; the
      // server will still match it but won't project any columns for
      // this position. Counted so we can warn that the element matched
      // but won't be drawn on the canvas.
      if (chunk.kind === 'vertex') unaliasedVertices++;
      else unaliasedEdges++;
      continue;
    }

    const el = resolveElement(parsed, chunk.kind, metadata);
    if (el.error) return { bindings: [], error: el.error };

    const existing = byAlias.get(parsed.alias);
    if (existing) {
      if (existing.kind !== chunk.kind) {
        return {
          bindings: [],
          error: `alias '${parsed.alias}' is used as both a vertex and an edge — pick distinct names`,
        };
      }
      if (existing.element_oid !== el.elementOID!) {
        return {
          bindings: [],
          error: `alias '${parsed.alias}' is bound to two different elements; rename one of them`,
        };
      }
      continue;
    }
    byAlias.set(parsed.alias, {
      alias: parsed.alias,
      element_oid: el.elementOID!,
      kind: chunk.kind,
      // Carry the matched label so the server can scope the projected COLUMNS to
      // it (SQL/PGQ rejects a property not on the bound label). Unlabeled → none.
      ...(parsed.label ? { label: parsed.label } : {}),
    });
  }

  if (byAlias.size === 0) {
    return {
      bindings: [],
      error:
        'No bindable aliases. Add an alias to at least one element: e.g. `(a IS person)`.',
    };
  }

  // Non-fatal "this won't be drawn" warnings. Only unprojected positions
  // misrepresent the canvas: the query still matches them, but no
  // vertex/edge event is emitted, so e.g. `(a)-[]->(b)` renders a and b as
  // DISCONNECTED nodes even though the match traversed an edge.
  const warnings: string[] = [];
  if (unaliasedEdges > 0) {
    warnings.push(
      `${unaliasedEdges === 1 ? 'An edge pattern has' : `${unaliasedEdges} edge patterns have`} no alias — the traversed edge won't be drawn, so connected nodes may look disconnected. Write \`[k IS label]\` to render it.`,
    );
  }
  if (unaliasedVertices > 0) {
    warnings.push(
      `${unaliasedVertices === 1 ? 'A vertex pattern has' : `${unaliasedVertices} vertex patterns have`} no alias — matched vertices for that position won't be drawn. Write \`(x IS label)\` to render them.`,
    );
  }
  if (hasAbbreviatedEdge(match)) {
    warnings.push(
      'The pattern uses an abbreviated edge between vertices (e.g. `()-()` or `()->()`); the traversed edge is not projected and won\'t be drawn. Use `-[k IS label]->` to render it.',
    );
  }

  // Edge topology: which vertex aliases each edge connects, and in which
  // direction. The server uses this to link edges within a single result row,
  // so a graph whose KEY / endpoint columns aren't exposed as properties still
  // renders (PG's MATCH already resolved the connection; the FK values are never
  // needed). For a graph that DOES expose its keys this is redundant — the
  // server derives byte-identical ids either way — so it's always safe to send.
  const topo = computeEdgeTopology(match);

  return {
    bindings: Array.from(byAlias.values()).map(({ alias, element_oid, label, kind }) => {
      const binding: Binding = {
        alias,
        element_oid,
        ...(label ? { label } : {}),
      };
      if (kind === 'edge') {
        const t = topo.get(alias);
        if (t?.source) binding.source_alias = t.source;
        if (t?.dest) binding.destination_alias = t.dest;
      }
      return binding;
    }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ───────── edge topology ─────────

interface SeqElement {
  kind: 'vertex' | 'edge';
  alias?: string;
}

// computeEdgeTopology maps each aliased edge to the vertex aliases on its source
// and destination ends, honouring arrow direction. `(a)-[e]->(b)` → e: {source:
// a, dest: b}; `(a)<-[e]-(b)` → e: {source: b, dest: a}. An undirected `-[e]-`
// is treated as left→right (best effort — PG matches both ways, and the viewer
// has to pick an orientation to draw). Endpoints that are anonymous `()` or
// missing contribute no alias, leaving the server to fall back to value-based
// linking for that end.
function computeEdgeTopology(
  match: string,
): Map<string, { source?: string; dest?: string }> {
  const { seq, conns } = extractSequence(match);
  const topo = new Map<string, { source?: string; dest?: string }>();
  for (let i = 0; i < seq.length; i++) {
    const edge = seq[i]!;
    if (edge.kind !== 'edge' || !edge.alias) continue;
    const left = seq[i - 1];
    const right = seq[i + 1];
    const connBefore = conns[i - 1] ?? ''; // between left and this edge
    const connAfter = conns[i] ?? ''; // between this edge and right
    // The arrow head picks the source end: `->` after ⇒ left is source; `<-`
    // before ⇒ right is source; otherwise (undirected) default left→right.
    let sourceEl: SeqElement | undefined;
    let destEl: SeqElement | undefined;
    if (connAfter.includes('>')) {
      sourceEl = left;
      destEl = right;
    } else if (connBefore.includes('<')) {
      sourceEl = right;
      destEl = left;
    } else {
      sourceEl = left;
      destEl = right;
    }
    const entry: { source?: string; dest?: string } = {};
    if (sourceEl?.kind === 'vertex' && sourceEl.alias) entry.source = sourceEl.alias;
    if (destEl?.kind === 'vertex' && destEl.alias) entry.dest = destEl.alias;
    topo.set(edge.alias, entry);
  }
  return topo;
}

// extractSequence walks the top-level pattern into an ordered list of elements
// (vertex / edge chunks, each with its parsed alias) plus the connector text
// between consecutive elements (`-`, `->`, `<-`). conns[k] is the text between
// seq[k] and seq[k+1]. Shares the string-literal- and nesting-aware scanning of
// extractElementChunks so connectors inside a WHERE expression can't leak in.
function extractSequence(match: string): { seq: SeqElement[]; conns: string[] } {
  const seq: SeqElement[] = [];
  const conns: string[] = [];
  let i = 0;
  let pendingConn = '';
  let sawFirst = false;
  while (i < match.length) {
    const c = match[i]!;
    if (c === "'") {
      i = skipString(match, i);
      continue;
    }
    if (c === '(' || c === '[') {
      const end = findMatching(match, i);
      if (end < 0) break;
      const parsed = parseChunkBody(match.slice(i + 1, end));
      if (sawFirst) conns.push(pendingConn);
      seq.push({ kind: c === '(' ? 'vertex' : 'edge', alias: parsed.alias });
      pendingConn = '';
      sawFirst = true;
      i = end + 1;
      continue;
    }
    if (sawFirst) pendingConn += c;
    i++;
  }
  return { seq, conns };
}

// hasAbbreviatedEdge detects a vertex-to-vertex connector with no `[...]`
// edge pattern between them: `()-()`, `()->()`, `()<-()`. These produce no
// edge chunk at all, so the unaliased-edge counter above can't see them.
//
// Works on the top-level skeleton: every top-level chunk collapses to a
// single token (`V` / `E`) using the same string-literal- and nesting-aware
// scanner as extractElementChunks, so a `-` or parens inside a chunk's
// WHERE expression can't false-positive. Bracketed edges read `V-E->V` in
// the skeleton and don't match.
function hasAbbreviatedEdge(match: string): boolean {
  let skeleton = '';
  let i = 0;
  while (i < match.length) {
    const c = match[i]!;
    if (c === "'") {
      i = skipString(match, i);
      continue;
    }
    if (c === '(' || c === '[') {
      const end = findMatching(match, i);
      if (end < 0) break;
      skeleton += c === '(' ? 'V' : 'E';
      i = end + 1;
      continue;
    }
    skeleton += c;
    i++;
  }
  return /V\s*(?:<-|->|-)\s*V/.test(skeleton);
}

// ───────── chunk extraction ─────────

// extractElementChunks walks `match` character by character, tracking
// string-literal state and bracket depth, and emits one Chunk per
// top-level `(...)` / `[...]` pair. Nested parens (e.g. inside a WHERE
// expression) are captured as part of the chunk body, not as new chunks.
function extractElementChunks(match: string): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < match.length) {
    const c = match[i]!;
    if (c === "'") {
      i = skipString(match, i);
      continue;
    }
    if (c === '(' || c === '[') {
      const end = findMatching(match, i);
      if (end < 0) break; // unbalanced — give up on the remainder
      chunks.push({
        kind: c === '(' ? 'vertex' : 'edge',
        body: match.slice(i + 1, end),
      });
      i = end + 1;
      continue;
    }
    i++;
  }
  return chunks;
}

function findMatching(src: string, start: number): number {
  const opener = src[start]!;
  const closer = opener === '(' ? ')' : ']';
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "'") {
      i = skipString(src, i);
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipString(src: string, start: number): number {
  // PG uses '' to escape a single quote inside a string literal.
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "'") {
      if (src[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return src.length;
}

// ───────── per-chunk parsing ─────────

interface ParsedChunk {
  alias?: string;
  label?: string;
  error?: string;
}

const ID_RE = /[A-Za-z_][A-Za-z_0-9]*/;

function parseChunkBody(body: string): ParsedChunk {
  let i = 0;
  // Optional alias. A leading `IS` is the keyword of the alias-less form
  // (`[IS knows]`, `(IS person)`), not an alias named "IS" — IS is a
  // reserved word in PG, so an element variable can never carry that name.
  // Without this check we bound the single edge element to a variable
  // called `IS` and projected `"IS"."src"`, which PG rejects.
  i = skipWS(body, i);
  let alias: string | undefined;
  if (!isKeywordAt(body, i, 'IS')) {
    const aliasMatch = matchAt(ID_RE, body, i);
    if (aliasMatch) {
      // Fold the alias to lowercase. PostgreSQL folds the unquoted element
      // variable in the MATCH text (which we forward verbatim) to lowercase,
      // but the server quotes the binding alias inside COLUMNS (`"A"."prop"`).
      // An uppercase/mixed-case alias would then reference a variable that no
      // longer exists after folding ("missing FROM-clause entry for table A").
      // matchBindings only parses unquoted identifiers, so unconditional
      // folding here mirrors PG's own identifier rules.
      alias = aliasMatch[0].toLowerCase();
      i += aliasMatch[0].length;
    }
  }
  i = skipWS(body, i);
  // Optional `IS <label-expression>`.
  if (i + 2 <= body.length && body.slice(i, i + 2).toUpperCase() === 'IS') {
    // Make sure it's the IS keyword, not the start of an identifier.
    const after = body[i + 2];
    if (after === undefined || /\s/.test(after)) {
      i += 2;
      i = skipWS(body, i);
      // Read identifier; check whether the next non-whitespace is `|`
      // (disjunction).
      const labelMatch = matchAt(ID_RE, body, i);
      if (!labelMatch) {
        return { alias, error: `expected a label name after IS in \`(${body.trim()})\`` };
      }
      // Fold the label the same way: an unquoted `IS Person` is folded to
      // `person` by PG, which is how it is stored in the catalog (pgllabel) and
      // therefore how it must compare against element labels in resolveElement.
      const label = labelMatch[0].toLowerCase();
      const afterLabel = skipWS(body, i + labelMatch[0].length);
      if (body[afterLabel] === '|') {
        // Keep this wording in sync with the matching pattern in
        // lib/errors.ts (needles "label disjunctions" + "not yet supported
        // in graph mode"); matchHint() turns it into an actionable hint.
        return {
          alias,
          error:
            'label disjunctions (`IS a|b`) are not yet supported in graph mode — switch to SQL mode for this query, or pick a single label',
        };
      }
      return { alias, label };
    }
  }
  return { alias };
}

function skipWS(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

// isKeywordAt reports whether `kw` appears at position i as a whole word
// (case-insensitive) — i.e. not as the prefix of a longer identifier like
// `ISbn`.
function isKeywordAt(s: string, i: number, kw: string): boolean {
  if (s.slice(i, i + kw.length).toUpperCase() !== kw.toUpperCase()) return false;
  const after = s[i + kw.length];
  return after === undefined || !/[A-Za-z_0-9]/.test(after);
}

function matchAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  const anchored = new RegExp('^' + re.source);
  return anchored.exec(s.slice(i));
}

// ───────── element resolution ─────────

interface ElementResolution {
  elementOID?: number;
  error?: string;
}

function resolveElement(
  parsed: ParsedChunk,
  kind: 'vertex' | 'edge',
  metadata: GraphMetadata,
): ElementResolution {
  const pool = kind === 'vertex' ? metadata.vertices : metadata.edges;
  if (parsed.label) {
    const matches = pool.filter((e) => e.labels.includes(parsed.label!));
    if (matches.length === 0) {
      return {
        error: `unknown ${kind} label '${parsed.label}' in this graph`,
      };
    }
    if (matches.length > 1) {
      return {
        error: `label '${parsed.label}' matches ${matches.length} ${kind} elements — qualify with an alias or use SQL mode`,
      };
    }
    return { elementOID: matches[0]!.oid };
  }
  // Unlabeled: bind only if there is exactly one element of this kind.
  if (pool.length === 1) {
    return { elementOID: pool[0]!.oid };
  }
  return {
    error: `cannot infer ${kind} element for alias '${parsed.alias}' — add \`IS <label>\` (this graph has ${pool.length} ${kind} elements)`,
  };
}
