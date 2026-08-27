import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@client': resolve(__dirname, 'src/client'),
    },
  },
  server: {
    host: '127.0.0.1',
    // The Playwright fixtures create a fresh middleware-mode server for every
    // test. Pre-transform the small client graph once at server startup so the
    // first navigation does not pay a route-by-route transform waterfall and
    // fail before the same page succeeds immediately on retry.
    warmup: {
      clientFiles: [
        './src/client/**/*.{ts,tsx}',
        './src/client/styles/*.css',
      ],
    },
  },
});
