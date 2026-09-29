import viteReact from '@vitejs/plugin-react'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

// SSR by default: bunderstack() adds TanStack Start and the Cloudflare plugin.
export default defineConfig({ plugins: [bunderstack(), viteReact()] })
