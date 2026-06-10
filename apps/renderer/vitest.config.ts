import { defineConfig } from 'vitest/config';

// Test runner config for the renderer. jsdom gives the lib tests a `window`
// and `localStorage`; the suite is plain TS (no component rendering yet) so
// the Vite React/Tailwind plugins are intentionally not loaded here.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
