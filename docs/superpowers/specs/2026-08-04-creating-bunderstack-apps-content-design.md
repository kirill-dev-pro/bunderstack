# Creating Bunderstack apps skill: content rewrite

Date: 2026-08-04
Status: approved

## Problem

The shipped `creating-bunderstack-apps` skill routes almost all concrete
guidance into `templates/tanstack-start-saas/`, which does not exist yet. An
agent that loads the skill learns a layout decision table and three reference
pointers, but not what Bunderstack actually provides or how a Bunderstack
application is laid out. The skill reads as indirection rather than guidance.

The underlying cause is the approved design of 2026-08-03, which deliberately
kept the skill free of structure so the template could own it. That split is
correct for source code and wrong for the capability inventory and the module
layout, which an agent needs before it opens any template.

## Sequencing

`templates/tanstack-start-saas/` is built first, under its existing plan
`docs/superpowers/plans/2026-08-03-tanstack-start-saas-template.md`. The
template establishes the canonical structure. This skill rewrite follows and
describes what the template implements. The two must never disagree, which is
enforced by a test rather than by review.

## Capability inventory

`SKILL.md` opens by stating that Bunderstack is the application's backend, not
a library sitting beside one, and that an application uses the framework's
capability instead of its own implementation. A deviation requires a recorded
reason.

| Capability     | Replaces                             | Entry point                     |
| -------------- | ------------------------------------ | ------------------------------- |
| Generated CRUD | Hand-written REST routes             | `defineAccess(schema, rules)`   |
| tRPC           | A separate procedure server          | `trpc: createAppRouter`         |
| Authentication | A private Better Auth instance       | `auth: authConfig`              |
| Realtime       | A custom WebSocket server            | `realtime: true` or `{ redis }` |
| Storage        | AWS or Tigris SDK wrappers           | `storage: { buckets }`          |
| Job queue      | BullMQ or a bespoke queue            | `jobs.job({ ... })`             |
| Cron           | `/api/cron/*` behind a shared secret | `jobs.cron({ schedule })`       |
| Email          | A Resend SDK wrapper                 | `email: { from }`               |

This inventory is the skill's answer to "what do I get", and it is the same set
the migration skill removes legacy infrastructure in favour of. The two skills
therefore describe one contract from opposite directions.

## Module structure

The modular layout becomes the only structure the skill shows:

```text
src/bunderstack/
  index.ts        # createBunderstack(), exports app/db/auth/env, provision(app)
  schema/         # index.ts aggregates; one file per domain plus auth.ts
  access.ts       # defineAccess policy for generated CRUD
  auth.ts         # authConfig; reads process.env at module scope
  env.ts          # envSchema
  permissions.ts  # role definitions
  trpc/           # index.ts router, one file per feature
  jobs/           # one file per queue and cron handler
  methods.ts      # domain queries over app.db
  types.ts        # $inferSelect aliases
  <domain>/       # logic called by both jobs and trpc, kept beside them
src/worker.ts            # app.runWorker()
src/routes/api/$.ts      # createApiHandlers(app)
```

Entries divide into two classes. Required: `index.ts`, `schema/`, `access.ts`,
`auth.ts`, `env.ts`, `trpc/`, `jobs/`, `src/worker.ts`, and
`src/routes/api/$.ts`. Optional, added when the application earns them:
`permissions.ts`, `methods.ts`, `types.ts`, and domain directories. The
distinction is marked in `SKILL.md` itself, because it is guidance an agent
needs and because the drift test depends on it.

The layout decision table is removed. A single sentence keeps
`src/bunderstack.ts` as the exception for a tiny API. The table currently
competes with the structure and dilutes the answer.

The shape is taken from the HR Breakers application with one deliberate
correction: HR Breakers starts the worker inside `src/bunderstack/index.ts`.
The skill prescribes `src/worker.ts` instead, because an embedded worker means
every web replica runs one and they contend for the same jobs. Structure comes
from that application; runtime topology comes from the current contract.

Domain directories inside `src/bunderstack/` are named as a supported pattern:
logic that both a job and a tRPC procedure call belongs beside them rather than
in a general `src/lib/`.

## Drift protection

`scripts/skills-contract.test.ts` gains a test that reads the single fenced
`text` block under the structure heading of `SKILL.md`, extracts the paths it
lists, and asserts that every path marked required exists in
`templates/tanstack-start-saas/`. Optional entries are not asserted, so an
application that never needs `permissions.ts` does not fail the contract.

The test also runs in the other direction for the required set: a required
directory present in the template but missing from `SKILL.md` fails too, so the
skill cannot silently fall behind the template.

This is what makes the template-first order safe: the template is the source of
truth, and the skill is checked against it rather than reviewed by eye.

## Reference boundary

`references/runtime-integrations.md` and `references/verification.md` are
unchanged. `references/application-structure.md` loses the structure section,
which moves into `SKILL.md`, and keeps the deeper rules: entry purity under
`BUNDERSTACK_INTROSPECT=1`, schema aggregation including
`export * from 'bunderstack/schema'`, environment ownership, and publishing
direct writes after the transaction commits.

`SKILL.md` grows from 42 to roughly 110 lines, well inside the 500-line limit.

## Verification

The content change invalidates the skill's existing forward evidence, which was
scored against text that no longer exists. The three scenarios from
`docs/superpowers/plans/2026-08-03-creating-bunderstack-apps-skill.md` are
re-run in fresh contexts against the rewritten skill, scored on the same
criteria, and recorded as a new evidence file. The baseline evidence stays as
it is; it describes agent behaviour without any skill and is unaffected.

Gates: the skill validator, `bun test scripts/skills-contract.test.ts`
including the new drift test, and `bun run test`.

## Out of scope

The migration skill is not touched. It was forward-tested against the current
runtime contract on 2026-08-04 and describes the same capability set from the
migration direction; nothing in this rewrite changes that contract.
