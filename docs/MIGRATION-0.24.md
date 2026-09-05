# Bunderstack 0.23.x → 0.24.0 — what changed and how to adapt

Bunderstack 0.24 makes the declaration **env-first** and replaces the single
email facade with a named **messaging registry**.

---

## The one-paragraph summary

One change needs edits in your code, and it is mechanical: `email: { from,
provider }` becomes `messaging: { email: resend({ apiKey, from }) }`, and
`app.email.send()` becomes `app.messaging.email.send()`. The declaration itself
keeps its shape — one object with `schema`, `env`, `database`, and the rest.
`backend.manifest` becomes `backend.inspect({ env })`, because a manifest now
depends on the environment.

Everything else is additive: the slots that hold credentials also accept a
function of the validated environment, blueprint generation rejects a
declaration whose shape depends on a value, `bunderstack blueprint
--hosted-check` compares a runtime declaration against the committed blueprint,
and a channel without credentials captures to the message journal instead of
failing.

There is no compatibility shim. The eager `backend.manifest` property, the
`email` config key, `app.email`, `ctx.email`, and `t.email` are gone in this
release.

---

# What Changed

## 1. Validated env inside the declaration

The declaration is still one object, and most of it is unchanged. What is new:
the slots that hold credentials accept a function of the validated environment,
so an application no longer reaches for `process.env` while declaring itself.

### Before (0.23)

```ts
export const backend = bunderstack({
  schema,
  env: envSchema,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
  email: { from: 'App <hello@example.com>', provider: 'resend' },
  jobs: (j) => j.define({ ... }),
})
```

### After (0.24)

```ts
export const backend = bunderstack({
  schema,
  env: envSchema,
  database: { adapter: libsql() }, // url still defaults to DATABASE_URL
  messaging: (env) => ({
    email: resend({ apiKey: env.RESEND_API_KEY, from: 'App <hello@example.com>' }),
  }),
  jobs: (j) => j.define({ ... }),
})
```

`database`, `storage`, `messaging`, and `realtime` take either a value or a
function of the environment. `auth` has taken a `({ db, env })` builder since
0.22 and is unchanged. Everything else stays plain data, and a procedure or a
job keeps reading `ctx.env`.

`process.env.X` still works — it is an ordinary expression — but a declared key
read through the slot function is validated first and appears in the blueprint,
which is how a host learns what the application needs.

### A slot function runs more than once

It is resolved once per `inspect()`, once per `start()`, and once per test
fixture. Keep it pure: no connections, no file reads, no state. Two test
fixtures with different values are fully independent because each resolves the
declaration for itself.

### A slot supplies values, not shapes

Which channels, buckets, or tables exist must not depend on a value. Blueprint
generation enforces this by resolving the declaration against two accepted
environments and comparing the manifests, so a host can provision from the
committed blueprint before any value exists.

One typing limit is worth knowing: an inline `jobs` or `api` builder receives
the open messaging type, not the declared channel record, because TypeScript
cannot infer that record and type a sibling callback in the same pass. Declare
the builder in its own module for exact channels —
`defineApi({ schema, env, messaging })`, or
`BunderstackJobsBuilder<typeof schema, AppEnv, { email: ResendDescriptor }>`.

## 2. `backend.manifest` → `backend.inspect({ env })`

A manifest now depends on the environment, so it is a call, not a property:

```ts
// Before
const manifest = backend.manifest

// After
const manifest = backend.inspect({ env: process.env })
```

`inspect()` validates the environment, resolves the declaration, builds the
jobs and API routers, and returns the manifest. It opens no database, no
bucket, no provider connection, and starts no worker. `inspect()` with no
argument reads `process.env`.

## 3. Blueprint generation probes two environments

`bunderstack blueprint` now resolves the declaration twice, with two accepted
sets of values for the declared keys, and compares the manifests. A declaration
whose _shape_ depends on a value is rejected:

```ts
// Rejected — the deployed contract would differ per environment.
bunderstack({
  schema,
  env,
  database,
  realtime: (env) => env.FEATURE_FLAG === 'enabled',
})
```

The error names the differing paths, such as `realtime.required`. It never
contains a probe value or a configured value. Values that only change runtime
configuration — a URL, a key, a sender address — are fine.

When no candidate value validates for a declared key, generation fails naming
only that key. Provide a valid value in the environment while generating the
blueprint.

## 4. Hosted blueprint checking

`bunderstack blueprint --hosted-check` imports the backend, inspects it with
the current environment, and compares the result with the committed blueprint.
It exits non-zero listing added, removed, and changed paths. It is mutually
exclusive with `--check`, which only asks whether the file is up to date.

At runtime, when `BUNDERSTACK_BLUEPRINT_PATH` is set, `backend.start()` reads
that blueprint and compares it with the inspected declaration **before** it
connects to a database, opens storage, builds auth, materializes messaging,
starts realtime, or starts a worker.

## 5. `email` → `messaging`

### Before (0.23)

```ts
email: { from: 'App <hello@example.com>', provider: 'resend' }

await app.email.send({ to, subject, html })
await ctx.email.send({ to, subject, html })
expect(t.email.sent).toHaveLength(1)
```

### After (0.24)

```ts
import { resend } from 'bunderstack'

messaging: ((env) => ({
  email: resend({
    apiKey: env.RESEND_API_KEY,
    from: 'App <hello@example.com>',
  }),
}),
  await app.messaging.email.send({ to, subject, html }))
await ctx.messaging.email.send({ to, subject, html })
expect(t.messaging.email.sent).toHaveLength(1)
```

`messaging` is a named record. Each key is a channel, each channel names one
provider, and each provider carries its own message type — a Telegram message
never type-checks against an email message. Two channels may share a provider
with different senders.

### Provider factories

| Before                                     | After                                               |
| ------------------------------------------ | --------------------------------------------------- |
| `email: { from, provider: 'resend' }`      | `resend({ apiKey, from })`                          |
| `email: { from, provider: smtp({ url }) }` | `smtp({ url, from })` from `bunderstack/email-smtp` |
| `email: { from, provider: adapter }`       | `customEmail({ adapter, from })`                    |
| `email: { from }` (console in dev)         | any channel without credentials — see capture       |
| —                                          | `telegram({ botToken })`                            |

### There is no console provider

A channel whose required configuration is absent or empty **captures**: the
message is written to the message journal and, locally, printed to the console.
On a host (`BUNDERHOST_ENVIRONMENT_ID` is set) it is journaled only, so no
message body reaches the production logs.

A key that is present but wrong is not capture, and neither is a provider that
rejects the request: both raise, and the journal row records `failed`. This
replaces the old rule that a missing provider threw at boot in production.

### Managed credentials

A host may supply `BUNDERSTACK_MESSAGING_CONFIG`, a JSON object keyed by
provider — `{"resend":{"apiKey":"…"}}`. All channels of one provider share that
connection. A non-empty field the channel declares itself wins over the managed
value, field by field. Every journal row records whether the credentials were
`explicit`, `managed`, or `capture`.

### Better Auth

Verification and password-reset mail uses the channel named `email`, and only
that one, when its provider is an email provider. A channel named anything else
is never selected. This is the same convention as before, expressed through the
channel name.

## 6. The message journal replaces the email log

`_bunderstack_emails` and `_bunderstack_email_events` are replaced by
`_bunderstack_messages` and `_bunderstack_message_events`. The new rows carry
the channel, provider kind, provider, credential source, status, recipients,
content, provider message ID, and error.

Generate a migration after upgrading:

```bash
bunx drizzle-kit generate
```

The generated migration drops the two old tables and creates the two new ones.
Copy any history you need out of `_bunderstack_emails` first.

---

# Migration checklist

1. Replace `backend.manifest` with `backend.inspect({ env })`.
2. Optionally replace `process.env.X` inside `database`, `storage`, `messaging`,
   or `realtime` with the slot's env function, declaring the key in `env` when
   it is not built in.
3. Move a value-dependent branch out of the declaration if blueprint generation
   reports a shape difference.
4. Replace the `email` key with a `messaging` channel built by `resend`,
   `smtp`, `customEmail`, or `telegram`.
5. Replace `app.email` / `ctx.email` with `app.messaging.<channel>` /
   `ctx.messaging.<channel>`, and `t.email.sent` with
   `t.messaging.<channel>.sent`.
6. Run `bunx drizzle-kit generate` for the journal tables.
7. Regenerate the blueprint with `bunderstack blueprint`.
