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

test('wrangler CLI generates, then reports current, then catches drift', async () => {
  const dir = join(tmpdir(), `bunderstack-wrangler-${crypto.randomUUID()}`)
  await mkdir(join(dir, 'src'), { recursive: true })
  try {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/Probe_App' }),
    )
    const index = join(import.meta.dir, 'index.ts')
    const libsql = join(import.meta.dir, 'database/libsql.ts')
    // The temp app has no node_modules; point it at the package's own copies.
    const sqliteCore = Bun.resolveSync(
      'drizzle-orm/sqlite-core',
      import.meta.dir,
    )
    await writeFile(
      join(dir, 'src/bunderstack.ts'),
      [
        `import { sqliteTable, text } from ${JSON.stringify(sqliteCore)}`,
        `import { bunderstack } from ${JSON.stringify(index)}`,
        `import { libsql } from ${JSON.stringify(libsql)}`,
        `const notes = sqliteTable('notes', { id: text('id').primaryKey() })`,
        `export const backend = bunderstack({ schema: { notes }, database: { adapter: libsql() } })`,
      ].join('\n'),
    )
    const output: string[] = []
    const errors: string[] = []
    const io = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    }
    expect(await runCli(['wrangler', dir], io), errors.join('\n')).toBe(0)
    expect(await runCli(['wrangler', dir, '--check'], io)).toBe(0)
    expect(output).toEqual([
      'Generated wrangler.json',
      'wrangler.json is current',
    ])
    const config = JSON.parse(
      await readFile(join(dir, 'wrangler.json'), 'utf8'),
    )
    expect(config.name).toBe('probe-app')
    expect(config.main).toBe('src/worker.ts')

    await writeFile(join(dir, 'wrangler.json'), '{}\n')
    expect(await runCli(['wrangler', dir, '--check'], io)).toBe(1)
    expect(errors.at(-1)).toContain('is out of date')
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
