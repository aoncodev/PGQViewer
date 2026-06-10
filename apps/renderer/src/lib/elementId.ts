// Element-id format shared between server-emitted ids (see
// server/internal/sqlpgq/projection.go:joinKey) and renderer-constructed
// anchor ids for expand.
//
// Shape: `<element_oid>:<json-array-of-pk-parts>`, e.g. `12345:["42"]`
// for a single-column PK and `12345:["a","b,c"]` for a composite PK. The
// JSON array form is unambiguous — a naive comma-separator would merge
// composite PKs like `("a","b,c")` and `("a,b","c")` into the same id
// (server-side fix landed alongside this file).
//
// The renderer treats ids as opaque dedup keys for Cytoscape; we only
// parse them to extract PK parts when the user clicks a node to expand
// its neighbourhood, since the expand endpoint takes the raw PK values
// to inline into a `WHERE a.col = '…'` predicate.

export interface ParsedElementId {
  elementOID: number;
  pk: string[];
}

export function formatElementId(elementOID: number, pk: string[]): string {
  return `${elementOID}:${JSON.stringify(pk)}`;
}

export function parseElementId(id: string): ParsedElementId | null {
  const colon = id.indexOf(':');
  if (colon <= 0) return null;
  const oidNum = Number(id.slice(0, colon));
  if (!Number.isFinite(oidNum) || oidNum <= 0) return null;
  const rest = id.slice(colon + 1);
  if (rest === '') return null;
  // Modern form: a JSON array of PK parts.
  if (rest.startsWith('[')) {
    try {
      const parsed = JSON.parse(rest);
      if (!Array.isArray(parsed)) return null;
      const pk: string[] = [];
      for (const p of parsed) {
        if (typeof p !== 'string') return null;
        pk.push(p);
      }
      return { elementOID: oidNum, pk };
    } catch {
      return null;
    }
  }
  // Legacy form: comma-separated. Kept for compatibility with ids
  // emitted by older server builds; new builds always emit the JSON
  // form. Composite text PKs containing commas are ambiguous here, so
  // we accept the shape but the caller may get incorrect parts —
  // upgrading the server is the fix.
  return { elementOID: oidNum, pk: rest.split(',') };
}
