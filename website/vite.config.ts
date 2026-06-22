import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import mdx from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'

const base =
  process.env.GITHUB_PAGES === 'true' ? '/bunderstack/' : '/'

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
      pages: [
        { path: '/' },
        { path: '/docs' },
        { path: '/docs/getting-started' },
        { path: '/docs/configuration' },
        { path: '/docs/crud' },
        { path: '/docs/auth' },
        { path: '/docs/storage' },
        { path: '/docs/thumbnails' },
        { path: '/docs/framework-portability' },
        { path: '/docs/api-reference' },
        { path: '/api/search' },
      ],
    }),
    react(),
  ],
})
