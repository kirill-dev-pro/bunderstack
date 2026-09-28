// Subprocess of `bunderstack dev`: `bun push.ts <app directory>`. A fresh
// process sees the current app code on each run. It regenerates wrangler.json
// and pushes the schema (or applies committed migrations) to the dev database.
import { loadBackend, runWranglerCommand } from '../workers/wrangler'

const directory = process.argv[2]
if (!directory) throw new Error('usage: push.ts <app directory>')

const wrangler = await runWranglerCommand({ directory })
if (wrangler.changed) console.log('wrangler.json updated')

const { backend } = await loadBackend(directory)
// Resolve from the app, so provision sees the same bunderstack instance as
// the backend it provisions.
const { provision } = (await import(
  Bun.resolveSync('bunderstack/provision-schema', directory)
)) as typeof import('../provision-schema')
const app = (await backend.start({
  env: process.env as Record<string, string | undefined>,
})) as { close(): Promise<void> }
try {
  await provision(app)
  console.log('schema is current')
} finally {
  await app.close()
}
