// src/vite.ts — `bunderstack()` for vite.config.ts. It runs the app as a
// Worker through the Cloudflare Vite plugin (with TanStack Start for SSR) and
// points the package Worker entries at the app's backend. No import of `vite`
// or of the plugins at module load: they are resolved from the app.
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseWorkerBlueprintYaml } from './blueprint'

type Factories = {
  cloudflare: (options: { viteEnvironment: { name: string } }) => unknown
  tanstackStart: (options: { srcDirectory: string }) => unknown
}

/** An ESM condition target: a string or a nested `import`/`default` map. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>
    return exportTarget(map.import) ?? exportTarget(map.default)
  }
  return undefined
}

/**
 * Resolves a package specifier from the app, not from bunderstack, so the
 * plugins are the app's own versions. The Vite plugins are ESM-only, which
 * `createRequire().resolve` cannot resolve under Node.
 */
export async function resolveFromApp(
  root: string,
  specifier: string,
): Promise<string> {
  const bun = (
    globalThis as { Bun?: { resolveSync(s: string, from: string): string } }
  ).Bun
  if (bun) return bun.resolveSync(specifier, root)
  const parts = specifier.split('/')
  const name = specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]!
  const subpath = `.${specifier.slice(name.length)}`
  for (let dir = root; ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', name)
    const pkgText = await readFile(join(pkgDir, 'package.json'), 'utf8').catch(
      () => undefined,
    )
    if (pkgText) {
      const pkg = JSON.parse(pkgText) as { exports?: unknown; main?: string }
      const exportsMap =
        typeof pkg.exports === 'object' && pkg.exports && subpath in pkg.exports
          ? (pkg.exports as Record<string, unknown>)[subpath]
          : subpath === '.'
            ? pkg.exports
            : undefined
      const target =
        exportTarget(exportsMap) ?? (subpath === '.' ? pkg.main : undefined)
      if (!target) break
      return join(pkgDir, target)
    }
    if (dirname(dir) === dir) break
  }
  throw new Error(
    `[bunderstack] cannot resolve ${specifier} from ${root}; install it`,
  )
}

async function appFactories(root: string, ssr: boolean): Promise<Factories> {
  const load = async (specifier: string) =>
    import(pathToFileURL(await resolveFromApp(root, specifier)).href)
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
        // The artifact shape hosts deploy, in both render modes.
        return {
          environments: {
            client: { build: { outDir: 'dist/client' } },
            ssr: { build: { outDir: 'dist/server' } },
          },
        }
      },
    },
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    ...(ssr ? [tanstackStart({ srcDirectory: 'src' })] : []),
  ]
}
