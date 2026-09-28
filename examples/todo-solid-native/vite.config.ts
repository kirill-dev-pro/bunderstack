import solid from '@solidjs/vite-plugin'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // An SPA: the Worker serves dist/client as static assets, and
  // `bunderstack dev` proxies /api from Vite to celld.
  plugins: [solid(), bunderstack()],
})
