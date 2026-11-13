// Finds and loads the module in which an application declares its backend.
// Shared by the commands that work on an application from outside it.
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isBunderstackBackend, type BunderstackBackend } from './backend'

export type AppPackage = {
  scripts?: Record<string, unknown>
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  bunderstack?: { entry?: unknown }
}

export function requireRelativePath(value: string, label: string): string {
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

export function resolveWithin(
  root: string,
  value: string,
  label: string,
): string {
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

/**
 * The entry a command works on: `--entry`, then `package.json#bunderstack.entry`,
 * then `src/bunderstack.ts`.
 */
export function entryFor(pkg: AppPackage, given: string | undefined): string {
  const configured = pkg.bunderstack?.entry
  return requireRelativePath(
    given ??
      (typeof configured === 'string' ? configured : 'src/bunderstack.ts'),
    'entry',
  )
}

/** Imports the entry afresh and returns the backend it exports. */
export async function loadBackend(
  directory: string,
  entry: string,
): Promise<BunderstackBackend<any>> {
  const entryPath = resolveWithin(directory, entry, 'entry')
  if (!(await Bun.file(entryPath).exists())) {
    throw new Error(`[bunderstack] entry does not exist: ${entry}`)
  }
  const module = (await import(
    `${pathToFileURL(entryPath).href}?bunderstack=${Date.now()}`
  )) as { backend?: unknown }
  if (!isBunderstackBackend(module.backend)) {
    throw new Error(`[bunderstack] ${entry} must export backend`)
  }
  return module.backend
}
