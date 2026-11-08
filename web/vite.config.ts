import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, fs: { allow: ['..'] } },
  // Pre-bundle the SDK so the dev server never reloads the page mid-way through redeeming a ticket.
  optimizeDeps: { include: ['spacetimedb'] },
  build: { target: 'es2022', sourcemap: true },
});
