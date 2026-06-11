// Lightweight detector for a top-level GRAPH_TABLE(...) reference in a raw
// SQL string, used by the "View as graph" action in SQL mode.
//
// PG19 GRAPH_TABLE syntax (queries-graph.html):
//
//   GRAPH_TABLE ( <graph> MATCH <path pattern> [ WHERE <predicate> ]
//                 COLUMNS ( <expr> [AS alias], ... ) )
//
// We extract just what graph-mode needs to re-run the query against the
// auto-projecting graph endpoint: the graph name, the MATCH pattern, and the
// top-level WHERE. The user's COLUMNS list is intentionally discarded — the
// server projects identity columns itself so the canvas can render.
//
// This is a pragmatic recogniser, not a full SQL parser. It is string-
// literal-, line-comment-, block-comment-, and nesting-aware so brackets or
// the word GRAPH_TABLE inside a string/comment don't false-positive, and a
// nested subquery's own parens don't desync the COLUMNS scan. It deliberately
// recognises only the common shape `SELECT ... FROM GRAPH_TABLE ( ... )`; if
// the statement is more exotic we return null and the caller falls back to a
// "couldn't parse" toast.

export interface ParsedGraphTable {
  /** Graph name as written (may be schema-qualified, e.g. `app.social`). */
  graphName: string;
  /** The MATCH path pattern, verbatim, sans the MATCH keyword. */
  match: string;
  /** Top-level WHERE predicate (sans the WHERE keyword), or undefined. */
  where?: string;
}

/**
 * Returns the first top-level GRAPH_TABLE reference found in `sql`, or null
 * when the SQL has no recognisable GRAPH_TABLE(...) call.
 */
export function parseGraphTableSql(sql: string): ParsedGraphTable | null {
  // Find the `GRAPH_TABLE` keyword at a position that isn't inside a string
  // or comment, immediately followed (modulo whitespace) by `(`. The whole
  // scan is string/comment aware, so we work on `sql` directly.
  const kwStart = findGraphTableKeyword(sql);
  if (kwStart < 0) return null;

  // Locate the opening paren of the GRAPH_TABLE reference.
  const open = skipTrivia(sql, kwStart + 'GRAPH_TABLE'.length);
  if (sql[open] !== '(') return null;
  const close = findMatchingParen(sql, open);
  if (close < 0) return null;

  return parseInner(sql.slice(open + 1, close));
}

// parseInner pulls graphName / match / where out of the text between the
// GRAPH_TABLE parens.
function parseInner(inner: string): ParsedGraphTable | null {
  // 1. graph name: leading identifier (optionally schema-qualified) up to the
  //    MATCH keyword.
  const matchKw = findKeyword(inner, 'MATCH', 0);
  if (matchKw < 0) return null;
  const graphName = inner.slice(0, matchKw).trim();
  if (!graphName || !isQualifiedIdent(graphName)) return null;

  // 2. match pattern + optional WHERE: everything from after MATCH up to the
  //    top-level COLUMNS keyword (or end). WHERE, if present, is the segment
  //    after a top-level WHERE keyword and before COLUMNS.
  const afterMatch = matchKw + 'MATCH'.length;
  const columnsKw = findKeyword(inner, 'COLUMNS', afterMatch);
  const bodyEnd = columnsKw < 0 ? inner.length : columnsKw;
  const body = inner.slice(afterMatch, bodyEnd);

  const whereKw = findKeyword(body, 'WHERE', 0);
  let match: string;
  let where: string | undefined;
  if (whereKw < 0) {
    match = body.trim();
  } else {
    match = body.slice(0, whereKw).trim();
    const w = body.slice(whereKw + 'WHERE'.length).trim();
    where = w.length > 0 ? w : undefined;
  }
  if (!match) return null;
  return { graphName, match, ...(where ? { where } : {}) };
}

// isQualifiedIdent accepts `name` or `schema.name`, with optional double
// quotes on each part. Rejects anything containing whitespace or punctuation
// that wouldn't appear in a graph reference (guards against grabbing a stray
// expression when MATCH wasn't really there).
function isQualifiedIdent(s: string): boolean {
  return /^(?:"[^"]+"|[A-Za-z_][A-Za-z_0-9$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z_0-9$]*))?$/.test(
    s,
  );
}

// findGraphTableKeyword returns the index of a top-level `GRAPH_TABLE` token
// (case-insensitive, whole-word) that is followed by `(`, skipping any inside
// strings/comments. -1 if none.
function findGraphTableKeyword(s: string): number {
  let i = 0;
  while (i < s.length) {
    const skipped = skipStringOrComment(s, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (isKeywordAt(s, i, 'GRAPH_TABLE')) {
      const j = skipTrivia(s, i + 'GRAPH_TABLE'.length);
      if (s[j] === '(') return i;
    }
    i++;
  }
  return -1;
}

// findKeyword returns the index of a whole-word `kw` (case-insensitive) at
// nesting depth 0 relative to `start`, skipping strings/comments and any text
// nested inside parentheses/brackets. -1 if not found.
function findKeyword(s: string, kw: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < s.length) {
    const skipped = skipStringOrComment(s, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = s[i]!;
    if (c === '(' || c === '[') {
      depth++;
      i++;
      continue;
    }
    if (c === ')' || c === ']') {
      if (depth > 0) depth--;
      i++;
      continue;
    }
    if (depth === 0 && isKeywordAt(s, i, kw)) return i;
    i++;
  }
  return -1;
}

// skipStringOrComment advances past a single-quoted string, a "--" line
// comment, or a "/* */" block comment that begins at index i. Returns i
// unchanged if none of those start here.
function skipStringOrComment(s: string, i: number): number {
  const c = s[i];
  if (c === "'") return skipString(s, i);
  if (c === '"') return skipQuotedIdent(s, i);
  if (c === '-' && s[i + 1] === '-') {
    let j = i + 2;
    while (j < s.length && s[j] !== '\n') j++;
    return j;
  }
  if (c === '/' && s[i + 1] === '*') {
    let j = i + 2;
    while (j < s.length && !(s[j] === '*' && s[j + 1] === '/')) j++;
    return Math.min(s.length, j + 2);
  }
  return i;
}

function skipString(s: string, start: number): number {
  // '' escapes a single quote inside the literal (standard PG).
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return s.length;
}

function skipQuotedIdent(s: string, start: number): number {
  // "" escapes a double quote inside a quoted identifier.
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return s.length;
}

// findMatchingParen returns the index of the `)` that closes the `(` at
// `open`, string/comment-aware. -1 if unbalanced.
function findMatchingParen(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const skipped = skipStringOrComment(s, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = s[i]!;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipTrivia(s: string, i: number): number {
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    const skipped = skipStringOrComment(s, i);
    // Only comments advance here (skipStringOrComment also handles strings,
    // but a string is never trivia between a keyword and its paren).
    if (skipped !== i && (s[i] === '-' || s[i] === '/')) {
      i = skipped;
      continue;
    }
    return i;
  }
}

// isKeywordAt reports whether `kw` appears at position i as a whole word
// (case-insensitive) — not as a substring of a longer identifier.
function isKeywordAt(s: string, i: number, kw: string): boolean {
  if (s.slice(i, i + kw.length).toUpperCase() !== kw.toUpperCase()) return false;
  const before = s[i - 1];
  const after = s[i + kw.length];
  const wordChar = (ch: string | undefined) =>
    ch !== undefined && /[A-Za-z_0-9$]/.test(ch);
  return !wordChar(before) && !wordChar(after);
}
