# Committed Bunderstack Blueprint Generator Design

## Goal

Generate a static, committed `bunderstack.blueprint.yaml` that describes the
infrastructure shape of a Bunderstack application. Bunderhost will eventually
consume this file as the only application declaration contract, without
installing repository dependencies, analyzing TypeScript, or executing
repository code.

The first delivery is an internal prototype script in the Bunderstack
repository. It is not a published CLI and does not establish a stable public
format yet.

## Context

Bunderhost currently downloads an imported repository, installs dependencies,
and analyzes the exported `BunderstackApp` TypeScript type. That path is slow,
operationally expensive, coupled to Bunderstack's internal types, and produces
less information than Bunderstack's existing runtime manifest.

The generated blueprint moves discovery to the developer's trust boundary.
The developer runs their own application locally, commits the resulting static
artifact, and Bunderhost later reads only that artifact.

No compatibility path for old Bunderstack versions is required. Once
Bunderhost adopts the committed blueprint, its existing repository download,
dependency installation, and TypeScript blueprint analyzer can be removed.

## Decisions

### File location and path resolution

The generated file is named:

```text
bunderstack.blueprint.yaml
```

It lives in the root of the deployable application beside that application's
`package.json`. All paths in the blueprint are relative to the blueprint's
directory.

This rule supports monorepositories without a separate `rootDirectory` field:
each deployable application owns a blueprint beside its own `package.json`.
Bunderhost selects the blueprint path when importing an application.

### Framework-agnostic application lifecycle

The blueprint does not identify or model the host web framework. Bunderhost
uses these Bun conventions from the blueprint directory:

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

The blueprint therefore has no `application` section. The generator validates
that `package.json` defines `build` and `start` scripts.

Bunderstack is an embedded Web Standard event handler in the common case, not
a separate web process. The blueprint does not model a web process or repeat a
dependency graph for it.

### Bunderstack entry

The Bunderstack declaration entry is separate from the host application's
runtime entry:

```yaml
bunderstack:
  entry: src/bunderstack.ts
```

The entry is resolved relative to the blueprint directory and must export
`app`.

### Provider-independent resources

The blueprint describes resource requirements and compatibility, not selected
providers or credentials. Bunderhost users choose compatible providers in the
dashboard. Bunderhost stores provider selection and credentials outside the
repository, potentially per environment.

For example, a database requirement declares the schema dialect (`sqlite` or
`pg`) but not Turso or another provider. Storage declares logical buckets but
not Tigris, AWS S3, or another provider.

Database table metadata is intentionally excluded from the prototype.
Migrations remain authoritative for physical database schema. Bunderhost may
inspect a live database after deployment to populate its data explorer.

### Environment contract

Each application-defined environment variable contains only:

```yaml
- key: OPENAI_API_KEY
  required: true
```

The blueprint does not serialize scope, sensitivity, defaults, current values,
or credentials. Bunderhost treats configured values as secrets by default and
recognizes public variables through the existing `PUBLIC_` naming convention.

Platform-provided bindings such as database URLs, storage credentials, auth
secrets, and Redis URLs are derived from resource requirements and are not
duplicated in `environment`.

### Background work

Queue jobs require a separate worker runtime. The command is conventional:

```sh
bun run worker
```

The blueprint declares whether a worker is required and lists queue job names
and cron schedules. If a worker is required, the generator validates that
`package.json` defines a `worker` script.

Cron schedules use explicit UTC timezone metadata. Platform maintenance tasks
are outside the prototype contract.

## Prototype Blueprint

The first generated shape is:

```yaml
version: 1

bunderstack:
  entry: src/bunderstack.ts

resources:
  database:
    dialect: sqlite

  storage:
    buckets:
      - name: images
        visibility: private

  realtime:
    required: true

environment:
  - key: NOTIFY_COMPLETED
    required: false
  - key: PUBLIC_APP_NAME
    required: false

background:
  worker:
    required: true

  jobs:
    - name: celebrateBoardComplete

  cron:
    - name: archiveDoneTodos
      schedule: '* * * * *'
      timezone: UTC
```

The generator always emits the top-level `bunderstack`, `resources`,
`environment`, and `background` sections. Collection fields such as
`environment`, `jobs`, and `cron` are emitted as empty sequences when they have
no entries. Disabled optional resource capabilities such as `realtime` are
omitted. `background.worker.required` is always emitted as a boolean. The
generated representation, ordering, and quoting must be deterministic.

## Generator Architecture

Create an internal Bun script:

```text
scripts/generate-blueprint.ts
```

Initial invocation:

```sh
bun scripts/generate-blueprint.ts <application-directory>
```

The application directory defaults to the current working directory. The
script performs this flow:

1. Resolve and validate the application directory.
2. Read its `package.json`.
3. Require `build` and `start` package scripts.
4. Resolve the conventional `src/bunderstack.ts` entry.
5. Set `BUNDERSTACK_INTROSPECT=1` before dynamically importing the entry.
6. Require the module to export an app with a valid Bunderstack manifest.
7. Convert the manifest to the minimal provider-independent blueprint model.
8. Deliberately omit database tables and all environment values.
9. Serialize deterministic YAML.
10. Write a temporary file in the destination directory and atomically replace
    `bunderstack.blueprint.yaml`.

The prototype reuses Bunderstack's existing introspection mode, which prevents
database and Redis connections while the application is initialized.
`provision(app)` must also return immediately when
`BUNDERSTACK_INTROSPECT=1`; importing a conventional application entry must not
create a local database, run Drizzle Kit, or apply migrations during blueprint
generation.

Application imports still execute locally on the developer's machine. A later
design may split pure declaration from runtime instantiation through a
`defineBunderstack` API, but that refactor is outside this prototype.

## Validation and Errors

Generation fails with a concise actionable error when:

- the application directory does not exist;
- `package.json` is missing or invalid;
- `build` or `start` is missing;
- `src/bunderstack.ts` is missing;
- the entry does not export `app`;
- the exported value does not expose a supported Bunderstack manifest;
- queue jobs require a worker but `package.json` has no `worker` script;
- the manifest cannot be converted to the prototype contract;
- YAML serialization or the atomic write fails.

Validation completes before replacing the existing blueprint. A failed
generation must leave any previously committed blueprint unchanged.

The output must never contain environment values, provider credentials, or
other secrets.

## YAML Constraints

The file uses a conservative YAML 1.2-compatible data model:

- mappings;
- sequences;
- strings;
- numbers;
- booleans;
- null only when the schema explicitly permits it.

The generator does not emit anchors, aliases, merge keys, or custom tags.
Ambiguous strings such as cron expressions are quoted. A single canonical
emitter controls field ordering and formatting.

The prototype does not yet publish a JSON Schema. A future public format may
add a schema URL and editor integration after the model stabilizes.

## Testing

Implementation follows test-driven development.

Tests cover:

- pure conversion from `BunderstackManifest` to the minimal blueprint model;
- a snapshot of canonical YAML and stable field ordering;
- an integration fixture with a real `src/bunderstack.ts`;
- omission of database tables;
- omission of environment values and credentials;
- `provision(app)` performing no filesystem, Drizzle Kit, or migration work
  when `BUNDERSTACK_INTROSPECT=1`;
- missing application directory and `package.json`;
- missing `build` and `start` scripts;
- missing entry and missing `app` export;
- invalid or unsupported manifest;
- a required worker with no `worker` package script;
- successful generation through a temporary file and atomic replacement;
- preservation of an existing blueprint after any failed generation.

Tests run with `bun test`. The prototype does not add a published binary,
package export, public CLI command, `--check` mode, or package script.

## Non-Goals

- Publishing a `bunderstack blueprint` command.
- Defining long-term format compatibility guarantees.
- Supporting old Bunderstack versions in Bunderhost.
- Adding a normal build hook or automatic regeneration.
- Adding integrity hashes or freshness checks.
- Selecting infrastructure providers.
- Serializing provider credentials or environment values.
- Describing database tables, columns, relations, constraints, or migrations.
- Modeling the host web framework.
- Modeling the embedded Bunderstack handler as an independent web process.
- Describing platform maintenance tasks.
- Replacing Drizzle migrations with blueprint-driven schema provisioning.

## Future Work

After using the prototype on real applications, separately evaluate:

- a public `bunderstack blueprint` command;
- `--check` for CI freshness enforcement;
- a stable schema and schema URL;
- a pure `defineBunderstack` declaration layer;
- database table metadata for pre-deploy exploration;
- provider compatibility metadata;
- additional resources and multiple resource instances;
- the Bunderhost migration that removes static TypeScript analysis and consumes
  committed blueprints exclusively.
