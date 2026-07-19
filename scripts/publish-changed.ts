/**
 * Publishes workspace packages whose package.json version is ahead of the
 * version on the npm registry. Run by .github/workflows/publish.yml on every
 * push to main; safe to re-run (skips anything already published).
 *
 * Usage: bun scripts/publish-changed.ts [--dry-run]
 *
 * Publishing goes through `npm publish` from the root workspace so that the
 * npm CLI natively resolves `workspace:*` deps without dirtying the git tree
 * (which would break `--provenance`).
 */

// Dependency order: a package must be published before its dependents so the
// rewritten version ranges always resolve on the registry.
const PUBLISH_ORDER = [
  'bunderstack',
  'bunderstack-query',
  'bunderstack-sync',
  'bunderstack-start',
] as const

// Overridable so the script can be tested against a stub registry.
const REGISTRY = process.env.PUBLISH_REGISTRY ?? 'https://registry.npmjs.org'

type PackageJson = {
  name: string
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export function shouldPublish(
  localVersion: string,
  registryVersion: string,
): boolean {
  return Bun.semver.order(localVersion, registryVersion) === 1
}

async function registryVersion(name: string): Promise<string | null> {
  const res = await fetch(`${REGISTRY}/${name}`)
  if (res.status === 404) return null
  if (!res.ok)
    throw new Error(`registry lookup for ${name} failed: HTTP ${res.status}`)
  const data = (await res.json()) as { 'dist-tags'?: { latest?: string } }
  return data['dist-tags']?.latest ?? null
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const root = new URL('..', import.meta.url).pathname

  const packages = new Map<string, { dir: string; pkg: PackageJson }>()
  for (const name of PUBLISH_ORDER) {
    const dir = `${root}packages/${name}`
    const pkg = (await Bun.file(`${dir}/package.json`).json()) as PackageJson
    packages.set(name, { dir, pkg })
  }

  for (const name of PUBLISH_ORDER) {
    const { dir, pkg } = packages.get(name)!

    const published = await registryVersion(name)
    if (published === null) {
      throw new Error(
        `${name} has never been published. Trusted publishing cannot create a ` +
          `new package — publish ${pkg.version} manually once (\`bun publish\` ` +
          `in packages/${name}), then re-run.`,
      )
    }
    if (!shouldPublish(pkg.version, published)) {
      const note =
        pkg.version === published ? 'up to date' : `registry has ${published}`
      console.log(`skip ${name}@${pkg.version} (${note})`)
      continue
    }

    console.log(`publish ${name}@${pkg.version} (registry has ${published})`)
    const args = ['publish', '-w', `packages/${name}`, '--provenance']
    if (dryRun) args.push('--dry-run')
    const proc = Bun.spawn(['npm', ...args], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await proc.exited) !== 0) {
      throw new Error(`npm publish failed for ${name}`)
    }
  }
}

if (import.meta.main) {
  await main()
}
