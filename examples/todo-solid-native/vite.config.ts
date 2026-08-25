import solid from '@solidjs/vite-plugin'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    solid({ start: { middleware: './src/middleware.ts' }, ssr: true }),
    nitro({ serverEntry: false, preset: 'bun' }),
  ],
  server: {
    fs: { allow: ['../..'] },
  },
})
