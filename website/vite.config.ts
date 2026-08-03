import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import mdx from 'fumadocs-mdx/vite'
import { readdirSync } from 'node:fs'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'

const base = process.env.GITHUB_PAGES === 'true' ? '/bunderstack/' : '/'

// Prerender every docs page that exists — derived from the content dir so the
// list can't rot when pages are added.
const docPages = readdirSync('content/docs')
  .filter((f) => f.endsWith('.mdx') || f.endsWith('.md'))
  .map((f) => f.replace(/\.(mdx|md)$/, ''))
  .map((name) => ({ path: name === 'index' ? '/docs' : `/docs/${name}` }))

export default defineConfig({
  base,
  server: { port: 3010 },
  plugins: [
    mdx(await import('./source.config')),
    tailwindcss(),
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tanstackStart({
      srcDirectory: 'src',
      spa: {
        enabled: true,
        prerender: { enabled: true, crawlLinks: false },
      },
      pages: [{ path: '/' }, ...docPages, { path: '/api/search' }],
    }),
    react(),
  ],
})
