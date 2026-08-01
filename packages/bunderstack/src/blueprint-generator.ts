import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  blueprintFromManifest,
  serializeBlueprint,
  type BunderstackBlueprint,
} from './blueprint'
import { parseManifest } from './manifest'

export type GenerateBlueprintOptions = {
  directory: string
  entry?: string
  output?: string
  check?: boolean
}

export type GenerateBlueprintResult = {
  path: string
  blueprint: BunderstackBlueprint
  source: string
  changed: boolean
}

export class BlueprintCheckError extends Error {
  constructor() {
    super('bunderstack.blueprint.yaml is missing or stale; run `bunderstack blueprint`')
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
    throw new Error(`[bunderstack] ${label} must be a relative path without traversal`)
  }
  return normalized
}

function resolveWithin(root: string, value: string, label: string): string {
  const path = resolve(root, requireRelativePath(value, label))
  const pathFromRoot = relative(root, path)
  if (pathFromRoot === '..' || pathFromRoot.startsWith('../') || isAbsolute(pathFromRoot)) {
    throw new Error(`[bunderstack] ${label} must stay within the application directory`)
  }
  return path
}

function normalizeProjectPath(root: string, value: string, label: string): string {
  if (!isAbsolute(value)) return requireRelativePath(value, label)
  const pathFromRoot = relative(root, resolve(value)) || '.'
  return requireRelativePath(pathFromRoot, label)
}

function requireScript(pkg: AppPackage, name: 'build' | 'start' | 'worker', required: boolean): boolean {
  const value = pkg.scripts?.[name]
  if (typeof value === 'string' && value.trim()) return true
  if (required) throw new Error(`[bunderstack] package.json requires a non-empty "${name}" script`)
  return false
}

async function packageVersion(): Promise<string> {
  const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as { version: string }
  return pkg.version
}

export async function generateBlueprint(
  options: GenerateBlueprintOptions,
): Promise<GenerateBlueprintResult> {
  const directory = await realpath(resolve(options.directory))
  const packagePath = join(directory, 'package.json')
  const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as AppPackage
  const allDependencies = { ...pkg.dependencies, ...pkg.devDependencies }
  if (typeof allDependencies['@tanstack/react-start'] !== 'string') {
    throw new Error('[bunderstack] package.json must depend on @tanstack/react-start')
  }
  requireScript(pkg, 'build', true)
  requireScript(pkg, 'start', true)

  const configuredEntry = pkg.bunderstack?.entry
  const entry = requireRelativePath(
    options.entry ?? (typeof configuredEntry === 'string' ? configuredEntry : 'src/bunderstack.ts'),
    'entry',
  )
  const entryPath = resolveWithin(directory, entry, 'entry')
  if (!(await Bun.file(entryPath).exists())) {
    throw new Error(`[bunderstack] entry does not exist: ${entry}`)
  }
  const output = requireRelativePath(options.output ?? 'bunderstack.blueprint.yaml', 'output')
  const outputPath = resolveWithin(directory, output, 'output')

  const previousIntrospection = process.env.BUNDERSTACK_INTROSPECT
  process.env.BUNDERSTACK_INTROSPECT = '1'
  let app: { manifest?: unknown; close?: () => Promise<void> } | undefined
  try {
    const module = (await import(`${pathToFileURL(entryPath).href}?blueprint=${Date.now()}`)) as {
      app?: typeof app
    }
    app = module.app
    if (!app) throw new Error(`[bunderstack] ${entry} must export app`)
    const manifest = parseManifest(app.manifest)
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
    const migrationMode = (await Bun.file(migrationJournal).exists()) ? 'migrations' : 'push'
    const blueprint = blueprintFromManifest({
      manifest: {
        ...manifest,
        database: { ...manifest.database, migrationsDirectory },
      },
      generatorVersion: await packageVersion(),
      entry,
      migrationMode,
    })
    const source = serializeBlueprint(blueprint)
    const existing = (await Bun.file(outputPath).exists()) ? await Bun.file(outputPath).text() : undefined
    if (options.check) {
      if (existing !== source) throw new BlueprintCheckError()
      return { path: outputPath, blueprint, source, changed: false }
    }
    if (existing === source) return { path: outputPath, blueprint, source, changed: false }
    await mkdir(dirname(outputPath), { recursive: true })
    const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, source, { mode: 0o600 })
      await rename(temporary, outputPath)
    } finally {
      await rm(temporary, { force: true })
    }
    return { path: outputPath, blueprint, source, changed: true }
  } finally {
    await app?.close?.()
    if (previousIntrospection === undefined) delete process.env.BUNDERSTACK_INTROSPECT
    else process.env.BUNDERSTACK_INTROSPECT = previousIntrospection
  }
}
