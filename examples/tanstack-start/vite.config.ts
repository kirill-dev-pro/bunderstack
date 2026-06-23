import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // server: {
  //   port: 3000,
  //   fs: { allow: ['../..'] },
  // },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: [
      // 'bunderstack',
      // 'drizzle-orm',
      // 'better-auth',
      // '@better-auth/core',
      // '@libsql/client',
      // 'hono',
      // 'defu',
      // 'drizzle-kit',
      // 'drizzle-kit/api',
    ],
  },
  plugins: [
    devtools(),
    tanstackStart({
      srcDirectory: 'src',
    }),
    viteReact(),
    nitro({ preset: 'bun' }),
  ],
})
