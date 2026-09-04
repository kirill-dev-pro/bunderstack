# Env-first declarations and messaging design

**Date:** 2026-09-04

## Goal

Let an application validate its environment before constructing runtime
configuration, without forcing environment values through separate auth,
database, and provider builders:

```ts
export const backend = bunderstack(envSchema, (env) => ({
  schema,
  access,
  auth: authConfig(env),
  database: {
    adapter: libsql(),
    migrations: './migrations',
    url: env.DATABASE_URL,
  },
  messaging: {
    email: resend({
      apiKey: env.RESEND_API_KEY,
      from: 'Company <hello@company.com>',
    }),
    telegram: telegram({ token: env.TELEGRAM_BOT_TOKEN }),
  },
}))
```

The callback receives ordinary validated values. Bunderstack does not introduce
symbolic environment references or a second configuration language.

Self-hosted applications may make the resulting configuration dynamic.
Bunderhost deployments remain declarative because their committed blueprint is
verified against the configuration produced for that deployment before managed
resources are provisioned, then checked once more with the final platform
values before runtime clients are created.

## Decisions

### 1. Two declaration forms

The existing object form remains supported:

```ts
const backend = bunderstack({ schema, database })
```

It remains synchronous and exposes its eager `backend.manifest` unchanged.

The new env-first form is:

```ts
const backend = bunderstack(envSchema, (env) => ({
  schema,
  database: { adapter: libsql(), url: env.DATABASE_URL },
}))
```

The environment schema is not repeated inside the returned object. The callback
parameter is contextually typed as `ValidatedEnv<typeof envSchema>`.

An env-first backend resolves the callback independently for every `start()`,
`test()`, and inspection. It must not cache a configuration produced for a
different environment.

### 2. Inspection is explicit for env-first backends

An env-first backend cannot truthfully expose a single eager manifest. It
instead exposes:

```ts
backend.inspect({ env?: Record<string, string | undefined> }):
  BunderstackManifest
```

`inspect()` validates the supplied source, invokes the declaration callback,
resolves jobs and API builders, and builds a manifest. It performs no database,
network, storage, worker, or provider I/O.

The object form continues to expose `backend.manifest` and also gains
`backend.inspect()`, which returns the same manifest after validating any
explicit env source. This gives framework tooling one common operation without
breaking current consumers.

The callback is a pure configuration constructor. Calling it more than once is
part of the public contract. Import-time I/O, random structural declarations,
and mutable module-level accumulation are unsupported.

### 3. Environment-dependent shape

Bunderstack itself permits an env-first callback to return different structures
for different inputs. This keeps self-hosting unrestricted and avoids pretending
that TypeScript can prohibit ordinary JavaScript control flow.

`bunderstack blueprint` performs a best-effort purity probe. It inspects the
factory with at least two generated value sets and compares normalized manifests.
If they differ, generation fails with a structural diff. These probes are a
developer diagnostic, not a mathematical proof: arbitrary JavaScript cannot be
proven input-independent by sampling it.

For Bunderhost, the committed blueprint is the canonical provisioning contract.
A deployment preflight evaluates the declaration with the deployment's real
user-configured values and type-valid placeholders for resources that do not yet
exist. It compares the resulting deployment contract with the committed
blueprint and refuses a mismatch before provisioning.

After provisioning, startup evaluates the declaration with final platform
values and compares it with the same embedded blueprint before creating any
database or provider client. This closes the placeholder gap: a branch on a
specific managed database hostname cannot reach live traffic, although the
newly allocated resource may need normal failed-deployment cleanup.

### 4. Comparison boundary

Configuration objects are never compared directly. They may contain functions,
third-party instances, and secrets. Both sides are projected into the same
canonical deployment contract and then deeply compared.

The contract includes:

- database dialect, migrations directory and declared tables;
- storage bucket names, default bucket and visibility;
- realtime requirement;
- environment key metadata, never values;
- API operations;
- job names, cron names and schedules, and maintenance work;
- messaging channel names, channel kinds, and provider identifiers.

It excludes database URLs, authentication tokens, API keys, sender overrides,
message contents, and all other environment values.

Arrays are sorted by their stable identity before comparison. A mismatch error
shows added, removed, and changed contract paths without printing either config
object or any environment value.

### 5. Messaging replaces the singular email declaration

The public name is `messaging`, not `communications`. It describes outbound
delivery capabilities without implying that every channel is an email or that
the framework owns inbound conversations.

Configuration is a named object rather than an array:

```ts
messaging: {
  email: resend({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }),
  telegram: telegram({ botToken: env.TELEGRAM_BOT_TOKEN }),
  personalEmail: resend({
    apiKey: env.RESEND_API_KEY,
    from: 'Carl from Company <carl@company.com>',
  }),
}
```

The key is the application-facing channel name. There is no conditional `name`
field and duplicate providers need no special case. Provider factories return
pure descriptors tagged with a stable provider ID and channel kind. Network
clients are created only during materialization.

Provider credentials are optional. Every descriptor has an intrinsic capture
mode, so applications never select a separate console provider. Resolution
follows this order for every provider field:

1. a non-empty value explicitly supplied by the channel descriptor;
2. shared provider defaults injected by a hosting platform;
3. capture mode when required delivery configuration remains absent or empty.

An explicitly supplied value always wins over a managed default. This lets a
project use Bunderhost's shared Resend connection for most channels while an
advanced channel supplies credentials for another account. Invalid non-empty
configuration is an error; it never silently falls back to capture. A configured
provider whose network request fails records `failed`; it never retries through
capture.

In local development capture writes the journal when a database is present and
prints a provider-appropriate representation to the console. Under Bunderhost it
writes the journal without printing message bodies into production logs. The
status is `captured`, meaning recorded but not delivered.

The runtime and procedure context expose the same keys with provider-specific
message types:

```ts
await ctx.messaging.email.send({
  to: owner.email,
  subject: `Board complete: ${board.name}`,
  text: `Every todo is done. — ${ctx.env.PUBLIC_APP_NAME}`,
})

await ctx.messaging.telegram.send({
  to: user.telegramId,
  text: `Every todo is done. — ${ctx.env.PUBLIC_APP_NAME}`,
})
```

The first release supplies `resend(...)`, a custom email adapter descriptor, and
`telegram(...)`. SMTP remains a separate package factory and returns an email
descriptor. A custom descriptor declares the configuration required for real
delivery and supplies a console formatter; the registry owns capture selection.

The existing `email` config, `app.email`, `ctx.email`, and test email capture
remain as deprecated compatibility aliases for one release. When only legacy
`email` is configured it becomes `messaging.email`. Declaring both legacy
`email` and `messaging.email` is an error; other messaging keys may coexist with
legacy email during migration.

### 6. Message journal

The email-only journal becomes:

```text
_bunderstack_messages
_bunderstack_message_events
```

Each message records its channel name, kind, provider, delivery status,
credential source (`explicit`, `managed`, or `capture`), provider ID, normalized
recipients, provider-specific content JSON, safe error, and timestamps. Email
content contains subject, HTML, text, sender, reply-to, cc, and bcc. Telegram
content contains chat ID, text, and parse mode. Provider webhook events reference
the general message ID.

The initial status vocabulary is `captured`, `sending`, `sent`, `delivered`, and
`failed`. Providers may append normalized delivery events such as `opened`,
`clicked`, `bounced`, or `complained` without changing the channel kind.

Legacy email tables remain readable for one compatibility release but receive
no new rows after a legacy email config is normalized into `messaging.email`.
Bunderhost merges legacy rows into the Messaging view so existing history does
not disappear.

### 7. Authentication integration

Better Auth's default verification and reset mail hooks use
`messaging.email` by convention. If it is absent, Bunderstack does not guess
another email-kind channel. Applications with only `personalEmail` must wire
their Better Auth callbacks explicitly or add an `email` alias.

Telegram and other channels do not participate in Better Auth defaults.

### 8. Testing

`backend.test({ env })` resolves the declaration with that test's env. Each
declared channel receives an isolated capture adapter. The primary surface is:

```ts
t.messaging.email.sent
t.messaging.telegram.sent
```

`t.email` remains a deprecated alias of `t.messaging.email` when that channel
is email-kind. Captures preserve the provider-specific input type and never send
network requests.

Tests cover independent fixtures started from one backend with different env
values so no resolved configuration leaks between starts.

### 9. Blueprint compatibility

The manifest version increments from 3 to 4 because it gains the required
`messaging.channels` collection. Blueprint version remains 1: its open schema
already permits additive sections. New generators add:

```yaml
resources:
  messaging:
    channels:
      - name: email
        kind: email
        provider: resend
      - name: telegram
        kind: telegram
        provider: telegram
```

Older Bunderhost versions ignore the additive section. Bunderhost enables
declaration preflight only for blueprints whose `manifestVersion` is 4 or newer.
Older committed blueprints continue through the existing deployment path.

### 10. Hosting provider defaults

A hosting platform may inject one shared connection per provider type. Runtime
consumes a reserved `BUNDERSTACK_MESSAGING_CONFIG` JSON object keyed by stable
provider ID:

```json
{
  "resend": {
    "apiKey": "...",
    "defaultFrom": "Company <hello@example.com>"
  },
  "telegram": { "botToken": "..." }
}
```

This value is runtime-only, sensitive, absent from manifests, and not exposed as
application `ctx.env`. Provider descriptors merge these defaults field by field
underneath explicit channel configuration. Bunderhost stores one managed
connection for `resend` and one for `telegram` per project, not one per channel.
Several named Resend channels share the sending key and webhook while retaining
independent `from` values; `defaultFrom` is used only when a channel and message
omit their own sender.

### 11. Security and failure behavior

- Probe and preflight output never contains environment values.
- User secrets reach preflight only as environment variables of an ephemeral
  process/container, never as Docker build arguments or image layers.
- Commands and errors print key names and contract paths, not values.
- A failed preflight creates no managed application resources.
- A final runtime mismatch prevents database/provider connections and worker
  startup, and readiness never becomes healthy.
- Blueprint generation validates all probe manifests before atomically replacing
  the existing file.

## Deployment sequence

The Bunderhost sequence becomes:

```text
load committed blueprint
  -> validate configured environment keys
  -> resolve deployment target and materialize source
  -> build image
  -> run declaration preflight in an ephemeral container
  -> compare contract with committed blueprint
  -> provision/reuse database and bucket
  -> apply migrations
  -> deploy candidate
  -> candidate verifies actual contract before client creation
  -> health check and cutover
```

Build remains before provisioning for both production and preview deployments.
Preview parent resources are created only after that preview's build and
preflight succeed.

## Non-goals

- Proving that an arbitrary TypeScript function is mathematically pure.
- Preventing dynamic configuration in self-hosted applications.
- Serializing secrets or runtime values into manifests or blueprints.
- Supporting inbound Telegram updates or a general conversation model.
- Automatically selecting an arbitrary email-kind channel for Better Auth.
- Multiple named managed accounts for the same provider type in the first
  release; advanced applications supply explicit credentials instead.
- Deleting existing resources on an ordinary failed redeploy.
