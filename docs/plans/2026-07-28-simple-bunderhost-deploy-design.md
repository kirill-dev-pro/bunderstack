# Simple Bunderhost Deploy Design

**Status:** Validated
**Date:** 2026-07-28

## Goal

Make the common Bunderstack deployment path:

1. connect a GitHub repository;
2. select a branch and optional root directory;
3. fill only missing user environment variables;
4. deploy the complete TanStack Start application.

Developers keep using `bun run dev` locally. Bunderstack remains a request
handler mounted in a TanStack Start server route. It does not own the HTTP
process and does not introduce a deployment CLI.

## Supported v1 convention

The project is a TanStack Start package located at the selected
`rootDirectory` (default `.`). It contains:

- `package.json` with `@tanstack/react-start` and `bunderstack`;
- `src/bunderstack.ts` exporting `app`;
- a `build` script;
- the normal TanStack Start server route mounting `app.handler`.

Bunderhost owns production infrastructure and the framework build adapter.
TanStack Start owns HTTP, SSR, assets, and routing. Bunderstack owns its
runtime capabilities and public application type.

Queue jobs are progressive disclosure. Projects with queue jobs must provide
a conventional `worker` package script. Cron remains zero-config because
Bunderhost delivers signed HTTP requests to Bunderstack's existing internal
cron endpoint.

## Minimal deployment contract

The first version intentionally does not model the full Drizzle schema or
logical storage topology. Bunderhost needs only:

```ts
type DeploymentContract = {
  version: 1
  framework: 'tanstack-start'
  appEntry: 'src/bunderstack.ts'
  database: true
  storage: true
  env: {
    key: string
    required: boolean
    scope: 'server' | 'client'
  }[]
  cron: { name: string; schedule: string }[]
  worker: boolean
}
```

Bunderhost provisions one managed database and one physical storage bucket
for each environment. Bunderstack maps logical buckets onto that physical
backend. Detailed tables, columns, indexes, foreign keys, bucket policies,
and cross-host interoperability are deferred.

## Static analysis

Bunderhost owns the analyzer. It downloads the exact GitHub revision,
extracts it under resource limits, installs dependencies with lifecycle
scripts disabled, and creates a TypeScript `Program` using Bunderhost-owned
compiler options.

The analyzer:

- never imports the application module;
- never runs repository build scripts;
- ignores repository TypeScript plugins and custom transformers;
- resolves the exported `app` symbol;
- verifies that its resolved type is `BunderstackApp`;
- reads the existing `TEnv` and `TJobsDefs` generic arguments;
- produces the minimal deployment contract;
- rejects widened cron schedules and unsupported dynamic declarations.

Bunderstack only needs to preserve cron schedule literals in
`CronDefinition`. No `$blueprint` carrier or new package is introduced.

## Synchronous preflight

Project creation and refresh call one synchronous `BlueprintService`.
There is no job queue, dispatcher, remote runner, artifact staging, or runner
protocol.

```text
resolve branch SHA
  -> download archive
  -> extract and select rootDirectory
  -> install declarations without lifecycle scripts
  -> static TypeScript analysis
  -> validate contract
  -> store project state
  -> return project detail
```

The project is created even when analysis fails. Failure is an inspectable
project state, not a failed project creation. Deploy stays disabled until:

- analysis succeeded for the selected branch SHA;
- all required server environment variables are configured;
- queue jobs have a `worker` script.

The same-SHA result is reused unless refresh explicitly requests a forced
analysis.

## Runtime build

Bunderhost uses a TanStack Start build adapter rather than compiling
`src/index.ts` into a standalone binary.

The adapter installs at repository root, runs the selected package's `build`
script, copies its `.output` into the runtime image, and starts the standard
TanStack Start server output. Monorepo root dependencies remain available
because Docker build context is the repository root while commands target
`rootDirectory`.

The web application and optional worker are built from the same installed
repository. The web image contains TanStack Start's `.output`; when the
contract requires a worker, Bunderhost also builds a private worker target and
runs the selected package's `worker` script in a separate Fly app.

## Removal

Delete the executable introspection architecture:

- Fly Machine introspection runner;
- Tigris artifact staging;
- remote runner Docker image and signed result protocol;
- unsafe local application importer;
- introspection job table and dispatcher;
- cancellation and introspection reaper;
- duplicate introspection inside the image builder.

Keep the GitHub archive source, archive safety checks, project-level status
UI, environment form, and same-SHA caching where they still serve the static
preflight.

## Error handling

Static diagnostics use stable public codes for:

- framework or entrypoint not detected;
- invalid `rootDirectory`;
- dependency installation failure or timeout;
- unsupported Bunderstack version;
- TypeScript program failure;
- unsupported or widened deployment metadata;
- missing build or worker scripts;
- invalid contract output.

Technical failures do not erase the last successful contract payload, but the
current status becomes failed and deployment of a different SHA remains
blocked.

## Testing

Bunderstack uses compile-time assertions proving cron schedule literals
survive both inline and extracted job definitions.

Bunderhost uses real temporary TypeScript fixtures to prove that:

- app source is never executed;
- TanStack Start and Bunderstack are detected relative to `rootDirectory`;
- required and optional env keys are classified;
- cron names and schedules are recovered;
- queue jobs require a worker script;
- widened schedules produce actionable diagnostics;
- project creation persists failed analysis;
- successful analysis gates deployment;
- generated images run TanStack Start output rather than a Bunderstack CLI.
