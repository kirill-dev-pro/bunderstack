/**
 * Publishes workspace packages whose package.json version is ahead of the
 * version on the npm registry. Run by .github/workflows/publish.yml on every
 * push to main; safe to re-run (skips anything already published).
 *
 * Usage: bun scripts/publish-changed.ts [--dry-run]
 *
 * Publishing goes through `npm publish` because the npm CLI is the client
 * that supports OIDC trusted publishing — but unlike `bun publish` it does
 * not rewrite `workspace:*` deps, so this script rewrites them in place
 * first. In CI the mutation is discarded with the runner.
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

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/**
 * Replaces `workspace:` protocol deps with concrete ranges pointing at the
 * sibling packages' current versions: `workspace:*` -> `^x.y.z`,
 * `workspace:~` -> `~x.y.z`, `workspace:^` -> `^x.y.z`.
 */
export function rewriteWorkspaceDeps<T extends PackageJson>(
  pkg: T,
  localVersions: Record<string, string>,
): T {
  const out = structuredClone(pkg)
  for (const field of DEP_FIELDS) {
    const deps = out[field]
    if (!deps) continue
    for (const [dep, range] of Object.entries(deps)) {
      if (!range.startsWith('workspace:')) continue
      const version = localVersions[dep]
      if (!version) {
        throw new Error(
          `${pkg.name}: workspace dep "${dep}" has no local version`,
        )
      }
      const operator = range.slice('workspace:'.length)
      deps[dep] = operator === '~' ? `~${version}` : `^${version}`
    }
  }
  return out
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
  const localVersions = Object.fromEntries(
    [...packages.values()].map(({ pkg }) => [pkg.name, pkg.version]),
  )

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
    const rewritten = rewriteWorkspaceDeps(pkg, localVersions)
    if (!dryRun) {
      await Bun.write(
        `${dir}/package.json`,
        JSON.stringify(rewritten, null, 2) + '\n',
      )
    }

    const args = ['publish', '--provenance']
    if (dryRun) args.push('--dry-run')
    const proc = Bun.spawn(['npm', ...args], {
      cwd: dir,
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
