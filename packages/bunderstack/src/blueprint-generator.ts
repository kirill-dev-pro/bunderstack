import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  entryFor,
  loadBackend,
  requireRelativePath,
  resolveWithin,
  type AppPackage,
} from './app-entry'
import { BACKEND_INTERNALS } from './backend-internals'
import {
  blueprintFromManifest,
  serializeBlueprint,
  type BunderstackBlueprint,
} from './blueprint'
import { parseBlueprintYaml } from './blueprint'
import { createEnvProbeSources } from './env-probe'
import { assertManifestMatchesBlueprint } from './hosted-contract'
import { parseManifest } from './manifest'
import { diffManifests } from './manifest-diff'
import { checkSeed, type SeedCheck } from './seed-command'

export type GenerateBlueprintOptions = {
  directory: string
  entry?: string
  output?: string
  check?: boolean
  hostedCheck?: boolean
}

export type GenerateBlueprintResult = {
  path: string
  blueprint: BunderstackBlueprint
  source: string
  changed: boolean
  /** Present when the application declares a seed. */
  seedCheck?: SeedCheck
}

export class BlueprintCheckError extends Error {
  constructor() {
    super(
      'bunderstack.blueprint.yaml is missing or stale; run `bunderstack blueprint`',
    )
    this.name = 'BlueprintCheckError'
  }
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
  name: 'build' | 'start' | 'worker',
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
  requireScript(pkg, 'start', true)

  const entry = entryFor(pkg, options.entry)
  const output = requireRelativePath(
    options.output ?? 'bunderstack.blueprint.yaml',
    'output',
  )
  const outputPath = resolveWithin(directory, output, 'output')

  const backend = await loadBackend(directory, entry)
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
      blueprint: parseBlueprintYaml(source),
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
  const workerRequired = manifest.background.jobs.length > 0
  requireScript(pkg, 'worker', workerRequired)
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
  const blueprint = blueprintFromManifest({
    manifest: {
      ...manifest,
      database: { ...manifest.database, migrationsDirectory },
    },
    generatorVersion: await packageVersion(),
    entry,
    migrationMode,
    framework,
  })
  const source = serializeBlueprint(blueprint)
  const existing = (await Bun.file(outputPath).exists())
    ? await Bun.file(outputPath).text()
    : undefined
  if (options.check && existing !== source) throw new BlueprintCheckError()
  // A seed that no longer fits the tables stops here, with the generated
  // file and with `--check` alike, so it is a property of the commit.
  const seedCheck = manifest.database.seed
    ? await checkSeed({
        backend,
        directory,
        env: probeSources[0],
        migrationMode,
      }).catch((error) => {
        throw new Error(
          `[bunderstack] the seed does not run against this schema.\n${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        )
      })
    : undefined
  const checked = seedCheck ? { seedCheck } : {}
  if (options.check) {
    return { path: outputPath, blueprint, source, changed: false, ...checked }
  }
  if (existing === source)
    return { path: outputPath, blueprint, source, changed: false, ...checked }
  await mkdir(dirname(outputPath), { recursive: true })
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, source, { mode: 0o600 })
    await rename(temporary, outputPath)
  } finally {
    await rm(temporary, { force: true })
  }
  return { path: outputPath, blueprint, source, changed: true, ...checked }
}
