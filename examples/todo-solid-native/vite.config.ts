import solid from '@solidjs/vite-plugin'
import { bunderstack } from 'bunderstack/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // The app runs as a Worker in dev and in the build; see bunderstack().
  plugins: [bunderstack(), solid()],
})
