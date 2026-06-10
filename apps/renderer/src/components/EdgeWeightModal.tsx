import { useEffect, useMemo, useState } from 'react';
import { useApp, type EdgeWeightConfig } from '../lib/store';
import { discoverLabelProperties } from '../lib/discoverProperties';
import { toFiniteNumber } from '../lib/format';
import { Modal } from './Modal';

// True for PG type names that carry a number — used to keep the property
// dropdown to columns the edge-weight mapping can actually scale.
function isNumericType(t: string): boolean {
  const s = t.toLowerCase();
  return (
    s.includes('int') ||
    s.includes('numeric') ||
    s.includes('decimal') ||
    s.includes('real') ||
    s.includes('double') ||
    s.includes('float') ||
    s === 'serial' ||
    s === 'bigserial'
  );
}

export function EdgeWeightModal() {
  const open = useApp((s) => s.modalOpen) === 'edgeWeight';
  const closeModal = useApp((s) => s.closeModal);
  const metadata = useApp((s) => s.metadata);
  const edges = useApp((s) => s.edges);
  const current = useApp((s) => s.edgeWeight);
  const setEdgeWeight = useApp((s) => s.setEdgeWeight);

  // Edge-label/property pairs, narrowed to numeric properties — schema
  // metadata carries a type name, live edges carry an actual value.
  const options = useMemo(
    () =>
      discoverLabelProperties(
        { metadata, edges },
        {
          kinds: ['e'],
          // Live values: accept numeric strings too — the server
          // stringifies PG `numeric` (and >2^53 ints) for precision, so a
          // weight-able property can arrive as "8.8".
          keep: (p) =>
            p.type !== undefined
              ? isNumericType(p.type)
              : toFiniteNumber(p.value) !== null,
        },
      ),
    [metadata, edges],
  );

  // Local form state so the user can edit without applying immediately. We
  // hydrate from the live store on open so re-opening shows the current
  // values, not a blank form.
  const [edgeLabel, setEdgeLabel] = useState(current?.edgeLabel ?? '');
  const [property, setProperty] = useState(current?.property ?? '');
  const [minWidth, setMinWidth] = useState(String(current?.minWidth ?? 1));
  const [maxWidth, setMaxWidth] = useState(String(current?.maxWidth ?? 21));

  useEffect(() => {
    if (open) {
      setEdgeLabel(current?.edgeLabel ?? '');
      setProperty(current?.property ?? '');
      setMinWidth(String(current?.minWidth ?? 1));
      setMaxWidth(String(current?.maxWidth ?? 21));
    }
    // Re-hydrate every time the modal opens so it reflects the latest config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const edgeLabels = useMemo(
    () => Array.from(new Set(options.map((o) => o.label))),
    [options],
  );
  const propsForEdge = useMemo(
    () => options.filter((o) => o.label === edgeLabel).map((o) => o.property),
    [options, edgeLabel],
  );

  const apply = () => {
    const min = Number(minWidth);
    const max = Number(maxWidth);
    if (!edgeLabel || !property) return;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min) return;
    const cfg: EdgeWeightConfig = {
      edgeLabel,
      property,
      minWidth: min,
      maxWidth: max,
    };
    setEdgeWeight(cfg);
    closeModal();
  };
  const reset = () => {
    setEdgeWeight(null);
    closeModal();
  };

  // Mirror the validation in apply() exactly so the button's enabled state
  // matches what apply() will accept. Without Number.isFinite, `1e999` (= Infinity)
  // would enable the button but silently no-op in apply().
  const minNum = Number(minWidth);
  const maxNum = Number(maxWidth);
  const canApply =
    edgeLabel !== '' &&
    property !== '' &&
    Number.isFinite(minNum) &&
    Number.isFinite(maxNum) &&
    minNum >= 0 &&
    maxNum > minNum;

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title="Edge thickness by property"
      widthClass="max-w-md"
      footer={
        <>
          <button
            type="button"
            onClick={reset}
            className="rounded border border-border bg-surface px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!canApply}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply
          </button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No numeric edge properties to map. Run a query that returns edges
          carrying integer or numeric properties first.
        </p>
      ) : (
        <div className="space-y-3 text-xs">
          <Field label="Edge label">
            <select
              value={edgeLabel}
              onChange={(e) => {
                setEdgeLabel(e.target.value);
                setProperty(''); // reset dependent select
              }}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 outline-none focus:border-accent"
            >
              <option value="">— Select edge label —</option>
              {edgeLabels.map((lab) => (
                <option key={lab} value={lab}>
                  {lab}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Numeric property">
            <select
              value={property}
              onChange={(e) => setProperty(e.target.value)}
              disabled={!edgeLabel}
              className="w-full rounded border border-border bg-surface px-2 py-1.5 outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">— Select property —</option>
              {propsForEdge.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Min width (px)">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={0.5}
                value={minWidth}
                onChange={(e) => setMinWidth(e.target.value)}
                className="w-full rounded border border-border bg-surface px-2 py-1.5 outline-none focus:border-accent"
              />
            </Field>
            <Field label="Max width (px)">
              <input
                type="number"
                inputMode="numeric"
                min={0.5}
                step={0.5}
                value={maxWidth}
                onChange={(e) => setMaxWidth(e.target.value)}
                className="w-full rounded border border-border bg-surface px-2 py-1.5 outline-none focus:border-accent"
              />
            </Field>
          </div>
          <p className="text-[11px] text-fg-subtle">
            Edges matching the chosen label map their <strong>{property || 'property'}</strong> value
            linearly between min/max widths. Other labels keep their default width.
          </p>
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-fg-subtle">{label}</span>
      {children}
    </label>
  );
}
