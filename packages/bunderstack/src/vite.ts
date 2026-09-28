/**
 * Vite plugin for a bunderstack SPA. It builds into `dist/client`, which
 * `wrangler.json` serves as static assets, and under `bunderstack dev` it
 * proxies the API to the dev Worker.
 *
 * ```ts
 * import { bunderstack } from 'bunderstack/vite'
 * export default defineConfig({ plugins: [react(), bunderstack()] })
 * ```
 *
 * No import of `vite`: the plugin is a plain object, so the package does not
 * depend on a Vite version.
 */
export function bunderstack(options: { apiPrefix?: string } = {}) {
  const prefix = options.apiPrefix ?? '/api'
  return {
    name: 'bunderstack' as const,
    config() {
      // `bunderstack dev` sets this to the celld URL.
      const target = process.env.BUNDERSTACK_DEV_API_URL
      return {
        build: { outDir: 'dist/client' },
        ...(target
          ? {
              server: {
                proxy: {
                  // Auth checks the Origin against APP_URL, the Vite URL.
                  [prefix]: { target, changeOrigin: false },
                } as Record<string, { target: string; changeOrigin: boolean }>,
              },
            }
          : {}),
      }
    },
  }
}
