/**
 * Runs one Bun.build and reports the result as JSON on stdout.
 *
 * This exists as a separate process on purpose. Calling Bun.build() inside a
 * test breaks bare-specifier resolution for every file in the built file's own
 * package that the test runner loads afterwards — so `bun test` at the repo
 * root fails to import '@tanstack/query-core', '@orpc/client', 'better-auth' &
 * co. from bunderstack-query/-start. Building out-of-process keeps the damage
 * in a process we are about to throw away.
 */
import { join } from 'node:path'

type Request = { entrypoint: string; external: string[] }

const repoRoot = join(import.meta.dir, '..')
const { entrypoint, external } = JSON.parse(
  await Bun.stdin.text(),
) as Request

const result = await Bun.build({
  entrypoints: [join(repoRoot, entrypoint)],
  target: 'browser',
  format: 'esm',
  splitting: false,
  minify: true,
  sourcemap: 'none',
  metafile: true,
  external,
  write: false,
})

if (!result.success || result.outputs.length !== 1) {
  console.log(
    JSON.stringify({
      success: false,
      logs: result.logs.map(String).join('\n'),
      outputCount: result.outputs.length,
    }),
  )
  process.exit(0)
}

const output = result.outputs[0]!
console.log(
  JSON.stringify({
    success: true,
    logs: '',
    outputCount: 1,
    text: await output.text(),
    size: output.size,
    inputs: Object.keys(result.metafile!.inputs),
  }),
)
