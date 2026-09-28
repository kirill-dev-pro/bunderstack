import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // PUBLIC_APP_NAME reaches the SPA at build time.
  envPrefix: ['VITE_', 'PUBLIC_'],
  // An SPA: the Worker serves dist/client as static assets, and
  // `bunderstack dev` proxies /api from Vite to celld.
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    bunderstack(),
  ],
})
