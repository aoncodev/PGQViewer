// Vitest global setup.
//
// Node 25 ships an experimental built-in global `localStorage` that is only a
// partial Web Storage implementation: it has no `clear()` and emits a
// `--localstorage-file` warning. Being a real global, it *shadows* the
// `localStorage` jsdom installs on `window`, so `beforeEach(() => localStorage.clear())`
// throws `TypeError: localStorage.clear is not a function`. Install a clean,
// spec-compliant in-memory Storage over both `globalThis` and `window` so the
// storage / persistentMap tests run deterministically regardless of Node version.

class MemoryStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? this.m.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.m.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
}

const storage = new MemoryStorage();
const targets: unknown[] = [globalThis];
if (typeof window !== 'undefined') targets.push(window);
for (const target of targets) {
  try {
    Object.defineProperty(target as object, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  } catch {
    try {
      (target as { localStorage?: unknown }).localStorage = storage;
    } catch {
      /* last resort: leave the (broken) built-in in place */
    }
  }
}
