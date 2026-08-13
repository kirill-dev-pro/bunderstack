import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

import { viteResolve } from './vite-resolve'

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: viteResolve,
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: 'src',
    }),
    viteReact(),
    nitro(),
  ],
})
