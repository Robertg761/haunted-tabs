import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/chrome'),
    emptyOutDir: false,
    target: 'chrome116',
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'HauntedTabsContent',
      fileName: () => 'content.js',
    },
  },
});
