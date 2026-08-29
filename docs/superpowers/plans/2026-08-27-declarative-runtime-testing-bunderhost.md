# Bunderhost Declarative Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the new Bunderstack declaration/testing contract in Bunderhost and delete its generic application, database, cleanup, auth transport, RPC, and job test harness code.

**Architecture:** Bunderhost exports one static `backend` declaration and starts it only from runtime/migration entry modules. Tests own `backend.test()` fixtures lexically and retain only a small organization-aware domain helper layered over the framework identity/client. This plan runs after the framework plan and in the separate `../bunderhost` Git repository.

**Tech Stack:** Bun, TypeScript 5.9, Bunderstack declarative-runtime beta, Better Auth, Drizzle/libSQL, `bun:test`.

**Spec:** `../bunderstack/docs/superpowers/specs/2026-08-27-declarative-runtime-testing-design.md`

## Global Constraints

- Do not execute this plan while the current Bunderhost layout refactor is uncommitted; preserve that work as its own commit first.
- Install the exact Bunderstack version produced by the framework plan; do not emulate the new API locally.
- Keep Fly, Turso, Tigris, GitHub, SSH, and other domain fakes.
- Delete `makeApp`, `makeTestApp`, the process-global resource registry, Bun preload, and per-file app arrays/hooks.
- Use `await using fixture = await backend.test()` in every test that owns an app.
- Keep organization behavior in Bunderhost code; do not add organization assumptions back to `bunderstack/testing`.
- Explicit fixture env replaces ambient env and must preserve tests that assert credentials are absent.

---

### Task 1: Install the new package and declare the control-plane backend

**Files:**
- Modify: `../bunderhost/package.json:40-48`
- Modify: `../bunderhost/bun.lock`
- Modify: `../bunderhost/src/bunderstack/index.ts:1-59`
- Modify: `../bunderhost/src/bunderstack/app.ts:1-6`
- Modify: `../bunderhost/src/bunderstack/email.ts:1-14`
- Modify: `../bunderhost/src/bunderstack/auth.ts:14-68`
- Modify: `../bunderhost/src/migrate.ts:1-8`
- Modify: `../bunderhost/src/bunderstack/migrations.ts:1-10`

**Interfaces:**
- Produces: `backend = bunderstack({...})` as the only control-plane declaration.
- Produces: `ControlPlane = Awaited<ReturnType<typeof backend.start>>`.
- Keeps: `app = await backend.start()` in `bunderstack/app.ts` only.

- [ ] **Step 1: Verify the consumer repository preconditions**

Run: `git -C ../bunderhost status --short`

Expected: clean worktree. If the layout refactor is still present, stop and have its owner commit or otherwise resolve it; do not fold it into this migration.

- [ ] **Step 2: Install the exact framework version**

Update `bunderstack` to the version committed by framework Task 10 and run `bun install` in `../bunderhost`. If using a local tarball for pre-publish verification, record the exact tarball path in the execution notes and restore the semver dependency before the final commit.

- [ ] **Step 3: Add a failing declaration/import-side-effect test**

In `src/bunderstack/index.test.ts`, import `backend`, assert `backend.manifest` contains the control-plane cron declarations, and assert importing the declaration does not create the default database file. Retain the health test for a fixture in Task 2.

- [ ] **Step 4: Replace `makeApp` with the static declaration**

Use:

```ts
export const backend = bunderstack({
  schema,
  access,
  database: { adapter: libsql(), migrations: './migrations' },
  auth: controlPlaneAuth,
  email: {
    from: 'Bunderhost <noreply@bunderhost.com>',
    provider: 'resend',
  },
  env: controlPlaneEnvSchema,
  realtime: true,
  api: controlPlaneApi,
  jobs: (jobs) => defineControlPlaneJobs(jobs),
})

export type ControlPlane = Awaited<ReturnType<typeof backend.start>>
```

Remove `AppOptions`, `databaseUrl`, `processEnv`, `background`, and `emailConfigFor` from the declaration.

- [ ] **Step 5: Make runtime and migration entries call `.start()`**

`bunderstack/app.ts` exports `app = await backend.start()`. `migrate.ts` starts a runtime, runs `migrateControlPlane(app)`, and closes it in `finally`. Ensure `controlPlaneAuth` uses its validated `env` for `baseURL` and `secret`, never `process.env`.

- [ ] **Step 6: Run declaration, migration, and type checks**

Run: `bun test src/bunderstack/index.test.ts src/bunderstack/migrations.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the production declaration migration**

```bash
git add package.json bun.lock src/bunderstack src/migrate.ts
git commit -m "refactor: declare the bunderhost backend once"
```

---

### Task 2: Replace the generic Bunderhost test runtime with framework fixtures

**Files:**
- Delete: `../bunderhost/src/testing/test-app.ts`
- Delete: `../bunderhost/src/testing/test-resources.ts`
- Delete: `../bunderhost/src/testing/test-resources.test.ts`
- Delete: `../bunderhost/src/testing/setup.ts`
- Modify: `../bunderhost/bunfig.toml:1-2`
- Modify: `../bunderhost/src/blueprint/service.test.ts`
- Modify: `../bunderhost/src/bunderstack/access.test.ts`
- Modify: `../bunderhost/src/bunderstack/api/api.test.ts`
- Modify: `../bunderhost/src/bunderstack/api/app-api.test.ts`
- Modify: `../bunderhost/src/bunderstack/auth.test.ts`
- Modify: `../bunderhost/src/bunderstack/change-email-unverified.test.ts`
- Modify: `../bunderhost/src/bunderstack/index.test.ts`
- Modify: `../bunderhost/src/bunderstack/jobs.test.ts`
- Modify: `../bunderhost/src/bunderstack/routes.test.ts`
- Modify: `../bunderhost/src/bunderstack/schema/index.test.ts`
- Modify: `../bunderhost/src/bunderstack/trpc.test.ts`
- Modify: `../bunderhost/src/db-viewer/route.test.ts`
- Modify: `../bunderhost/src/db-viewer/schema.test.ts`
- Modify: `../bunderhost/src/db-viewer/session.test.ts`
- Modify: `../bunderhost/src/deploy-logger.test.ts`
- Modify: `../bunderhost/src/deps.test.ts`
- Modify: `../bunderhost/src/domains.test.ts`
- Modify: `../bunderhost/src/github-setup.test.ts`
- Modify: `../bunderhost/src/mcp/operations.test.ts`
- Modify: `../bunderhost/src/mcp/server.test.ts`
- Modify: `../bunderhost/src/mcp/tokens.test.ts`
- Modify: `../bunderhost/src/migration-lock.test.ts`
- Modify: `../bunderhost/src/migration-target.test.ts`
- Modify: `../bunderhost/src/orchestrator-preview.test.ts`
- Modify: `../bunderhost/src/orchestrator.test.ts`
- Modify: `../bunderhost/src/preview-controller.test.ts`
- Modify: `../bunderhost/src/project-connections.test.ts`
- Modify: `../bunderhost/src/project-detail.test.ts`
- Modify: `../bunderhost/src/reaper.test.ts`
- Modify: `../bunderhost/src/resource-reader.test.ts`
- Modify: `../bunderhost/src/resource-writer.test.ts`
- Modify: `../bunderhost/src/ssh/connections.test.ts`
- Modify: `../bunderhost/src/target-retirement.test.ts`
- Modify: `../bunderhost/src/targets.test.ts`
- Modify: `../bunderhost/src/verification-gate.test.ts`
- Modify: `../bunderhost/src/vps/sites.test.ts`
- Modify: `../bunderhost/src/webhooks.test.ts`

**Interfaces:**
- Consumes: `backend.test({ env, database: { mode: 'temporary', schema: 'migrations' } })`.
- Produces no Bunderhost generic fixture wrapper.

- [ ] **Step 1: Migrate one representative boot test first**

Change `src/bunderstack/index.test.ts` to:

```ts
test('control plane boots and serves health', async () => {
  await using fixture = await backend.test({
    database: { mode: 'temporary', schema: 'migrations' },
  })
  const response = await fixture.app.handler(
    new Request('http://cp.local/api/health'),
  )
  expect(response.status).toBe(200)
})
```

Run it alone and confirm migrations and disposal work before broad migration.

- [ ] **Step 2: Apply the lexical fixture transformation to every owner test**

For each current `makeTestApp(env)` call, use:

```ts
await using fixture = await backend.test({
  env,
  database: { mode: 'temporary', schema: 'migrations' },
})
const { app } = fixture
```

When no env is passed, omit `env`. Keep env objects exact; do not merge with `process.env`. Delete local `try/finally app.close()`, app arrays, and `afterEach` cleanup blocks after the lexical fixture owns the app.

- [ ] **Step 3: Convert manifest assertions**

In `src/bunderstack/jobs.test.ts` and any other metadata test, assert against `backend.manifest`, not `app.manifest`; do not create a fixture solely to inspect metadata.

- [ ] **Step 4: Delete the generic harness and preload**

Delete the four testing files listed above and remove `[test].preload` from `bunfig.toml`. Keep `src/testing/fakes.ts` and other domain fixtures.

- [ ] **Step 5: Prove no old lifecycle convention remains**

Run:

```bash
rg 'makeTestApp|test-resources|testing/setup|const apps.*ControlPlane|afterEach\(.*close' src bunfig.toml
```

Expected: no generic harness matches. Domain-specific `afterEach` hooks unrelated to app cleanup may remain.

- [ ] **Step 6: Run the complete Bunderhost test suite**

Run: `bun test && bun run typecheck`

Expected: PASS with no leaked database files or hanging workers.

- [ ] **Step 7: Commit fixture migration**

```bash
git add src bunfig.toml
git commit -m "test: use lexical bunderstack fixtures"
```

---

### Task 3: Replace auth transport plumbing with framework identity plus a domain helper

**Files:**
- Modify: `../bunderhost/src/testing/auth.ts:1-39`
- Modify: `../bunderhost/src/bunderstack/access.test.ts`
- Modify: `../bunderhost/src/bunderstack/api/app-api.test.ts`
- Modify: `../bunderhost/src/bunderstack/auth.test.ts`
- Modify: `../bunderhost/src/bunderstack/routes.test.ts`
- Modify: `../bunderhost/src/bunderstack/schema/index.test.ts`
- Modify: `../bunderhost/src/bunderstack/trpc.test.ts`
- Modify: `../bunderhost/src/db-viewer/route.test.ts`
- Modify: `../bunderhost/src/mcp/operations.test.ts`
- Modify: `../bunderhost/src/mcp/server.test.ts`
- Modify: `../bunderhost/src/mcp/tokens.test.ts`
- Modify: `../bunderhost/src/verification-gate.test.ts`

**Interfaces:**
- Consumes: `fixture.auth.signUpEmail()` and `fixture.client(identity)`.
- Produces: Bunderhost-only `signUpAccount(fixture, email, options)` returning `{ identity, organizationId }`.
- Removes: Better Auth plugin calls through `any` from the generic sign-up path.

- [ ] **Step 1: Write a failing domain-helper test**

Assert `signUpAccount()` creates the user through the real auth handler, observes the session hook's organization through the typed control-plane API or direct typed DB query, optionally renames it through the typed app API, and returns an identity accepted by `fixture.client(identity)`.

- [ ] **Step 2: Implement the thin organization-aware helper**

Use:

```ts
export async function signUpAccount(
  fixture: TestFixture<ControlPlane>,
  email: string,
  options: { organizationName?: string } = {},
) {
  const identity = await fixture.auth.signUpEmail({
    email,
    name: email.split('@')[0] ?? 'user',
  })
  const [membership] = await fixture.app.db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, identity.user.id))
    .limit(1)
  if (!membership) throw new Error('session hook did not create an organization')
  return { identity, organizationId: membership.organizationId }
}
```

Use a typed procedure for rename if one exists; otherwise update the organization through typed Drizzle. Do not call `app.auth.api as any`.

- [ ] **Step 3: Migrate callers**

Replace cookie strings with `identity.headers`, `userId` with `identity.user.id`, and raw/manual RPC clients with `fixture.client(identity)` wherever the test is exercising Bunderstack oRPC. Preserve direct handler calls only when HTTP routing itself is the subject.

- [ ] **Step 4: Prove plugin casts and duplicated cookie parsing are gone**

Run: `rg 'app\.auth\.api as any|getSetCookie|signUpTestUser' src/testing src --glob '*.test.ts'`

Expected: no matches in the Bunderstack test harness/domain helper.

- [ ] **Step 5: Run auth-heavy suites**

Run: `bun test src/bunderstack/auth.test.ts src/bunderstack/access.test.ts src/bunderstack/api/app-api.test.ts src/bunderstack/routes.test.ts src/db-viewer/route.test.ts src/mcp && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit auth/client migration**

```bash
git add src/testing/auth.ts src
git commit -m "test: layer account helpers over bunderstack auth"
```

---

### Task 4: Adopt deterministic jobs and complete consumer verification

**Files:**
- Modify: `../bunderhost/src/bunderstack/jobs.test.ts`
- Modify: any Bunderhost test containing manual `app.jobs.tick()` loops or polling for job completion
- Modify: `../bunderhost/src/components/landing/HeroTabs.tsx:95-110`
- Modify: Bunderhost docs/snippets that mention `createBunderstack` or `makeApp`

**Interfaces:**
- Consumes: `fixture.jobs.runNext()` and `runUntilIdle()`.
- Completes acceptance: no project-level Bunderstack harness remains.

- [ ] **Step 1: Replace queue polling/manual ticks in behavior tests**

Use `fixture.jobs.runUntilIdle({ now, failOnJobError: true })` for transitive immediate work and `runNext({ now })` where one tick is the subject. Keep `app.jobs.tick()` only in tests explicitly verifying the public production tick facade.

- [ ] **Step 2: Update UI and documentation snippets**

Show:

```ts
export const backend = bunderstack({ schema, database, api })
export const app = await backend.start()
```

Remove `createBunderstack` wording from live source and user-facing docs; historical plans may retain it.

- [ ] **Step 3: Run source audits**

Run:

```bash
rg 'createBunderstack|makeApp|makeTestApp|BUNDERSTACK_INTROSPECT' src --glob '!routeTree.gen.ts'
rg 'test-resources|testing/setup' .
```

Expected: no matches except historical documentation outside the live product surface.

- [ ] **Step 4: Run final Bunderhost verification**

Run:

```bash
bun run fix
bun run typecheck
bun test
bun run build
```

Expected: every command exits 0.

- [ ] **Step 5: Commit the completed consumer proof**

```bash
git add src docs
git commit -m "refactor: finish bunderstack runtime migration"
```
