import type { InferResult } from '../lib/matchBindings';
import type { GraphMetadata } from '../lib/api';

interface Props {
  /** Result of inferBindings(matchText, metadata), debounced by the parent. */
  result: InferResult | null;
  metadata: GraphMetadata | null;
}

// Resolve an element OID back to a human label for the chip. Falls back to the
// OID when the element isn't found (shouldn't happen for a valid inference).
function labelFor(oid: number, metadata: GraphMetadata | null): string {
  if (!metadata) return String(oid);
  const el =
    metadata.vertices.find((e) => e.oid === oid) ??
    metadata.edges.find((e) => e.oid === oid);
  if (!el) return String(oid);
  return el.labels[0] ?? el.alias;
}

function kindOf(oid: number, metadata: GraphMetadata | null): 'v' | 'e' {
  return metadata?.edges.some((e) => e.oid === oid) ? 'e' : 'v';
}

/**
 * Live preview of how the current MATCH pattern will bind aliases to graph
 * elements, shown below the editor in graph mode BEFORE the user runs. Errors
 * render as a single inline note; non-fatal warnings (unaliased/abbreviated
 * positions that won't be drawn) render as amber notes; successful bindings
 * render as alias→label chips.
 */
export function BindingPreview({ result, metadata }: Props) {
  if (!result) return null;

  if (result.error) {
    return (
      <div className="rounded-md border border-danger/40 bg-bg px-3 py-1.5 text-[11px] text-danger">
        {result.error}
      </div>
    );
  }

  const { bindings, warnings } = result;
  if (bindings.length === 0 && (!warnings || warnings.length === 0)) return null;

  return (
    <div className="rounded-md border border-border bg-bg px-3 py-2">
      {bindings.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
            binds
          </span>
          {bindings.map((b) => {
            const kind = kindOf(b.element_oid, metadata);
            return (
              <span
                key={b.alias}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-fg-muted"
              >
                <span className="font-medium text-fg">{b.alias}</span>
                <span className="text-fg-subtle">{kind === 'v' ? '◯' : '→'}</span>
                <span>{labelFor(b.element_oid, metadata)}</span>
              </span>
            );
          })}
        </div>
      )}
      {warnings && warnings.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {warnings.map((w, i) => (
            <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-warning">
              <span aria-hidden>⚠</span>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
