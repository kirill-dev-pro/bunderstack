import { test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from './cli'
import { installSkills, SHIPPED_SKILLS } from './cli-skills'

test('blueprint CLI reports generated and current artifacts', async () => {
  const output: string[] = []
  const errors: string[] = []
  const generate = async (options: { check?: boolean }) => ({
    path: '/tmp/bunderstack.blueprint.yaml',
    blueprint: {} as never,
    source: '',
    changed: !options.check,
  })
  expect(
    await runCli(
      ['blueprint'],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
      generate as never,
    ),
  ).toBe(0)
  expect(output).toEqual(['Generated bunderstack.blueprint.yaml'])
  output.length = 0
  expect(
    await runCli(
      ['blueprint', '--check'],
      {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
      generate as never,
    ),
  ).toBe(0)
  expect(output).toEqual(['bunderstack.blueprint.yaml is current'])
  expect(errors).toEqual([])
})

test('blueprint CLI rejects invalid syntax', async () => {
  const errors: string[] = []
  expect(
    await runCli(['blueprint', '--entry'], {
      stdout: () => {},
      stderr: (line) => errors.push(line),
    }),
  ).toBe(2)
  expect(errors[0]).toContain('missing value for --entry')
})

test('skills --check reports a project that never installed them', async () => {
  const cwd = join(tmpdir(), `bs-skills-${Date.now()}`)
  await mkdir(cwd, { recursive: true })
  const out: string[] = []
  const err: string[] = []

  const code = await installSkills(
    { cwd, check: true },
    { stdout: (m) => out.push(m), stderr: (m) => err.push(m) },
  )

  expect(code).toBe(1)
  expect(err.join('\n')).toContain('bunx bunderstack skills')
  await rm(cwd, { recursive: true, force: true })
})

test('skills installs the pair, writes the pointer, and is idempotent', async () => {
  const cwd = join(tmpdir(), `bs-skills-${Date.now()}-install`)
  await mkdir(cwd, { recursive: true })
  const io = { stdout: () => {}, stderr: () => {} }

  expect(await installSkills({ cwd }, io)).toBe(0)

  for (const skill of SHIPPED_SKILLS) {
    expect(existsSync(join(cwd, '.agents/skills', skill, 'SKILL.md'))).toBe(
      true,
    )
  }

  const agents = await readFile(join(cwd, 'AGENTS.md'), 'utf8')
  expect(agents).toContain('<!-- bunderstack:skills -->')
  expect(agents).toContain('creating-bunderstack-apps/SKILL.md')
  expect(agents).toContain('node_modules/bunderstack/llms.txt')

  // A second run changes nothing, so it is safe in a postinstall or a script.
  expect(await installSkills({ cwd, check: true }, io)).toBe(0)

  await rm(cwd, { recursive: true, force: true })
})

test('skills keeps the rest of an existing AGENTS.md', async () => {
  const cwd = join(tmpdir(), `bs-skills-${Date.now()}-merge`)
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'AGENTS.md'), '# House rules\n\nUse tabs.\n')
  const io = { stdout: () => {}, stderr: () => {} }

  await installSkills({ cwd }, io)
  const agents = await readFile(join(cwd, 'AGENTS.md'), 'utf8')

  expect(agents).toContain('Use tabs.')
  expect(agents).toContain('<!-- bunderstack:skills -->')

  // Re-running replaces the block instead of appending a second one.
  await installSkills({ cwd }, io)
  const again = await readFile(join(cwd, 'AGENTS.md'), 'utf8')
  expect(again.split('<!-- bunderstack:skills -->').length - 1).toBe(1)

  await rm(cwd, { recursive: true, force: true })
})

test('wrangler CLI renders wrangler.json from the blueprint without app code', async () => {
  const dir = join(tmpdir(), `bunderstack-wrangler-${crypto.randomUUID()}`)
  await mkdir(join(dir, 'src'), { recursive: true })
  const { blueprintFromManifest, serializeBlueprint } =
    await import('./blueprint')
  const blueprint = blueprintFromManifest({
    manifest: {
      version: 4,
      database: {
        dialect: 'sqlite',
        migrationsDirectory: './migrations',
        tables: [],
      },
      storage: {
        defaultBucket: 'media',
        buckets: [{ name: 'media', visibility: 'private' }],
      },
      realtime: { required: false },
      messaging: { channels: [] },
      environment: [],
      api: { operations: [] },
      background: { jobs: [], cron: [], maintenance: [] },
    },
    generatorVersion: '1.0.0-beta.3',
    entry: 'src/bunderstack.ts',
    migrationMode: 'push',
    worker: {
      main: 'src/worker.ts',
      compatibilityDate: '2026-09-28',
      assets: 'public',
    },
  })
  const output: string[] = []
  const errors: string[] = []
  const io = {
    stdout: (m: string) => output.push(m),
    stderr: (m: string) => errors.push(m),
  }
  try {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/My App' }),
    )
    await writeFile(
      join(dir, 'src/bunderstack.ts'),
      "throw new Error('app code loaded')\n",
    )
    expect(await runCli(['wrangler', dir], io)).toBe(1)
    expect(errors.join('\n')).toContain('run `bunderstack blueprint`')

    await writeFile(
      join(dir, 'bunderstack.blueprint.yaml'),
      serializeBlueprint(blueprint),
    )
    errors.length = 0
    expect(await runCli(['wrangler', dir], io), errors.join('\n')).toBe(0)
    expect(await runCli(['wrangler', dir], io)).toBe(0)
    expect(output.slice(-2)).toEqual([
      'Generated wrangler.json',
      'wrangler.json is current',
    ])
    const config = JSON.parse(
      await readFile(join(dir, 'wrangler.json'), 'utf8'),
    )
    expect(config.name).toBe('my-app')
    expect(config.compatibility_date).toBe('2026-09-28')
    expect(config.assets.directory).toBe('public')
    expect(config.r2_buckets).toEqual([
      { binding: 'BUCKET_MEDIA', bucket_name: 'my-app-media' },
    ])

    expect(await runCli(['wrangler', dir, '--check'], io)).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('wrangler CLI rejects invalid syntax', async () => {
  const errors: string[] = []
  expect(
    await runCli(['wrangler', '--name'], {
      stdout: () => {},
      stderr: (line) => errors.push(line),
    }),
  ).toBe(2)
  expect(errors[0]).toContain('missing value for --name')
})

test('dev and build CLI pass the directory and port to the commands', async () => {
  const calls: unknown[] = []
  const commands = {
    dev: async (options: unknown) => (calls.push(['dev', options]), 0),
    build: async (options: unknown) => (calls.push(['build', options]), 0),
  }
  const io = { stdout: () => {}, stderr: () => {} }
  expect(
    await runCli(['dev', 'app', '--port', '4000'], io, undefined, commands),
  ).toBe(0)
  expect(await runCli(['build'], io, undefined, commands)).toBe(0)
  expect(calls).toEqual([
    ['dev', { directory: 'app', port: 4000 }],
    ['build', { directory: process.cwd() }],
  ])
})

test('dev CLI rejects invalid syntax', async () => {
  const errors: string[] = []
  const io = { stdout: () => {}, stderr: (line: string) => errors.push(line) }
  const commands = { dev: async () => 0, build: async () => 0 }
  expect(await runCli(['dev', '--port', 'x'], io, undefined, commands)).toBe(2)
  expect(await runCli(['dev', '--open'], io, undefined, commands)).toBe(2)
  expect(await runCli(['build', '--port', '1'], io, undefined, commands)).toBe(
    2,
  )
  expect(errors).toEqual([
    '[bunderstack] --port needs a port number',
    '[bunderstack] unknown option: --open',
    '[bunderstack] unknown option: --port',
  ])
})
