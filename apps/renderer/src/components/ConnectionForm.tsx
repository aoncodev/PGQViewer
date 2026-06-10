import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  deleteConnection,
  listConnections,
  openSavedConnection,
  openSession,
  saveConnection,
  type SavedConnection,
} from '../lib/api';
import { useApp } from '../lib/store';
import { DatabaseIcon } from './Icons';

type SSLMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

interface FormState {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode: SSLMode;
}

const DEFAULTS: FormState = {
  name: '',
  host: '127.0.0.1',
  port: 5432,
  database: 'postgres',
  user: 'postgres',
  password: 'postgres',
  sslmode: 'disable',
};

export function ConnectionForm() {
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  const [query, setQuery] = useState('');
  const setSession = useApp((s) => s.setSession);
  const pushToast = useApp((s) => s.pushToast);

  useEffect(() => {
    let cancelled = false;
    listConnections()
      .then((list) => {
        if (!cancelled) setSaved(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return saved;
    return saved.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.host.toLowerCase().includes(needle) ||
        c.database.toLowerCase().includes(needle),
    );
  }, [saved, query]);

  async function openSaved(id: number) {
    setBusy(true);
    try {
      const res = await openSavedConnection(id);
      setSession(res.session_id, res.label);
    } catch (e) {
      pushToast('error', String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function removeSaved(id: number, name: string) {
    if (!window.confirm(`Remove saved connection "${name}"?`)) return;
    try {
      await deleteConnection(id);
      setSaved((s) => s.filter((c) => c.id !== id));
    } catch (e) {
      pushToast('error', String(e instanceof Error ? e.message : e));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await openSession(form);
      if (save && form.name.trim()) {
        try {
          const c = await saveConnection(form);
          setSaved((s) => [...s.filter((x) => x.id !== c.id), c]);
        } catch (e) {
          pushToast(
            'error',
            `Saved-connection write failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
      setSession(res.session_id, res.label);
    } catch (e) {
      pushToast('error', String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <div className="flex h-full items-stretch overflow-hidden">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            Saved connections
          </h2>
          <span className="text-[11px] text-fg-subtle">{saved.length}</span>
        </div>
        {saved.length > 0 && (
          <div className="mb-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            />
          </div>
        )}
        {saved.length === 0 ? (
          <EmptySavedState />
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-fg-subtle">
            No matches for "{query}".
          </div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => openSaved(c.id)}
                  disabled={busy}
                  className="group block w-full rounded-lg border border-border bg-bg p-3 text-left transition-all hover:border-accent hover:bg-surface-2 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 truncate text-sm font-medium text-fg">
                        <DatabaseIcon className="h-3.5 w-3.5 shrink-0 text-fg-subtle group-hover:text-accent" />
                        {c.name}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle">
                        {c.user}@{c.host}:{c.port}/{c.database}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSaved(c.id, c.name);
                      }}
                      title="Remove"
                      aria-label={`Remove ${c.name}`}
                      className="-mr-1 -mt-1 rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl p-8">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-fg">New connection</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Connect to a PostgreSQL 19 database with at least one property graph.
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-5">
            <Field label="Connection name" optional>
              <input
                type="text"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                placeholder="e.g. Local PG19"
                className={inputCls}
              />
            </Field>

            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-3">
                <Field label="Host">
                  <input
                    type="text"
                    value={form.host}
                    onChange={(e) => update('host', e.target.value)}
                    required
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="Port">
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => update('port', Number(e.target.value))}
                  required
                  className={inputCls}
                />
              </Field>
            </div>

            <Field label="Database">
              <input
                type="text"
                value={form.database}
                onChange={(e) => update('database', e.target.value)}
                required
                className={inputCls}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="User">
                <input
                  type="text"
                  value={form.user}
                  onChange={(e) => update('user', e.target.value)}
                  required
                  className={inputCls}
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => update('password', e.target.value)}
                  autoComplete="current-password"
                  className={inputCls}
                />
              </Field>
            </div>

            <Field label="SSL mode">
              <select
                value={form.sslmode}
                onChange={(e) => update('sslmode', e.target.value as SSLMode)}
                className={inputCls}
              >
                <option value="disable">disable</option>
                <option value="prefer">prefer</option>
                <option value="require">require</option>
                <option value="verify-ca">verify-ca</option>
                <option value="verify-full">verify-full</option>
              </select>
            </Field>

            <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                checked={save}
                onChange={(e) => setSave(e.target.checked)}
                disabled={!form.name.trim()}
                className="accent-accent"
              />
              <span className="text-fg-muted">Save this connection</span>
              {!form.name.trim() && (
                <span className="text-xs text-fg-subtle">(name required)</span>
              )}
            </label>

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy && <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />}
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]';

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-muted">
        {label}
        {optional && <span className="text-[10px] text-fg-subtle">(optional)</span>}
      </span>
      {children}
    </label>
  );
}

function EmptySavedState() {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
      <DatabaseIcon className="mx-auto h-6 w-6 text-fg-subtle" />
      <p className="mt-2 text-xs text-fg-muted">No saved connections yet.</p>
      <p className="mt-1 text-[11px] text-fg-subtle">
        Tick "Save" when connecting to remember it.
      </p>
    </div>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
