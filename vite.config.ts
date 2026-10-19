import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds the popup, the Graveyard page, and the background service worker.
// The content script is built separately (vite.content.config.ts) because it
// is injected with chrome.scripting and must be a single classic script.
export default defineConfig({
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'public'),
  base: '',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        graveyard: resolve(__dirname, 'src/graveyard/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  test: {
    root: __dirname,
    include: ['tests/**/*.test.ts'],
  },
} as import('vite').UserConfig & { test: unknown });
