// src/vite.ts — `bunderstack()` for vite.config.ts. It runs the app as a
// Worker through the Cloudflare Vite plugin (with TanStack Start for SSR) and
// points the package Worker entries at the app's backend. No import of `vite`
// or of the plugins at module load: they are resolved from the app.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseWorkerBlueprintYaml } from './blueprint'

type Factories = {
  cloudflare: (options: { viteEnvironment: { name: string } }) => unknown
  tanstackStart: (options: { srcDirectory: string }) => unknown
}

async function appFactories(root: string, ssr: boolean): Promise<Factories> {
  const require = createRequire(join(root, 'package.json'))
  const load = async (specifier: string) =>
    import(pathToFileURL(require.resolve(specifier)).href)
  const { cloudflare } = await load('@cloudflare/vite-plugin')
  const tanstackStart = ssr
    ? (await load('@tanstack/react-start/plugin/vite')).tanstackStart
    : () => {
        throw new Error(
          '[bunderstack] TanStack Start is only used for render: ssr',
        )
      }
  return { cloudflare, tanstackStart }
}

export async function bunderstack(
  options: { root?: string; factories?: Factories } = {},
): Promise<unknown[]> {
  const root = resolve(options.root ?? process.cwd())
  let source: string
  try {
    source = await readFile(join(root, 'bunderstack.blueprint.yaml'), 'utf8')
  } catch {
    throw new Error(
      '[bunderstack] bunderstack.blueprint.yaml is missing; run `bunderstack dev` or `bunderstack blueprint` first',
    )
  }
  const blueprint = parseWorkerBlueprintYaml(source)
  const ssr = blueprint.application.worker.render === 'ssr'
  const pkg = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { bunderstack?: { entry?: string } }
  const backendEntry = join(
    root,
    pkg.bunderstack?.entry ?? 'src/bunderstack.ts',
  )
  const { cloudflare, tanstackStart } =
    options.factories ?? (await appFactories(root, ssr))
  return [
    {
      name: 'bunderstack:backend',
      resolveId(id: string) {
        if (id === 'virtual:bunderstack/backend') return backendEntry
        return undefined
      },
      config() {
        return {
          build: { outDir: 'dist/client' },
          environments: { ssr: { build: { outDir: 'dist/server' } } },
        }
      },
    },
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    ...(ssr ? [tanstackStart({ srcDirectory: 'src' })] : []),
  ]
}
