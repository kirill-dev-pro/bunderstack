# Blueprint as the source of truth for Worker apps

Date: 2026-09-29
Branch: `next` (bunderstack), `codex/celld-vps-deployment` (bunderhost)
Release: `bunderstack@1.0.0-beta.3`

## Context

Bunderstack 1.0 generates two files from `backend.inspect()`: `wrangler.json`
and `bunderstack.blueprint.yaml`. They are generated independently. Bunderhost
reads `wrangler.json` as the deploy contract and treats the blueprint as
optional metadata (`cd9e4a0`). The Workers runtime spec said "one
`wrangler.json`, generated from the blueprint", but the implementation made
`wrangler.json` primary.

`wrangler.json` is the wrong contract for a host:

- Bunderhost never deploys it as committed. On celld it already rewrites it
  into `wrangler.bunderhost.json` with secrets. On Cloudflare (Workers for
  Platforms) a host uploads a script through the API with its own metadata
  format, not `wrangler.json`.
- Every physical name in it belongs to the host: R2 bucket names per
  environment (`bh-*`), script names, the dispatch namespace. The committed
  `bucket_name: "<app>-<bucket>"` is wrong in production.
- It carries none of what the host needs for preflight and the dashboard:
  environment keys, tables, messaging, jobs.

## Product decisions

- The new hosting accepts only Bunderstack 1.0 Worker apps. The current
  Bunderhost instance keeps serving 0.x apps from `main` and is frozen. Removing
  the 0.x paths from the new hosting is a separate follow-up spec.
- A 1.0 app commits exactly one contract: `bunderstack.blueprint.yaml`.
- `wrangler.json` is a local, derived artifact. It is git-ignored and written by
  `bunderstack dev` and `bunderstack build` from the blueprint.
- The beta may break things: no compatibility path for Worker revisions without
  a blueprint, and no rollback to a deployment that has no Worker blueprint.

## Bunderstack

### Blueprint version 2

1.0 blueprints are `version: 2`. They are always Worker apps, so the runtime
discriminator from beta.2 goes away.

```yaml
version: 2
generator: { name: bunderstack, version: 1.0.0-beta.3 }
application:
  framework: solid
  scripts: { build: build }
  worker:
    main: src/worker.ts
    compatibilityDate: "2026-09-28"
    assets: dist/client
bunderstack: { entry: src/bunderstack.ts, manifestVersion: 4 }
resources: { ... }      # unchanged
environment: [ ... ]    # unchanged
api: { operations: [ ... ] }
background:
  jobs: [ ... ]
  cron: [ ... ]
  maintenance: [ ... ]
```

Changes from version 1:

- Removed: `application.runtime`, `application.scripts.start`,
  `application.scripts.worker`, `background.worker`.
- Added and required: `application.worker` with `main`, `compatibilityDate`
  (`YYYY-MM-DD`), and `assets`. `main` and `assets` are relative paths without
  traversal.
- `framework` stays. It is informational now and may matter again if SSR
  returns.

The generator writes only `version: 2`. The parser accepts two versions,
because Bunderhost imports `bunderstack/blueprint` from 1.0 and still parses
the version 1 blueprints of the hosted 0.x apps until the 0.x path is removed:

- `version: 1`: the 0.x server contract, exactly as 0.25.x writes it. The
  beta.2 `application.runtime` field is removed from the version 1 schema; a
  version 1 file with `runtime: worker` fails with "regenerate the blueprint
  with bunderstack 1.0.0-beta.3".
- `version: 2`: the Worker contract above.

Types: `LegacyBlueprint` (version 1), `WorkerBlueprint` (version 2), and
`BunderstackBlueprint = LegacyBlueprint | WorkerBlueprint`. `parseBlueprint`
returns the union. `parseWorkerBlueprint` returns `WorkerBlueprint` and throws
on version 1 with a message that tells the developer to run `bunderstack dev`
or `bunderstack blueprint`. Every bunderstack 1.0 code path that reads the app's
own blueprint (`hosted-contract`, `wrangler`, `build`) uses
`parseWorkerBlueprint`. Version 1 support is removed together with the 0.x path
in Bunderhost. `bunderstack/main` (0.x) keeps writing version 1 and is not
changed.

The generator keeps `compatibilityDate` once chosen: it reads the existing
blueprint and reuses the date, so `--check` stays stable across days. It takes
`main` and `assets` from the existing blueprint too, with the defaults
`src/worker.ts` and `dist/client` for a new file. There are no CLI flags for
them in this release; a developer edits the YAML, and the generator preserves
the edit.

### `WorkerPlan`

A new pure module, `src/workers/plan.ts`, exported from `bunderstack/workers`
and also from a runtime-free entry (`bunderstack/blueprint`) so a host can
import it without loading the app runtime:

```ts
type WorkerPlan = {
  main: string
  compatibilityDate: string
  compatibilityFlags: ['nodejs_compat']
  durableObjects: {
    bindings: { name: 'SCHEDULER' | 'REALTIME' | 'RATE_LIMITER'; className: string }[]
    migrations: { tag: 'v1'; newSqliteClasses: string[] }[]
  }
  buckets: { name: string; binding: string }[] // logical name, BUCKET_<NAME>
  crons: string[]
  assets: { directory: string; runWorkerFirst: string[] }
}

function workerPlanFromBlueprint(blueprint: BunderstackBlueprint): WorkerPlan
```

The logic moves from `buildWranglerConfig(manifest)` unchanged:

- crons: declared cron schedules, plus maintenance schedules when there are
  buckets, sorted and de-duplicated; more than five collapse to `* * * * *`;
- `runWorkerFirst`: `/api/*` plus the first segment of each
  `api.operations[].path`.

The plan has no physical names. A renderer supplies them.

### `wrangler.json`

```ts
function toWranglerConfig(
  plan: WorkerPlan,
  names: { name: string; bucketName: (logical: string) => string },
): WranglerConfig
```

Locally the name comes from `package.json` (as today) and bucket names are
`<name>-<bucket>`.

`bunderstack wrangler` reads the committed blueprint, not the backend. It no
longer imports app code. `--check` is removed.

### CLI

- `bunderstack dev`: regenerate the blueprint, then write `wrangler.json` from
  it, on start and on every schema or declaration change (the existing
  re-push trigger).
- `bunderstack build`: fail if the blueprint is missing or stale
  (`generateBlueprint({ check: true })`), then write `wrangler.json` from it and
  run `vite build`. It never rewrites the blueprint.
- `bunderstack blueprint [--check]`: unchanged as the direct diagnostic.

### Examples and template

`todo-solid-native`, `agent-chat`, and `todo`: delete committed
`wrangler.json`, add it to `.gitignore`, regenerate the blueprint as version 2.

`templates/tanstack-start-saas` is deleted, with its live references (skills,
contract tests, `llms-full.txt`, workspaces); historical plans stay. A new
1.0 template comes later.

### Tests

- `workerPlanFromBlueprint`: crons with and without buckets, collapse above
  five, operation path prefixes, bucket bindings.
- Parser: version 2 accepted; a 0.25.x version 1 file accepted by
  `parseBlueprint` and rejected by `parseWorkerBlueprint`; version 1 with
  `runtime: worker` rejected;
  missing `application.worker` rejected; traversal in `main` or `assets`
  rejected.
- Generator: `compatibilityDate`, `main`, and `assets` preserved from an
  existing file; defaults for a new file; no secret values in YAML.
- `bunderstack wrangler` works on a directory whose backend would fail to
  import.
- `bunderstack build` fails on a stale blueprint and does not rewrite it.
- `bun run test:workers` (the celld and workerd integration suite) still passes
  with `wrangler.json` generated from the blueprint.

## Bunderhost

### Revision

`loadApplicationRevision` reads only `bunderstack.blueprint.yaml`. A version 2
blueprint returns the Worker shape:

```ts
type WorkerApplicationRevision = {
  sha: string
  blueprint: BlueprintRevision // version 2
  plan: WorkerPlan
}
```

- No blueprint: error `blueprint_required`, with the message "commit
  bunderstack.blueprint.yaml: upgrade bunderstack to 1.0.0-beta.3 and run
  `bunderstack build`". This applies even when `wrangler.json` exists.
- `version: 1` blueprint: the existing 0.x path (`kind: 'blueprint'`), with
  no Worker handling. A `wrangler.json` next to a version 1 blueprint is
  ignored.
- Checks from `src/worker/revision.ts` that are not about `wrangler.json` stay
  and apply to the plan: `main` and `assets` stay inside the package,
  `package.json` exists, `bunderstack` dependency is 1.0. The `wrangler.json`
  key whitelist is removed.

Bunderhost depends on `bunderstack@1.0.0-beta.3` and imports
`parseBlueprint` and `workerPlanFromBlueprint` from the runtime-free entry.

### Rendering per target

`src/worker/render.ts`:

```ts
function renderCelldConfig(
  plan: WorkerPlan,
  input: { name: string; bucketName: (logical: string) => string; vars: Record<string, string> },
): string
```

It replaces `runtimeConfig` and `WorkerConfig`. It keeps the variable-name
check and the check that a variable does not collide with a binding. The output
is still written only to the throwaway `wrangler.bunderhost.json`.

A Cloudflare renderer is out of scope, but `WorkerPlan` must carry everything a
Workers for Platforms upload needs (bindings, DO migrations, crons, assets
routing), so no plan change is needed when it lands.

### Storage of contracts

- A hand-written migration drops `projects.workerJson` and
  `deployments.workerJson` (and their snapshot entries).
- Import and refresh store the blueprint in `projects.blueprintJson` and set
  `runtimeKind: 'worker'`.
- A deployment snapshots its blueprint in `deployments.blueprintJson`.
- Rollback reads `previous.blueprintJson`, parses it as version 2, builds the
  plan, and renders it. If the previous deployment has no version 2 blueprint,
  rollback fails with an explicit error and the failed release stays reported
  as failed.

### Preflight and UI

- Env preflight from `cd9e4a0` runs for every Worker deployment, because the
  blueprint is always present.
- Overview drops its "no blueprint" unknown state for Worker projects.
- Data, Storage, Users, Messaging, and Background stay disabled. Resource
  readers are separate work.

The 0.x blueprint path (`kind: 'blueprint'`, Docker, Fly) stays in the code in
this change. Removing it is the follow-up spec.

### Tests

- Revision: v2 blueprint → Worker plan; `wrangler.json` only →
  `blueprint_required`; v1 → 0.x path; malformed YAML; nested
  `rootDirectory`; non-missing read failure propagates.
- `renderCelldConfig`: snapshot, physical bucket names, variable collision,
  invalid variable name.
- Orchestrator: deployment snapshots the blueprint; rollback renders from the
  previous blueprint; rollback to a deployment without a v2 blueprint fails
  explicitly.
- Migration applies to a copy of the current development database.
- End to end: `todo-solid-native` from beta.3 deploys to the VPS pilot and
  loads its SPA and API.

## Order

1. Bunderstack: version 2 blueprint, `WorkerPlan`, CLI, examples. Publish
   `1.0.0-beta.3` with the `next` tag.
2. Bunderhost: bump to beta.3, revision, renderer, migration, rollback,
   preflight, UI.
3. Re-deploy the pilot example.

## Out of scope

- Removing 0.x paths from Bunderhost (follow-up spec).
- The Cloudflare Workers for Platforms target and the open question of Durable
  Objects in user Workers.
- Resource readers for sqld and Tigris.
- SSR (a separate spike follows this work).
