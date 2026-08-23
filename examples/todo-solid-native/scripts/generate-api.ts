/**
 * Regenerates src/api.gen.ts from the running app's OpenAPI document.
 *
 * Imports the app directly (no HTTP round trip needed): one handler call
 * against /api/openapi.json, then bunderstack's codegen emits a standalone,
 * zero-dependency typed client that this example owns like any other source
 * file.
 *
 * Run: bun scripts/generate-api.ts
 */
import { mkdirSync } from 'node:fs'

import { generateClientCode } from 'bunderstack/codegen'

import { app } from '../src/bunderstack'

const response = await app.handler(
  new Request('http://localhost/api/openapi.json'),
)
if (!response.ok) {
  throw new Error(`openapi request failed (${response.status})`)
}

const code = generateClientCode(await response.json())
mkdirSync(new URL('../src/native/', import.meta.url), { recursive: true })
await Bun.write(new URL('../src/api.gen.ts', import.meta.url), code)
console.log('wrote src/api.gen.ts')

await app.close()
