import { defineConfig } from 'vitest/config';

// Test runner config for the renderer. jsdom gives the lib tests a `window`
// and `localStorage`; the suite is plain TS (no component rendering yet) so
// the Vite React/Tailwind plugins are intentionally not loaded here.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // Node 25's partial built-in `localStorage` shadows jsdom's; the setup file
    // installs a spec-compliant in-memory Storage. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
