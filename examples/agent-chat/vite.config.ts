import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // PUBLIC_APP_NAME reaches the SPA at build time.
  envPrefix: ['VITE_', 'PUBLIC_'],
  // The app runs as a Worker in dev and in the build; see bunderstack().
  plugins: [
    bunderstack(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
  ],
})
