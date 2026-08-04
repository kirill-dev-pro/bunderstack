import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  ssr: {
    // Bunderstack ships TypeScript sources; Vite must transform them for SSR
    // instead of handing them to the Node resolver as external packages.
    noExternal: [/^bunderstack/],
  },
})
