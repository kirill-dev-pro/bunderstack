// Pinned celld and sqld binaries for `bunderstack dev`. The first run
// downloads them to ~/.cache/bunderstack and checks their sha256; an env var
// selects a system binary instead.
import {
  access,
  chmod,
  constants,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BinaryName = 'celld' | 'sqld'

export type Pin = {
  version: string
  format: 'gz' | 'tar.xz'
  url: (target: string) => string
  /** sha256 of the downloaded asset, per release target. */
  sha256: Partial<Record<string, string>>
}

export type Pins = Partial<Record<BinaryName, Pin>>

const PINS: Record<BinaryName, Pin> = {
  celld: {
    version: 'v0.6.0',
    format: 'gz',
    url: (target) =>
      `https://github.com/denoland/celld/releases/download/v0.6.0/celld-${target}.gz`,
    sha256: {
      'aarch64-apple-darwin':
        'bf6f0c06c4f815eecddf61ae40340935a0dbf76be3d643bf75fdd92bfac425cd',
      'aarch64-unknown-linux-gnu':
        '3d4945df3abcc6832b6e7fa978b9ee3c26e46a0b7791924843d42c0ed14eff96',
      'x86_64-unknown-linux-gnu':
        '8f1e18072c234ab75459d4da104c13cebc9b29a3e4a4772086bf985829bea8aa',
    },
  },
  sqld: {
    version: 'v0.24.32',
    format: 'tar.xz',
    url: (target) =>
      `https://github.com/tursodatabase/libsql/releases/download/libsql-server-v0.24.32/libsql-server-${target}.tar.xz`,
    sha256: {
      'aarch64-apple-darwin':
        'ced2a9d65a5d4b6bd72c67e98ad6c63139e2a139d91769f07fdd15be935381dd',
      'x86_64-apple-darwin':
        '461480ea5a17781bab7dd5974aa804007434611baced37b6349c8060d0648e34',
      'aarch64-unknown-linux-gnu':
        '37f9eee45b388a30192907ecf4565b93df945c079331657073b5b3caf8bb1cd0',
      'x86_64-unknown-linux-gnu':
        '71720fc8648c19efef416efebd47145ef59b62e198770533530a858e1336879f',
    },
  },
}

export type ResolveOptions = {
  env?: Record<string, string | undefined>
  cacheDir?: string
  platform?: string
  arch?: string
  fetch?: (url: string) => Promise<Response>
  log?: (message: string) => void
  /** Replaces the pinned table; for tests. */
  pins?: Pins
}

export function binaryTarget(platform: string, arch: string) {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : ''
  if (!cpu) return undefined
  if (platform === 'darwin') return `${cpu}-apple-darwin`
  if (platform === 'linux') return `${cpu}-unknown-linux-gnu`
  return undefined
}

async function isExecutable(path: string) {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

async function findFile(
  dir: string,
  name: string,
): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findFile(path, name)
      if (found) return found
    } else if (entry.name === name) {
      return path
    }
  }
  return undefined
}

export async function resolveBinary(
  name: BinaryName,
  options: ResolveOptions = {},
): Promise<string> {
  const env = options.env ?? process.env
  const envName = `BUNDERSTACK_${name.toUpperCase()}_BIN`
  const override = env[envName]
  if (override) return override

  const pin = (options.pins ?? PINS)[name]
  const target = binaryTarget(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  )
  const checksum = target ? pin?.sha256[target] : undefined
  if (!pin || !target || !checksum) {
    throw new Error(
      `[bunderstack] no ${name} build for ${options.platform ?? process.platform} ${options.arch ?? process.arch}; install ${name} and set ${envName} to its path`,
    )
  }

  const cacheDir =
    options.cacheDir ??
    env.BUNDERSTACK_CACHE_DIR ??
    join(homedir(), '.cache', 'bunderstack')
  const home = join(cacheDir, `${name}-${pin.version}-${target}`)
  const cached = await findFile(home, name).catch(() => undefined)
  if (cached && (await isExecutable(cached))) return cached

  const url = pin.url(target)
  options.log?.(`downloading ${name} ${pin.version} from ${url}`)
  const response = await (options.fetch ?? fetch)(url)
  if (!response.ok) {
    throw new Error(`[bunderstack] ${url} returned ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (actual !== checksum) {
    throw new Error(
      `[bunderstack] ${name} checksum mismatch: expected ${checksum}, got ${actual}`,
    )
  }

  await mkdir(cacheDir, { recursive: true })
  const staging = await mkdtemp(join(cacheDir, `.${name}-`))
  try {
    if (pin.format === 'gz') {
      await Bun.write(join(staging, name), Bun.gunzipSync(bytes))
    } else {
      const archive = join(staging, 'asset.tar.xz')
      await Bun.write(archive, bytes)
      const tar = Bun.spawnSync(['tar', '-xJf', archive], { cwd: staging })
      if (tar.exitCode !== 0) {
        throw new Error(`[bunderstack] tar failed: ${tar.stderr.toString()}`)
      }
      await rm(archive)
    }
    const binary = await findFile(staging, name)
    if (!binary) throw new Error(`[bunderstack] ${url} has no ${name} file`)
    await chmod(binary, 0o755)
    // Another run may have finished first; keep its copy.
    if (!(await stat(home).catch(() => undefined))) {
      await rename(staging, home)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const path = await findFile(home, name)
  if (!path) throw new Error(`[bunderstack] ${name} is missing from ${home}`)
  return path
}
