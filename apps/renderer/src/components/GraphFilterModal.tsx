import { useEffect, useMemo, useState } from 'react';
import { useApp, type PropertyFilter } from '../lib/store';
import { discoverLabelProperties } from '../lib/discoverProperties';
import { Modal } from './Modal';

function newRow(): PropertyFilter {
  return {
    id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    label: '',
    property: '',
    keyword: '',
  };
}

export function GraphFilterModal() {
  const open = useApp((s) => s.modalOpen) === 'filter';
  const closeModal = useApp((s) => s.closeModal);
  const metadata = useApp((s) => s.metadata);
  const vertices = useApp((s) => s.vertices);
  const edges = useApp((s) => s.edges);
  const current = useApp((s) => s.propertyFilters);
  const setPropertyFilters = useApp((s) => s.setPropertyFilters);

  const options = useMemo(
    () => discoverLabelProperties({ metadata, vertices, edges }),
    [metadata, vertices, edges],
  );

  // Local editable copy — apply on click so the canvas doesn't flicker
  // mid-edit. Hydrate from store on open.
  const [rows, setRows] = useState<PropertyFilter[]>(current.length ? current : [newRow()]);

  useEffect(() => {
    if (open) setRows(current.length ? current : [newRow()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const apply = () => {
    // Drop entirely-blank rows (no label, no property, no real keyword).
    // Trim the keyword first so a row with just whitespace doesn't survive.
    const kept = rows
      .map((r) => ({ ...r, keyword: r.keyword.trim() }))
      .filter((r) => r.label || r.property || r.keyword);
    setPropertyFilters(kept);
    closeModal();
  };
  const reset = () => {
    setPropertyFilters([]);
    setRows([newRow()]);
    closeModal();
  };

  const addRow = (index: number) => {
    setRows((rs) => {
      const next = rs.slice();
      next.splice(index + 1, 0, newRow());
      return next;
    });
  };
  const removeRow = (index: number) => {
    setRows((rs) => (rs.length > 1 ? rs.filter((_, i) => i !== index) : rs));
  };
  const updateRow = (index: number, patch: Partial<PropertyFilter>) => {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title="Filter graph by property"
      widthClass="max-w-3xl"
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
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
          >
            Apply
          </button>
        </>
      }
    >
      <p className="mb-3 text-[11px] text-fg-subtle">
        Each row fades out canvas elements that don't match. An element matches when its label
        equals the row's label (or the row's label is empty) AND its property value
        contains the keyword (case-insensitive). Multiple rows are OR'd together.
      </p>
      <div className="space-y-2 text-xs">
        {rows.map((row, index) => (
          <FilterRow
            key={row.id}
            row={row}
            options={options}
            onChange={(patch) => updateRow(index, patch)}
            onAdd={() => addRow(index)}
            onRemove={rows.length > 1 ? () => removeRow(index) : undefined}
          />
        ))}
      </div>
    </Modal>
  );
}

function FilterRow({
  row,
  options,
  onChange,
  onAdd,
  onRemove,
}: {
  row: PropertyFilter;
  options: { label: string; property: string }[];
  onChange: (patch: Partial<PropertyFilter>) => void;
  onAdd: () => void;
  onRemove?: () => void;
}) {
  // The dropdown value encodes (label, property) as "label|property" so a
  // single select drives both fields. The user thinks of it as one choice.
  const pickKey = row.label && row.property ? `${row.label}|${row.property}` : '';
  return (
    <div className="flex items-center gap-2">
      <select
        value={pickKey}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) {
            onChange({ label: '', property: '' });
            return;
          }
          const [label, property] = v.split('|');
          onChange({ label: label ?? '', property: property ?? '' });
        }}
        className="min-w-[220px] flex-1 rounded border border-border bg-surface px-2 py-1.5 outline-none focus:border-accent"
      >
        <option value="">— Select label.property —</option>
        {options.map((o) => (
          <option key={`${o.label}|${o.property}`} value={`${o.label}|${o.property}`}>
            [{o.label}] {o.property}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="contains…"
        value={row.keyword}
        onChange={(e) => onChange({ keyword: e.target.value })}
        className="flex-1 rounded border border-border bg-surface px-2 py-1.5 outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={onAdd}
        aria-label="Add filter row"
        className="rounded border border-border bg-surface px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        +
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove filter row"
          className="rounded border border-border bg-surface px-2.5 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          −
        </button>
      )}
    </div>
  );
}
