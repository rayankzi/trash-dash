import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    // The three.js chunk alone is ~640 kB minified (160 kB gzipped).
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // three.js changes far less often than the game: keep it in its own
        // long-cacheable chunk.
        codeSplitting: {
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
