import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsConfigPaths()],

  // Vite 8: Rolldown replaces Rollup
  build: {
    rolldownOptions: {
      external: ['node:crypto', 'node:fs/promises'],
    },
  },

  // Vite 8: Oxc replaces esbuild for JS/TS transforms
  oxc: {
    jsx: { runtime: 'automatic' },
  },

  // Vite 8: rolldownOptions replaces esbuildOptions for pre-bundling
  optimizeDeps: {
    rolldownOptions: {
      external: ['node:crypto', 'node:fs/promises'],
    },
  },
})
