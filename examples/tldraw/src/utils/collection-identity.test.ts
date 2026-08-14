import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'vite'

import { viteResolve } from '../../vite-resolve'

const root = fileURLToPath(new URL('../..', import.meta.url))

test('sync collections use the React DB Collection runtime', async () => {
  const config = await resolveConfig(
    {
      configFile: false,
      root,
      resolve: viteResolve,
    },
    'serve',
  )
  const resolve = config.createResolver()
  const appImporter = fileURLToPath(
    new URL('../routes/canvas.tsx', import.meta.url),
  )
  const syncImporter = fileURLToPath(
    new URL(
      '../../../../packages/bunderstack-sync/src/collection.ts',
      import.meta.url,
    ),
  )

  const appRuntime = await resolve('@tanstack/db', appImporter)
  const syncRuntime = await resolve('@tanstack/db', syncImporter)

  expect(syncRuntime).toBe(appRuntime)
})
