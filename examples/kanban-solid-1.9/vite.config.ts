import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import solid from 'vite-plugin-solid'
import { bunderstackApi } from './vite-plugin-bunderstack-api.ts'

export default defineConfig({
  plugins: [bunderstackApi(), solid(), nitro({ preset: 'bun' })],
  server: {
    port: 5174,
    fs: { allow: ['../..'] },
  },
})
