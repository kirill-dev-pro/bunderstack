import { afterEach, expect, test } from 'bun:test'
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { binaryTarget, resolveBinary, type Pins } from './binaries'

const dirs: string[] = []
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-binaries-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

function fakeFetch(body: Uint8Array) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return new Response(new Uint8Array(body))
  }
  return { fetch, calls }
}

const script = new TextEncoder().encode('#!/bin/sh\necho fake\n')
const target = { platform: 'darwin', arch: 'arm64' } as const

test('binaryTarget maps platforms to release targets', () => {
  expect(binaryTarget('darwin', 'arm64')).toBe('aarch64-apple-darwin')
  expect(binaryTarget('linux', 'x64')).toBe('x86_64-unknown-linux-gnu')
  expect(binaryTarget('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu')
  expect(binaryTarget('win32', 'x64')).toBeUndefined()
})

test('an env override wins and downloads nothing', async () => {
  const { fetch, calls } = fakeFetch(script)
  const path = await resolveBinary('celld', {
    env: { BUNDERSTACK_CELLD_BIN: '/opt/celld' },
    cacheDir: await tempDir(),
    fetch,
  })
  expect(path).toBe('/opt/celld')
  expect(calls).toEqual([])
})

test('an unsupported target names the env override', async () => {
  const promise = resolveBinary('celld', {
    env: {},
    cacheDir: await tempDir(),
    platform: 'darwin',
    arch: 'x64', // celld has no Intel macOS build
  })
  await expect(promise).rejects.toThrow('BUNDERSTACK_CELLD_BIN')
})

test('a gz asset is checked, extracted once, and cached', async () => {
  const gz = Bun.gzipSync(script)
  const pins: Pins = {
    celld: {
      version: 'v9',
      format: 'gz',
      url: (t) => `https://example.test/celld-${t}.gz`,
      sha256: { 'aarch64-apple-darwin': sha256(gz) },
    },
  }
  const cacheDir = await tempDir()
  const { fetch, calls } = fakeFetch(gz)
  const options = { env: {}, cacheDir, fetch, pins, ...target }
  const path = await resolveBinary('celld', options)
  expect(await Bun.file(path).text()).toBe(new TextDecoder().decode(script))
  await access(path, constants.X_OK)
  expect(await resolveBinary('celld', options)).toBe(path)
  expect(calls).toEqual(['https://example.test/celld-aarch64-apple-darwin.gz'])
})

test('a checksum mismatch fails and caches nothing', async () => {
  const pins: Pins = {
    celld: {
      version: 'v9',
      format: 'gz',
      url: () => 'https://example.test/celld.gz',
      sha256: { 'aarch64-apple-darwin': '0'.repeat(64) },
    },
  }
  const cacheDir = await tempDir()
  const { fetch } = fakeFetch(Bun.gzipSync(script))
  await expect(
    resolveBinary('celld', { env: {}, cacheDir, fetch, pins, ...target }),
  ).rejects.toThrow('checksum')
  expect(await readdir(cacheDir)).toEqual([])
})

test('a tar.xz asset yields the sqld executable inside it', async () => {
  const work = await tempDir()
  await mkdir(join(work, 'libsql-server-aarch64-apple-darwin'))
  await Bun.write(join(work, 'libsql-server-aarch64-apple-darwin/sqld'), script)
  const archive = join(work, 'sqld.tar.xz')
  const tar = Bun.spawnSync(
    ['tar', '-cJf', archive, 'libsql-server-aarch64-apple-darwin'],
    { cwd: work },
  )
  expect(tar.exitCode).toBe(0)
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer())
  const pins: Pins = {
    sqld: {
      version: 'v9',
      format: 'tar.xz',
      url: () => 'https://example.test/sqld.tar.xz',
      sha256: { 'aarch64-apple-darwin': sha256(bytes) },
    },
  }
  const { fetch } = fakeFetch(bytes)
  const path = await resolveBinary('sqld', {
    env: {},
    cacheDir: await tempDir(),
    fetch,
    pins,
    ...target,
  })
  expect(path.endsWith('/sqld')).toBe(true)
  await access(path, constants.X_OK)
})
