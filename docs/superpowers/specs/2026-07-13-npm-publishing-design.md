# npm publishing for bunderstack packages

Date: 2026-07-13
Status: approved

## Goal

Publish the four workspace packages — `bunderstack`, `bunderstack-query`,
`bunderstack-sync`, `bunderstack-start` — to npm, with a CI pipeline that
publishes a package whenever its `version` in git is ahead of the version on
the npm registry.

## Decisions

- **Artifact:** raw TypeScript source, no build step. `exports` keep pointing
  at `src/*.ts`. Bun-first by design; the Node-SSR caveat is documented, not
  worked around.
- **Registry:** npm only, unscoped names kept (all four are unclaimed as of
  2026-07-13). JSR deferred until there is demand.
- **Release model:** publish-on-version-bump. Version numbers are edited by
  hand in normal commits/PRs; CI compares git vs registry and publishes
  anything that is ahead. No changesets, no auto-generated changelogs.
- **Auth:** npm trusted publishing (OIDC from GitHub Actions). No long-lived
  token; packages get provenance. First publish of each package is manual
  because trusted publishing cannot create a new package.
- **License:** MIT.

## Components

### 1. Package manifest prep (all four packages)

Each `package.json` gains:

- `description`, `keywords`, `homepage`
- `license: "MIT"`
- `repository` with `type`, `url`
  (`https://github.com/kirill-dev-pro/bunderstack.git`) and `directory`
  (`packages/<name>`)
- `files: ["src", "!src/**/*.test.ts", "README.md", "LICENSE"]` — test files
  live alongside source in `src/`, so the negation pattern keeps them out of
  the tarball. (Also exclude `*.integration.test.ts`, covered by the same
  glob.)

Each package directory gains a short `README.md` (what the package is, install
command, link to main docs) and a `LICENSE` copy — npm does not inherit either
from the monorepo root. The root also gets a `LICENSE` (MIT); the repo
currently has none.

### 2. Publish script — `scripts/publish-changed.ts`

A Bun script, run by CI and runnable locally with `--dry-run`:

1. Iterates packages in hardcoded dependency order:
   `bunderstack` → `bunderstack-query` → `bunderstack-sync` →
   `bunderstack-start`.
2. For each package, fetches `https://registry.npmjs.org/<name>` and compares
   the `latest` dist-tag against the git `package.json` version. Equal or
   behind → skip. Ahead → publish.
3. Before publishing, rewrites `workspace:*` dependencies in the package's
   `package.json` to the sibling packages' current versions (caret-prefixed,
   e.g. `^0.1.0`). Required because publishing goes through the npm CLI (the
   OIDC-supporting client) and `npm publish` does not rewrite the workspace
   protocol. In CI the mutation is discarded with the runner; locally,
   `--dry-run` never writes.
   - *Implementation note:* check whether `bun publish` supports OIDC trusted
     publishing by now; if it does, it can replace the rewrite + `npm publish`
     pair. The rewrite approach is the guaranteed-working baseline.
4. Publishes with `npm publish --provenance`. `--dry-run` on the script maps
   to `npm publish --dry-run`.
5. A registry 404 (package never published) fails loudly, explaining that
   trusted publishing cannot create a new package and the first publish must
   be manual.

### 3. Workflow — `.github/workflows/publish.yml`

- Triggers: push to `main` touching `packages/**`, plus `workflow_dispatch`.
- Permissions: `id-token: write`, `contents: read`.
- Steps: checkout → setup Bun → `bun install` → run package tests
  (`bun run test`) → ensure npm CLI ≥ 11.5.1 (OIDC requirement; upgrade via
  `npm i -g npm` if the runner's is older) → `bun scripts/publish-changed.ts`.
- Failing tests block publishing.

### 4. One-time manual steps (owner)

1. Publish `0.1.0` of each package from a logged-in machine, in dependency
   order (`bun publish` handles the `workspace:*` rewrite locally).
2. On npmjs.com, for each package: Settings → Trusted Publisher →
   GitHub Actions, repository `kirill-dev-pro/bunderstack`, workflow
   `publish.yml`.

## Error handling

- **Idempotent:** re-running the workflow publishes nothing when versions
  match, so partial failures (first package published, second failed) are
  recovered by re-running.
- **Registry ahead of git:** skip with a warning (someone published out of
  band).
- **404:** loud failure with remediation message (see above).

## Testing

- `bun pm pack` each package and inspect the tarball: only `src/` non-test
  files + README + LICENSE, and `workspace:*` deps rewritten.
- Full `--dry-run` of the publish script locally before the first CI run.
- Known consumer caveat documented in READMEs: packages ship TS source, so
  Node-based SSR consumers may need `ssr.noExternal: [/^bunderstack/]` (or
  equivalent) in their bundler config.

## Out of scope

- JSR publishing (revisit on demand; raw-TS choice keeps it cheap to add).
- Changelogs / release notes automation.
- Publishing `examples/*` or `website` (root workspace stays `private`).
