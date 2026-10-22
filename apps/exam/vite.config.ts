import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // No source maps in production. The answer key never reaches the client by
    // any route, and a source map is one of the routes people forget about.
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        // A content-hashed, long-cacheable bundle: 10,000 students load this
        // inside a 30-minute window and every one of them must hit the CDN.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5173 },
});
