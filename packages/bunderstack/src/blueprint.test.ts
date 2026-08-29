import { test, expect } from 'bun:test'

import type { BunderstackManifest } from './manifest'

import {
  blueprintFromManifest,
  parseBlueprint,
  parseBlueprintYaml,
  serializeBlueprint,
} from './blueprint'

const manifest: BunderstackManifest = {
  version: 3,
  database: {
    dialect: 'sqlite',
    migrationsDirectory: './migrations',
    tables: [
      { exportName: 'todos', physicalName: 'todos', system: false },
      {
        exportName: '_system.files',
        physicalName: 'bunderstack_file_meta',
        system: true,
      },
    ],
  },
  storage: {
    defaultBucket: 'images',
    buckets: [{ name: 'images', visibility: 'private' }],
  },
  realtime: { required: true },
  environment: [
    { key: 'PUBLIC_APP_NAME', required: false, scope: 'client' },
    { key: 'NOTIFY_COMPLETED', required: true, scope: 'server' },
  ],
  background: {
    jobs: [{ name: 'celebrateBoardComplete' }],
    cron: [
      { name: 'archiveDoneTodos', schedule: '* * * * *', timezone: 'UTC' },
    ],
    maintenance: [
      { name: 'storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' },
    ],
  },
}

test('blueprint converts a manifest to canonical YAML', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
  })
  const yaml = serializeBlueprint(blueprint)

  expect(blueprint.resources.realtime).toEqual({ required: true })
  expect(blueprint.background.worker).toEqual({ required: true })
  expect(yaml).toEndWith('\n')
  expect(yaml).toContain('schedule: "* * * * *"')
  expect(yaml).not.toContain('DATABASE_URL')
  expect(parseBlueprintYaml(yaml)).toEqual(blueprint)
  expect(serializeBlueprint(parseBlueprintYaml(yaml))).toBe(yaml)
})

test('blueprint parser rejects unsafe and duplicate declarations', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
  })
  expect(() =>
    parseBlueprint({
      ...blueprint,
      bunderstack: { ...blueprint.bunderstack, entry: '../outside.ts' },
    }),
  ).toThrow(/entry/)
  expect(() =>
    parseBlueprint({
      ...blueprint,
      environment: [...blueprint.environment, blueprint.environment[0]!],
    }),
  ).toThrow(/duplicate environment key/)
  expect(() =>
    parseBlueprint({
      ...blueprint,
      application: {
        ...blueprint.application,
        scripts: { build: 'build', start: 'start' },
      },
      background: { ...blueprint.background, worker: { required: false } },
    }),
  ).toThrow(/worker/)
  expect(() =>
    parseBlueprint({
      ...blueprint,
      resources: {
        ...blueprint.resources,
        storage: { ...blueprint.resources.storage, defaultBucket: 'missing' },
      },
    }),
  ).toThrow(/defaultBucket/)
})

test('blueprint accepts solid and bun-ssr framework declarations', () => {
  const solidBlueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    framework: 'solid',
  })
  expect(solidBlueprint.application.framework).toBe('solid')
  const yaml = serializeBlueprint(solidBlueprint)
  expect(yaml).toContain('framework: solid')
  expect(parseBlueprintYaml(yaml).application.framework).toBe('solid')
})

test('parseBlueprint keeps sections a newer generator added', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
  })
  const forward = {
    ...blueprint,
    telemetry: { operations: [{ handle: 'billing.refund' }] },
    environment: blueprint.environment.map((entry) => ({
      ...entry,
      futureFlag: true,
    })),
  }

  const parsed = parseBlueprint(forward) as unknown as Record<string, unknown>

  expect(parsed.telemetry).toEqual({
    operations: [{ handle: 'billing.refund' }],
  })
  expect((parsed.environment as Record<string, unknown>[])[0]!.futureFlag).toBe(
    true,
  )
})

test('an unknown section survives a serialize round-trip', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
  })
  const forward = { ...blueprint, telemetry: { sampleRate: 1 } }

  const yaml = serializeBlueprint(forward as never)

  expect(parseBlueprintYaml(yaml)).toEqual(parseBlueprint(forward))
})

test('open objects still require declared keys', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
  })
  const broken = {
    ...blueprint,
    resources: { database: blueprint.resources.database },
  }

  expect(() => parseBlueprint(broken)).toThrow(/storage/)
})
