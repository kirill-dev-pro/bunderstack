import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateBlueprint } from '../blueprint-generator'
import { cleanArtifact, firstFreePort, planDev, runBuild } from './index'

test('firstFreePort skips a port that is taken on 127.0.0.1', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const taken = (server.address() as { port: number }).port
  try {
    expect(await firstFreePort(taken)).toBeGreaterThan(taken)
  } finally {
    server.close()
  }
})

const base = {
  directory: '/app',
  stateDir: '/app/.bunderstack/dev',
  ports: { app: 5173, db: 9002 },
  binaries: { sqld: '/bin/sqld' },
}

test('dev runs sqld and Vite; no celld', () => {
  const plan = planDev({ ...base, userEnv: {} })
  expect(plan.appUrl).toBe('http://localhost:5173')
  expect(plan.databaseUrl).toBe('http://127.0.0.1:9002')
  expect(plan.sqld?.cmd[0]).toBe('/bin/sqld')
  expect(plan.vite.cmd).toContain('--strictPort')
  expect(plan.vite.cmd).toContain('5173')
  expect('worker' in plan).toBe(false)
})

test('a database URL from .env replaces sqld', () => {
  const plan = planDev({
    ...base,
    userEnv: { BUNDERSTACK_DATABASE_URL: 'libsql://team.turso.io' },
  })
  expect(plan.sqld).toBeUndefined()
  expect(plan.databaseUrl).toBe('libsql://team.turso.io')
})

test('runBuild requires a current blueprint and writes wrangler.json from it', async () => {
  const tempRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(tempRoot, 'bunderstack-build-'))
  await mkdir(join(directory, 'src'), { recursive: true })
  const index = join(import.meta.dir, '..', 'index.ts')
  const libsql = join(import.meta.dir, '..', 'database', 'libsql.ts')
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'probe-worker',
      scripts: { build: 'bunderstack build' },
      dependencies: { bunderstack: 'workspace:*' },
    }),
  )
  await writeFile(
    join(directory, 'src/bunderstack.ts'),
    [
      `import { bunderstack } from ${JSON.stringify(index)}`,
      `import { libsql } from ${JSON.stringify(libsql)}`,
      `export const backend = bunderstack({ schema: {}, database: { adapter: libsql() } })`,
    ].join('\n'),
  )
  try {
    // No blueprint: build fails before Vite.
    expect(await runBuild({ directory })).toBe(1)
    expect(await Bun.file(join(directory, 'wrangler.json')).exists()).toBe(
      false,
    )

    // A current blueprint but no Vite config: wrangler.json is written, then
    // the build stops, since a Worker app always builds through Vite.
    await generateBlueprint({ directory })
    expect(await runBuild({ directory })).toBe(1)
    const config = JSON.parse(
      await readFile(join(directory, 'wrangler.json'), 'utf8'),
    )
    expect(config.name).toBe('probe-worker')

    // A stale blueprint fails, and build does not rewrite it.
    await writeFile(join(directory, 'bunderstack.blueprint.yaml'), 'stale\n')
    expect(await runBuild({ directory })).toBe(1)
    expect(
      await readFile(join(directory, 'bunderstack.blueprint.yaml'), 'utf8'),
    ).toBe('stale\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('cleanArtifact removes .assetsignore and every .dev.vars under dist', async () => {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), 'bunderstack-art-'),
  )
  try {
    await mkdir(join(directory, 'dist/client'), { recursive: true })
    await mkdir(join(directory, 'dist/server/assets'), { recursive: true })
    await writeFile(
      join(directory, 'dist/client/.assetsignore'),
      'wrangler.json\n',
    )
    await writeFile(join(directory, 'dist/server/.dev.vars'), 'AUTH_SECRET=x\n')
    await writeFile(join(directory, 'dist/server/assets/.dev.vars'), 'X=1\n')
    await writeFile(
      join(directory, 'dist/server/index.js'),
      'export default {}\n',
    )
    const removed = await cleanArtifact(directory)
    expect(removed.sort()).toEqual([
      'dist/client/.assetsignore',
      'dist/server/.dev.vars',
      'dist/server/assets/.dev.vars',
    ])
    expect(
      await Bun.file(join(directory, 'dist/server/index.js')).exists(),
    ).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
