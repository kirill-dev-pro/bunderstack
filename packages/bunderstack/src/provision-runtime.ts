import { access, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Dialect } from './dialect'

import {
  PROVISION_INTERNALS,
  type WithProvisionInternals,
} from './provision-internals'

/** Create the local backing directory for file-based urls, per dialect. */
export async function ensureLocalDataDir(
  url: string,
  dialect: Dialect,
): Promise<void> {
  if (dialect === 'pg') {
    if (/^postgres(ql)?:\/\//.test(url)) return
    const raw = url.startsWith('file:') ? url.slice('file:'.length) : url
    if (raw === ':memory:' || raw.startsWith('memory://')) return
    await mkdir(raw, { recursive: true })
    return
  }
  const match = /^file:(.+)$/.exec(url)
  if (!match) return
  const filePath = match[1]!
  if (filePath === ':memory:') return
  await mkdir(dirname(filePath), { recursive: true })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function getProvisionInternals(app: object) {
  const internals = (app as WithProvisionInternals)[PROVISION_INTERNALS]
  if (!internals) {
    throw new Error(
      '[bunderstack] provision() expects the app returned by bunderstack().',
    )
  }
  return internals
}

/** Apply committed migrations, returning false when no journal exists. */
export async function applyCommittedMigrations(app: object): Promise<boolean> {
  const internals = getProvisionInternals(app)
  const { db, databaseUrl, migrationsFolder, dialect, adapter } = internals
  const journal = join(migrationsFolder, 'meta', '_journal.json')
  if (!(await exists(journal))) return false

  await ensureLocalDataDir(databaseUrl, dialect)
  await adapter.migrate(db as never, migrationsFolder)
  return true
}
