import type { BunderstackManifest } from './manifest'

import { parseBlueprintYaml } from './blueprint'
import { diffManifests } from './manifest-diff'

export class HostedBlueprintMismatchError extends Error {
  constructor(paths: readonly { kind: string; path: string }[]) {
    super(
      '[bunderstack] runtime declaration does not match the committed blueprint:\n' +
        paths.map(({ kind, path }) => `  - ${kind}: ${path}`).join('\n'),
    )
    this.name = 'HostedBlueprintMismatchError'
  }
}

export function manifestFromBlueprint(source: string): BunderstackManifest {
  const blueprint = parseBlueprintYaml(source)
  return {
    version: blueprint.bunderstack.manifestVersion,
    database: {
      dialect: blueprint.resources.database.dialect,
      migrationsDirectory: blueprint.resources.database.migrationsDirectory,
      tables: blueprint.resources.database.tables,
    },
    storage: blueprint.resources.storage,
    realtime: blueprint.resources.realtime ?? { required: false },
    messaging: blueprint.resources.messaging,
    environment: blueprint.environment.map((entry) => ({
      ...entry,
      sensitive: entry.sensitive ?? entry.scope === 'server',
    })),
    api: blueprint.api ?? { operations: [] },
    background: {
      jobs: blueprint.background.jobs,
      cron: blueprint.background.cron,
      maintenance: blueprint.background.maintenance,
    },
  }
}

export function assertManifestMatchesBlueprint(
  manifest: BunderstackManifest,
  source: string,
): void {
  const differences = diffManifests(manifestFromBlueprint(source), manifest)
  if (differences.length > 0)
    throw new HostedBlueprintMismatchError(differences)
}

export async function assertHostedBlueprintFile(
  manifest: BunderstackManifest,
  path: string,
): Promise<void> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`[bunderstack] hosted blueprint does not exist: ${path}`)
  }
  assertManifestMatchesBlueprint(manifest, await file.text())
}
