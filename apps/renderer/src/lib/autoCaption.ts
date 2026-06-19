// Auto node-caption heuristic: which property value to show on a vertex when
// the user hasn't set an explicit per-label caption (see labelCaptions.ts).
//
// The goal is that a node is NEVER blank when it carries any visible property.
// This matters most for keyless graphs: their KEY column isn't exposed as a
// property, so the conventional `id` fallback finds nothing, and the remaining
// columns may not be named exactly `name`. Mirrors the server's
// heuristicDisplayProperties (server/internal/sqlpgq/projection.go).

// scalar property values are the ones worth rendering as a caption; an object /
// array value (rare, from a jsonb-ish column) isn't a useful node label.
function isScalar(v: unknown): v is string | number | boolean {
  return (
    v !== null &&
    v !== undefined &&
    (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
  );
}

// pickAutoCaption chooses caption text from a vertex's projected properties.
// Preference order:
//   1. a conventional name-ish column (name/title/label/display_name),
//   2. any column whose name contains "name"/"title" (full_name, job_title, …),
//   3. a conventional id-ish column (id/uuid/key),
//   4. the first string property, then any scalar property.
// Returns "" only when the node has no scalar property at all (e.g. a NO
// PROPERTIES element) — the caller may then stub a label.
export function pickAutoCaption(props: Record<string, unknown>): string {
  for (const k of ['name', 'title', 'label', 'display_name', 'displayname']) {
    if (isScalar(props[k])) return String(props[k]);
  }
  for (const [k, v] of Object.entries(props)) {
    const lk = k.toLowerCase();
    if ((lk.includes('name') || lk.includes('title')) && isScalar(v)) return String(v);
  }
  for (const k of ['id', 'uuid', 'key']) {
    if (isScalar(props[k])) return String(props[k]);
  }
  for (const v of Object.values(props)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const v of Object.values(props)) {
    if (isScalar(v)) return String(v);
  }
  return '';
}
