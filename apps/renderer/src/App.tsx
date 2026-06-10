import { useEffect, useMemo, useState } from 'react';
import { CommandPalette, type CommandAction } from './components/CommandPalette';
import { ConnectionForm } from './components/ConnectionForm';
import { Logo } from './components/Logo';
import { PalettePicker } from './components/PalettePicker';
import { Sidebar } from './components/Sidebar';
import { ThemeToggle } from './components/ThemeToggle';
import { Toasts } from './components/Toasts';
import { Workspace } from './components/Workspace';
import { pingSession } from './lib/api';
import { PALETTES, type PaletteId } from './lib/palettes';
import { useApp } from './lib/store';

export function App() {
  const sid = useApp((s) => s.sid);
  const setSession = useApp((s) => s.setSession);
  const theme = useApp((s) => s.theme);
  const palette = useApp((s) => s.palette);
  const pushToast = useApp((s) => s.pushToast);
  const focusMode = useApp((s) => s.focusMode);
  const setFocusMode = useApp((s) => s.setFocusMode);

  // Apply theme + palette to <html> so global CSS variables flip.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  useEffect(() => {
    document.documentElement.setAttribute('data-palette', palette);
  }, [palette]);

  // ESC anywhere in the app exits focus mode. Captured at window level so
  // it works regardless of which element has focus. Skips when a modal is
  // open so the Modal's own ESC handler can close itself first — otherwise
  // a single ESC press both dismisses the modal AND exits focus mode.
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // useApp.getState() reads without subscribing; we only need a snapshot.
      if (useApp.getState().modalOpen !== null) return;
      setFocusMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, setFocusMode]);

  // On first mount, if we restored a session id from localStorage we have to
  // verify the server still has the pool open — page reloads (F5) leave the
  // sid persisted but the underlying pool may have been garbage-collected.
  const [bootChecking, setBootChecking] = useState<boolean>(() => !!sid);
  useEffect(() => {
    if (!sid) {
      setBootChecking(false);
      return;
    }
    let cancelled = false;
    pingSession(sid).then((alive) => {
      if (cancelled) return;
      if (!alive) {
        setSession(null, null);
        pushToast('info', 'Previous session expired; reconnect to continue.');
      }
      setBootChecking(false);
    });
    return () => {
      cancelled = true;
    };
    // Intentionally only runs on mount: subsequent setSession calls don't
    // need re-validation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      {/* Hide chrome in focus mode via display:none rather than unmount —
          keeps Sidebar's internal expanded-row state alive when the user
          toggles back. */}
      <div className={focusMode ? 'hidden' : 'contents'}>
        <Header />
      </div>
      <div className="min-h-0 flex-1">
        {bootChecking ? (
          <BootSplash />
        ) : sid ? (
          <div className="flex h-full">
            <div className={focusMode ? 'hidden' : 'contents'}>
              <Sidebar />
            </div>
            <Workspace />
          </div>
        ) : (
          <ConnectionForm />
        )}
      </div>
      <PaletteWiring />
      <Toasts />
    </div>
  );
}

function BootSplash() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-fg-subtle">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span className="text-xs">Reconnecting…</span>
      </div>
    </div>
  );
}

function Header() {
  const sid = useApp((s) => s.sid);

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-surface px-4">
      <div className="flex items-center gap-2.5">
        <Logo className="h-6 w-6 text-accent" />
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-fg">PGQViewer</span>
          <span className="text-[11px] text-fg-subtle">PostgreSQL 19 · SQL/PGQ · Community Viewer</span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {sid && (
          <>
            <span className="ml-1 hidden text-[10px] text-fg-subtle md:inline">
              <kbd className="rounded bg-bg px-1 py-0.5">⌘K</kbd>
            </span>
            <div className="mx-1 h-5 w-px bg-border" />
          </>
        )}
        <PalettePicker />
        <ThemeToggle />
      </div>
    </header>
  );
}

// PaletteWiring composes the command palette's action list out of the current
// store state and renders the palette itself.
function PaletteWiring() {
  const sid = useApp((s) => s.sid);
  const graphs = useApp((s) => s.graphs);
  const selectGraph = useApp((s) => s.selectGraph);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const palette = useApp((s) => s.palette);
  const setPalette = useApp((s) => s.setPalette);

  const actions = useMemo<CommandAction[]>(() => {
    if (!sid) return [];
    const out: CommandAction[] = [
      {
        id: 'toggle-theme',
        group: 'View',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      ...PALETTES.filter((p) => p.id !== palette).map(
        (p) =>
          ({
            id: `palette-${p.id}`,
            group: 'View',
            label: `Accent palette: ${p.name}`,
            run: () => setPalette(p.id as PaletteId),
          }) satisfies CommandAction,
      ),
      ...graphs.map(
        (g) =>
          ({
            id: `switch-graph-${g.oid}`,
            group: 'Switch graph',
            label: `${g.schema}.${g.name}`,
            run: () => selectGraph(g.oid),
          }) satisfies CommandAction,
      ),
    ];
    return out;
  }, [sid, graphs, selectGraph, theme, setTheme, palette, setPalette]);

  return <CommandPalette actions={actions} />;
}
