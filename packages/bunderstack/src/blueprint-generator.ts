import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

import { isBunderstackBackend } from './backend'
import { BACKEND_INTERNALS } from './backend-internals'
import {
  blueprintFromManifest,
  parseWorkerBlueprintYaml,
  serializeBlueprint,
  WORKER_PACKAGE_ENTRIES,
  type WorkerBlueprint,
  type WorkerRender,
  type WorkerSettings,
} from './blueprint'
import { createEnvProbeSources } from './env-probe'
import { assertManifestMatchesBlueprint } from './hosted-contract'
import { parseManifest } from './manifest'
import { diffManifests } from './manifest-diff'

export type GenerateBlueprintOptions = {
  directory: string
  entry?: string
  output?: string
  check?: boolean
  hostedCheck?: boolean
  /** UTC date for a new compatibilityDate; tests pin it. */
  today?: string
}

export type GenerateBlueprintResult = {
  path: string
  blueprint: WorkerBlueprint
  source: string
  changed: boolean
}

export class BlueprintCheckError extends Error {
  constructor() {
    super(
      'bunderstack.blueprint.yaml is missing or stale; run `bunderstack blueprint`',
    )
    this.name = 'BlueprintCheckError'
  }
}

type AppPackage = {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  bunderstack?: { entry?: unknown }
}

function requireRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized.split('/').some((part) => !part || part === '..')
  ) {
    throw new Error(
      `[bunderstack] ${label} must be a relative path without traversal`,
    )
  }
  return normalized
}

function resolveWithin(root: string, value: string, label: string): string {
  const path = resolve(root, requireRelativePath(value, label))
  const pathFromRoot = relative(root, path)
  if (
    pathFromRoot === '..' ||
    pathFromRoot.startsWith('../') ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(
      `[bunderstack] ${label} must stay within the application directory`,
    )
  }
  return path
}

function normalizeProjectPath(
  root: string,
  value: string,
  label: string,
): string {
  if (!isAbsolute(value)) return requireRelativePath(value, label)
  const pathFromRoot = relative(root, resolve(value)) || '.'
  return requireRelativePath(pathFromRoot, label)
}

function requireScript(
  pkg: AppPackage,
  name: 'build',
  required: boolean,
): boolean {
  const value = pkg.scripts?.[name]
  if (typeof value === 'string' && value.trim()) return true
  if (required)
    throw new Error(
      `[bunderstack] package.json requires a non-empty "${name}" script`,
    )
  return false
}

async function readText(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined)
}

/**
 * Worker settings survive regeneration: the committed blueprint wins, then an
 * old wrangler.json (apps from beta.1 and beta.2), then the defaults.
 */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

async function workerSettings(
  directory: string,
  existing: string | undefined,
  today: string,
  hasStart: boolean,
): Promise<WorkerSettings> {
  let fromBlueprint: Partial<WorkerSettings> = {}
  try {
    const raw = parse(existing ?? '') as {
      application?: { worker?: Partial<WorkerSettings> }
    } | null
    fromBlueprint = raw?.application?.worker ?? {}
  } catch {}
  let fromWrangler: Partial<WorkerSettings> = {}
  try {
    const raw = JSON.parse(
      (await readText(join(directory, 'wrangler.json'))) ?? 'null',
    ) as {
      main?: string
      compatibility_date?: string
      assets?: { directory?: string }
    } | null
    fromWrangler = {
      main: raw?.main,
      compatibilityDate: raw?.compatibility_date,
      assets: raw?.assets?.directory,
    }
  } catch {}
  const pick = (key: keyof WorkerSettings, fallback: string) => {
    const value = fromBlueprint[key] ?? fromWrangler[key]
    return typeof value === 'string' && value ? value : fallback
  }
  const render: WorkerRender =
    fromBlueprint.render === 'ssr' || fromBlueprint.render === 'spa'
      ? fromBlueprint.render
      : hasStart
        ? 'ssr'
        : 'spa'
  // An old wrangler.json names src/worker.ts; keep it only while it exists.
  if (
    fromWrangler.main &&
    !(WORKER_PACKAGE_ENTRIES as readonly string[]).includes(
      fromWrangler.main,
    ) &&
    !(await exists(join(directory, fromWrangler.main)))
  ) {
    fromWrangler.main = undefined
  }
  const defaultMain = (await exists(join(directory, 'src/server.ts')))
    ? 'src/server.ts'
    : render === 'ssr'
      ? 'bunderstack/start/server-entry'
      : 'bunderstack/workers/entry'
  return {
    render,
    main: pick('main', defaultMain),
    compatibilityDate: pick('compatibilityDate', today),
    assets: pick('assets', 'dist/client'),
  }
}

async function packageVersion(): Promise<string> {
  const pkg = (await Bun.file(
    new URL('../package.json', import.meta.url),
  ).json()) as { version: string }
  return pkg.version
}

export async function generateBlueprint(
  options: GenerateBlueprintOptions,
): Promise<GenerateBlueprintResult> {
  const directory = await realpath(resolve(options.directory))
  const packagePath = join(directory, 'package.json')
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as AppPackage
  const allDependencies = { ...pkg.dependencies, ...pkg.devDependencies }
  let framework: 'tanstack-start' | 'solid' | 'bun-ssr' = 'bun-ssr'
  if (typeof allDependencies['@tanstack/react-start'] === 'string') {
    framework = 'tanstack-start'
  } else if (
    typeof allDependencies['solid-js'] === 'string' ||
    typeof allDependencies['@solidjs/web'] === 'string'
  ) {
    framework = 'solid'
  }
  requireScript(pkg, 'build', true)

  const configuredEntry = pkg.bunderstack?.entry
  const entry = requireRelativePath(
    options.entry ??
      (typeof configuredEntry === 'string'
        ? configuredEntry
        : 'src/bunderstack.ts'),
    'entry',
  )
  const entryPath = resolveWithin(directory, entry, 'entry')
  if (!(await Bun.file(entryPath).exists())) {
    throw new Error(`[bunderstack] entry does not exist: ${entry}`)
  }
  const output = requireRelativePath(
    options.output ?? 'bunderstack.blueprint.yaml',
    'output',
  )
  const outputPath = resolveWithin(directory, output, 'output')

  const module = (await import(
    `${pathToFileURL(entryPath).href}?blueprint=${Date.now()}`
  )) as { backend?: unknown }
  const backend = module.backend
  if (!isBunderstackBackend(backend)) {
    throw new Error(`[bunderstack] ${entry} must export backend`)
  }
  if (options.hostedCheck) {
    const file = Bun.file(outputPath)
    if (!(await file.exists())) {
      throw new Error(
        `[bunderstack] hosted blueprint does not exist: ${output}`,
      )
    }
    const source = await file.text()
    const manifest = parseManifest(backend.inspect({ env: process.env }))
    assertManifestMatchesBlueprint(manifest, source)
    return {
      path: outputPath,
      blueprint: parseWorkerBlueprintYaml(source),
      source,
      changed: false,
    }
  }
  const probeSources = createEnvProbeSources(
    backend[BACKEND_INTERNALS].envSchema,
    process.env as Record<string, string | undefined>,
  )
  const firstManifest = parseManifest(backend.inspect({ env: probeSources[0] }))
  const secondManifest = parseManifest(
    backend.inspect({ env: probeSources[1] }),
  )
  const differences = diffManifests(firstManifest, secondManifest)
  if (differences.length > 0) {
    throw new Error(
      '[bunderstack] environment-dependent blueprint shape:\n' +
        differences.map(({ kind, path }) => `  - ${kind}: ${path}`).join('\n'),
    )
  }
  const manifest = firstManifest
  const migrationsDirectory = normalizeProjectPath(
    directory,
    manifest.database.migrationsDirectory,
    'migrationsDirectory',
  )
  const migrationJournal = join(
    resolveWithin(directory, migrationsDirectory, 'migrationsDirectory'),
    'meta',
    '_journal.json',
  )
  const migrationMode = (await Bun.file(migrationJournal).exists())
    ? 'migrations'
    : 'push'
  const existing = await readText(outputPath)
  const blueprint = blueprintFromManifest({
    manifest: {
      ...manifest,
      database: { ...manifest.database, migrationsDirectory },
    },
    generatorVersion: await packageVersion(),
    entry,
    migrationMode,
    framework,
    worker: await workerSettings(
      directory,
      existing,
      options.today ?? new Date().toISOString().slice(0, 10),
      typeof allDependencies['@tanstack/react-start'] === 'string',
    ),
  })
  const source = serializeBlueprint(blueprint)
  if (options.check) {
    if (existing !== source) throw new BlueprintCheckError()
    return { path: outputPath, blueprint, source, changed: false }
  }
  if (existing === source)
    return { path: outputPath, blueprint, source, changed: false }
  await mkdir(dirname(outputPath), { recursive: true })
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, source, { mode: 0o600 })
    await rename(temporary, outputPath)
  } finally {
    await rm(temporary, { force: true })
  }
  return { path: outputPath, blueprint, source, changed: true }
}
