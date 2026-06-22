import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import mdx from 'fumadocs-mdx/vite'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
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
        prerender: { enabled: true, crawlLinks: true },
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
      ],
    }),
    react(),
  ],
})
