import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In production the Go binary serves the built renderer itself (embedded
// bundle, see server/internal/webui), so API calls are same-origin. In dev,
// Vite serves the app and this proxy forwards /api/v1/* to the Go server on
// its default --http port so fetches stay same-origin here too.
const SERVER_DEV_PORT = Number(process.env.PGVIEWER_DEV_PORT ?? 8080);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_DEV_PORT}`,
        changeOrigin: false,
      },
    },
  },
});
