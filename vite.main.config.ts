import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // Only keep true built-ins and electron as external.
      // yahoo-finance2 must be BUNDLED (not external) so the packaged app can find it.
      external: [
        'electron',
        'node:sqlite',
        /^node:/,
        'path', 'fs', 'os', 'url', 'stream', 'http', 'https', 'net', 'tls',
        'crypto', 'zlib', 'events', 'util', 'buffer', 'querystring', 'assert',
      ],
    },
  },
  resolve: {
    // Help Vite find CJS fallbacks for ESM-only packages
    mainFields: ['main', 'module'],
  },
});
