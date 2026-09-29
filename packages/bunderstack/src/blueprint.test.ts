import { test, expect } from 'bun:test'

import type { BunderstackManifest } from './manifest'

import {
  blueprintFromManifest,
  isSensitiveEnvVar,
  parseBlueprint,
  parseBlueprintYaml,
  parseWorkerBlueprint,
  serializeBlueprint,
} from './blueprint'

const manifest: BunderstackManifest = {
  version: 4,
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
  messaging: {
    channels: [{ name: 'email', kind: 'email', provider: 'resend' }],
  },
  environment: [
    {
      key: 'PUBLIC_APP_NAME',
      required: false,
      scope: 'client',
      sensitive: false,
    },
    {
      key: 'NOTIFY_COMPLETED',
      required: true,
      scope: 'server',
      sensitive: true,
    },
  ],
  api: { operations: [] },
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

const WORKER = {
  main: 'src/worker.ts',
  compatibilityDate: '2026-09-28',
  assets: 'dist/client',
}

const legacySource = {
  version: 1,
  generator: { name: 'bunderstack', version: '0.25.2' },
  application: {
    framework: 'tanstack-start',
    scripts: { build: 'build', start: 'start', worker: 'worker' },
  },
  bunderstack: { entry: 'src/bunderstack.ts', manifestVersion: 4 },
  resources: {
    database: {
      dialect: 'sqlite',
      migrationsDirectory: 'migrations',
      migrationMode: 'migrations',
      tables: [],
    },
    storage: {
      defaultBucket: 'images',
      buckets: [{ name: 'images', visibility: 'private' }],
    },
    messaging: { channels: [] },
  },
  environment: [],
  background: {
    worker: { required: true },
    jobs: [{ name: 'work' }],
    cron: [],
    maintenance: [],
  },
}

test('blueprint converts a manifest to canonical YAML', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '0.13.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    worker: WORKER,
  })
  const yaml = serializeBlueprint(blueprint)

  expect(blueprint.resources.realtime).toEqual({ required: true })
  expect(blueprint.version).toBe(2)
  expect(blueprint.application.worker).toEqual(WORKER)
  expect('worker' in blueprint.background).toBe(false)
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
    worker: WORKER,
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
    }),
  ).toThrow(/only the build script/)
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
    worker: WORKER,
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
    worker: WORKER,
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
    worker: WORKER,
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
    worker: WORKER,
  })
  const broken = {
    ...blueprint,
    resources: { database: blueprint.resources.database },
  }

  expect(() => parseBlueprint(broken)).toThrow(/storage/)
})

test('blueprint environment entries expose secrecy with a scope default', () => {
  const legacy = parseBlueprint(
    blueprintFromManifest({
      manifest: {
        ...manifest,
        environment: [
          {
            key: 'PUBLIC_APP_NAME',
            required: false,
            scope: 'client',
            sensitive: false,
          },
          {
            key: 'NOTIFY_COMPLETED',
            required: true,
            scope: 'server',
            sensitive: true,
            description: 'Webhook token used to announce completed todos',
          },
        ],
      },
      generatorVersion: '0.23.0',
      entry: 'src/bunderstack.ts',
      migrationMode: 'migrations',
      worker: WORKER,
    }),
  )

  expect(legacy.environment[0]).toEqual({
    key: 'NOTIFY_COMPLETED',
    required: true,
    scope: 'server',
    sensitive: true,
    description: 'Webhook token used to announce completed todos',
  })
  expect(isSensitiveEnvVar(legacy.environment[0]!)).toBe(true)
})

test('a blueprint written before the flag falls back to scope', () => {
  expect(
    isSensitiveEnvVar({ key: 'STRIPE_KEY', required: true, scope: 'server' }),
  ).toBe(true)
  expect(
    isSensitiveEnvVar({
      key: 'PUBLIC_APP_NAME',
      required: true,
      scope: 'client',
    }),
  ).toBe(false)
})

test('the blueprint carries application operations and survives their absence', () => {
  const withApi = blueprintFromManifest({
    manifest: {
      ...manifest,
      api: {
        operations: [
          {
            handle: 'billing.refund',
            operationId: 'billing.refund',
            effect: 'mutation',
            method: 'POST',
            path: '/api/billing/refund',
          },
        ],
      },
    },
    generatorVersion: '0.23.0',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    worker: WORKER,
  })

  expect(withApi.api?.operations[0]?.effect).toBe('mutation')
  expect(parseBlueprintYaml(serializeBlueprint(withApi))).toEqual(withApi)

  const { api: _api, ...legacy } = withApi
  expect(parseBlueprint(legacy).api).toBeUndefined()
})

test('a 0.25.x version 1 blueprint still parses as the legacy contract', () => {
  const legacy = parseBlueprint(legacySource)
  expect(legacy.version).toBe(1)
  if (legacy.version !== 1) throw new Error('unreachable')
  expect(legacy.application.scripts.start).toBe('start')
  expect(legacy.background.worker).toEqual({ required: true })
  expect(parseBlueprintYaml(serializeBlueprint(legacy))).toEqual(legacy)
})

test('parseWorkerBlueprint rejects a version 1 blueprint with the upgrade step', () => {
  expect(() => parseWorkerBlueprint(legacySource)).toThrow(
    /run `bunderstack dev` or `bunderstack blueprint`/,
  )
})

test('a beta.2 version 1 blueprint with runtime: worker must be regenerated', () => {
  expect(() =>
    parseBlueprint({
      ...legacySource,
      application: {
        runtime: 'worker',
        framework: 'solid',
        scripts: { build: 'build' },
      },
    }),
  ).toThrow(/regenerate the blueprint with bunderstack 1.0.0-beta.3/)
})

test('version 2 requires application.worker with safe paths and a date', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '1.0.0-beta.3',
    entry: 'src/bunderstack.ts',
    migrationMode: 'migrations',
    worker: WORKER,
  })
  const { worker: _worker, ...application } = blueprint.application
  expect(() => parseBlueprint({ ...blueprint, application })).toThrow()
  for (const worker of [
    { ...WORKER, main: '../worker.ts' },
    { ...WORKER, assets: '/abs' },
    { ...WORKER, compatibilityDate: '28.09.2026' },
  ]) {
    expect(() =>
      parseBlueprint({
        ...blueprint,
        application: { ...blueprint.application, worker },
      }),
    ).toThrow()
  }
  expect(() =>
    parseBlueprint({
      ...blueprint,
      application: {
        ...blueprint.application,
        scripts: { build: 'build', start: 'start' },
      },
    }),
  ).toThrow(/version 2 blueprint declares only the build script/)
})

test('version 2 serializes the worker section and round-trips', () => {
  const blueprint = blueprintFromManifest({
    manifest,
    generatorVersion: '1.0.0-beta.3',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
    framework: 'solid',
    worker: WORKER,
  })
  const yaml = serializeBlueprint(blueprint)
  expect(yaml).toStartWith('version: 2\n')
  expect(yaml).toMatch(/compatibilityDate: "?2026-09-28"?\n/)
  expect(yaml).not.toContain('runtime:')
  expect(parseWorkerBlueprint(parseBlueprintYaml(yaml))).toEqual(blueprint)
})
