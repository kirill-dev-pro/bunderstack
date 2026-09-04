# Messaging Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the singular email configuration with a typed named messaging registry supporting email and Telegram while retaining one-release email compatibility aliases.

**Architecture:** Provider factories create pure tagged descriptors with optional credentials. Runtime materialization merges explicit channel configuration over shared hosting defaults, selects real delivery only when required fields are non-empty, and otherwise captures to the message journal (plus console locally). Testing substitutes isolated capture facades for every declared channel.

**Tech Stack:** Bun, TypeScript, Fetch, Drizzle message journal, oRPC context.

**Spec:** `docs/superpowers/specs/2026-09-04-env-first-declarations-design.md`

## Global Constraints

- The public field is `messaging`, represented as a named object.
- Provider factories perform no network I/O during declaration or inspection.
- Channel keys and provider kinds reach manifest/blueprint; credentials never do.
- Legacy `email` configuration and facades remain deprecated aliases for one release.
- Better Auth defaults use only the channel named `email`.
- Explicit channel credentials override managed provider defaults field by field.
- Missing or empty required delivery configuration selects capture; invalid
  non-empty configuration and delivery failures do not.
- Bunderstack has no public console provider; capture behavior belongs to every
  provider descriptor.

---

### Task 1: Define provider descriptors and inferred registry types

**Files:**

- Create: `packages/bunderstack/src/messaging/types.ts`
- Create: `packages/bunderstack/src/messaging/email.ts`
- Create: `packages/bunderstack/src/messaging/telegram.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Modify: `packages/bunderstack/package.json`
- Test: `packages/bunderstack/src/messaging/types.test.ts`

**Interfaces:**

- Produces: `MessagingDescriptor<TKind, TProvider, TInput, TResult>`, `MessagingFacade<TDescriptor>`, `resend`, `customEmail`, and `telegram`.
- Consumes: existing `EmailMessage`, `EmailAdapter`, and `SentEmail` contracts.

- [ ] **Step 1: Write failing type tests**

Assert that this registry preserves distinct inputs:

```ts
const config = {
  email: resend({ apiKey: 'key', from: 'App <app@test.dev>' }),
  telegram: telegram({ botToken: 'token' }),
}
type Facades = MessagingFacades<typeof config>
expectTypeOf<
  Parameters<Facades['email']['send']>[0]
>().toMatchTypeOf<EmailMessage>()
expectTypeOf<Parameters<Facades['telegram']['send']>[0]>().toEqualTypeOf<{
  to: string | number
  text: string
  parseMode?: 'HTML' | 'MarkdownV2'
}>()
```

- [ ] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/messaging/types.test.ts
```

Expected: FAIL because descriptors do not exist.

- [ ] **Step 3: Implement pure descriptors**

Use a private symbol brand and immutable metadata:

```ts
type MessagingDescriptor<K, P, I, O> = {
  readonly kind: K
  readonly provider: P
  readonly config: unknown
  readonly [MESSAGING_DESCRIPTOR]: { input: I; output: O }
}
```

Factories store credentials inside `config` but expose only `kind` and
`provider` to manifest construction. Resend's `apiKey` and Telegram's
`botToken` are optional strings; absent and empty values remain distinguishable
from invalid non-empty values until runtime resolution.

- [ ] **Step 4: Export provider subpaths and run typecheck**

```bash
bunx tsc --noEmit -p packages/bunderstack/tsconfig.json
```

Expected: PASS with public declaration emit free of private dependency names.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/messaging packages/bunderstack/src/index.ts packages/bunderstack/package.json
git commit -m "feat: define messaging provider descriptors"
```

---

### Task 2: Materialize messaging facades

**Files:**

- Create: `packages/bunderstack/src/messaging/runtime.ts`
- Create: `packages/bunderstack/src/messaging/journal.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Modify: `packages/bunderstack/src/api/context.ts`
- Modify: `packages/bunderstack/src/internal-tables.ts`
- Test: `packages/bunderstack/src/messaging/runtime.test.ts`
- Test: `packages/bunderstack/src/internal-tables.test.ts`
- Test: `packages/bunderstack/src/api/context.test.ts`

**Interfaces:**

- Consumes: named descriptor record from `config.messaging`.
- Produces: `createMessaging(config, options)` and typed `app.messaging` / `ctx.messaging`.

- [ ] **Step 1: Write failing runtime tests**

Test two Resend channels with different senders plus one Telegram channel.
Assert explicit credentials beat `BUNDERSTACK_MESSAGING_CONFIG`, missing and
empty credentials capture, managed defaults fill only missing fields, invalid
non-empty credentials fail, and a failed request never becomes captured. Assert
configured Telegram calls `https://api.telegram.org/bot<TOKEN>/sendMessage`
with `chat_id` and `text`.

- [ ] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/messaging/runtime.test.ts packages/bunderstack/src/api/context.test.ts
```

Expected: FAIL because app/context expose only `email`.

- [ ] **Step 3: Implement provider materialization**

Move reusable email adapter creation behind the email descriptor materializer.
Parse the reserved `BUNDERSTACK_MESSAGING_CONFIG` as a provider-keyed object and
merge managed fields underneath explicit fields. Build the registry with
`Object.fromEntries`, preserving keys in the generic return type. Validate
non-empty unique object keys and reject unbranded values.

Select capture only when a required merged field is absent or trims to empty.
In development, format the message to console. When
`BUNDERHOST_ENVIRONMENT_ID` is present, suppress body logging while retaining
the journal row.

- [ ] **Step 4: Thread the registry through runtime and API context**

Replace internal single-email dependencies with `messaging`. Add
`_bunderstack_messages` and `_bunderstack_message_events` with channel, kind,
provider, credential source (`explicit`, `managed`, or `capture`), provider ID,
status, recipients JSON, content JSON, safe error, and timestamps. Journal every
channel kind; provider-specific delivery events point to the general message ID.

- [ ] **Step 5: Run focused tests**

```bash
bun test packages/bunderstack/src/messaging/runtime.test.ts packages/bunderstack/src/internal-tables.test.ts packages/bunderstack/src/api/context.test.ts packages/bunderstack/src/email.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/messaging/runtime.ts packages/bunderstack/src/messaging/journal.ts packages/bunderstack/src/messaging/runtime.test.ts packages/bunderstack/src/config.ts packages/bunderstack/src/runtime.ts packages/bunderstack/src/api/context.ts packages/bunderstack/src/api/context.test.ts packages/bunderstack/src/internal-tables.ts packages/bunderstack/src/internal-tables.test.ts packages/bunderstack/src/email.test.ts
git commit -m "feat: expose typed messaging facades"
```

---

### Task 3: Preserve legacy email and Better Auth behavior

**Files:**

- Modify: `packages/bunderstack/src/email.ts`
- Modify: `packages/bunderstack/src/auth.ts`
- Modify: `packages/bunderstack/src/config.ts`
- Modify: `packages/bunderstack/src/runtime.ts`
- Test: `packages/bunderstack/src/auth-email.test.ts`
- Test: `packages/bunderstack/src/config.test.ts`

**Interfaces:**

- Consumes: legacy `email` or `messaging.email`.
- Produces: deprecated `app.email` and `ctx.email` aliases, plus Better Auth defaults wired only to `messaging.email`.

- [ ] **Step 1: Write failing compatibility tests**

Cover legacy-only normalization, messaging-only behavior, both declarations
colliding at `email`, legacy email coexisting with `messaging.telegram`, and an
email provider named only `personalEmail` not being selected for auth defaults.
Assert normalized legacy sends create only a `_bunderstack_messages` row and do
not append to `_bunderstack_emails`.

- [ ] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/auth-email.test.ts packages/bunderstack/src/config.test.ts
```

Expected: FAIL until normalization exists.

- [ ] **Step 3: Add one-release normalization**

Normalize before materialization:

```ts
const messaging = {
  ...(legacyEmail ? { email: legacyEmailDescriptor(legacyEmail) } : {}),
  ...declaredMessaging,
}
```

Throw `[bunderstack] configure either email or messaging.email, not both` on
collision. Mark old types and properties with `@deprecated` JSDoc.

- [ ] **Step 4: Wire Better Auth to the conventional channel**

Pass `messaging.email` to `withEmailAuthDefaults` only when its descriptor kind
is `email`. Do not search other keys.

- [ ] **Step 5: Verify auth and email tests**

```bash
bun test packages/bunderstack/src/auth-email.test.ts packages/bunderstack/src/email.test.ts packages/bunderstack/src/config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/bunderstack/src/email.ts packages/bunderstack/src/auth.ts packages/bunderstack/src/config.ts packages/bunderstack/src/runtime.ts packages/bunderstack/src/auth-email.test.ts packages/bunderstack/src/config.test.ts
git commit -m "feat: bridge legacy email into messaging"
```

---

### Task 4: Add messaging test capture

**Files:**

- Create: `packages/bunderstack/src/testing/messaging.ts`
- Modify: `packages/bunderstack/src/testing/email.ts`
- Modify: `packages/bunderstack/src/testing/fixture.ts`
- Test: `packages/bunderstack/src/testing/fixture.test.ts`
- Test: `packages/bunderstack/src/testing/infrastructure.test.ts`

**Interfaces:**

- Consumes: messaging descriptors from a resolved test declaration.
- Produces: `t.messaging` with per-channel `sent` arrays and deprecated `t.email` alias.

- [ ] **Step 1: Write failing isolation tests**

Send one email and one Telegram message through a fixture, assert separate typed
captures, then create a second fixture and assert both capture arrays begin
empty.

- [ ] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/testing/fixture.test.ts packages/bunderstack/src/testing/infrastructure.test.ts
```

Expected: FAIL because fixtures only substitute one email adapter.

- [ ] **Step 3: Implement per-channel capture adapters**

Create one in-memory adapter per descriptor. Return overrides keyed by channel
name and expose readonly capture objects. Preserve the legacy email capture's
`sent`, `clear`, and failure controls on the conventional email channel.

- [ ] **Step 4: Run fixture tests**

```bash
bun test packages/bunderstack/src/testing/fixture.test.ts packages/bunderstack/src/testing/infrastructure.test.ts packages/bunderstack/src/testing/auth-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/testing/messaging.ts packages/bunderstack/src/testing/email.ts packages/bunderstack/src/testing/fixture.ts packages/bunderstack/src/testing/fixture.test.ts packages/bunderstack/src/testing/infrastructure.test.ts
git commit -m "feat: capture messaging in test fixtures"
```

---

### Task 5: Publish messaging topology in manifest and blueprint

**Files:**

- Modify: `packages/bunderstack/src/manifest.ts`
- Modify: `packages/bunderstack/src/blueprint.ts`
- Modify: `packages/bunderstack/src/backend.ts`
- Test: `packages/bunderstack/src/manifest.test.ts`
- Test: `packages/bunderstack/src/blueprint.test.ts`

**Interfaces:**

- Consumes: descriptor records.
- Produces: manifest version 4 and `resources.messaging.channels` in blueprint version 1.

- [ ] **Step 1: Write failing manifest round-trip tests**

Assert sorted entries exactly equal:

```ts
;[
  { name: 'email', kind: 'email', provider: 'resend' },
  { name: 'personalEmail', kind: 'email', provider: 'resend' },
  { name: 'telegram', kind: 'telegram', provider: 'telegram' },
]
```

Assert duplicate names are rejected by parsers and no descriptor config reaches
serialized output.

- [ ] **Step 2: Run tests and verify failure**

```bash
bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/blueprint.test.ts
```

Expected: FAIL with manifest version 3.

- [ ] **Step 3: Extend schemas and conversion**

Increment manifest to version 4. Add strict manifest entries and an additive,
open blueprint `resources.messaging` section. Sort channels by `name` in both
models.

- [ ] **Step 4: Run serialization tests**

```bash
bun test packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/blueprint-generator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bunderstack/src/manifest.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/blueprint.ts packages/bunderstack/src/blueprint.test.ts packages/bunderstack/src/backend.ts packages/bunderstack/src/blueprint-generator.test.ts
git commit -m "feat: publish messaging topology"
```

---

### Task 6: Document and verify messaging

**Files:**

- Replace: `website/content/docs/email.mdx`
- Modify: `website/content/docs/api-reference.mdx`
- Modify: `website/scripts/gen-code-snippets.ts`
- Modify: `docs/MIGRATION-0.24.md`

**Interfaces:**

- Consumes: completed messaging API.
- Produces: migration examples and verified package declarations.

- [ ] **Step 1: Replace email documentation with messaging documentation**

Cover named channels, Resend, SMTP, custom email, Telegram, Better Auth
convention, implicit local/hosted capture, managed provider defaults, testing
capture, and legacy migration:

```ts
email: { from, provider: 'resend' }
// becomes
messaging: { email: resend({ from, apiKey: env.RESEND_API_KEY }) }
```

- [ ] **Step 2: Regenerate snippets**

```bash
bun run website/scripts/gen-code-snippets.ts
```

Expected: generated snippets use `ctx.messaging.email`.

- [ ] **Step 3: Run complete verification**

```bash
bun test packages/bunderstack/src/messaging packages/bunderstack/src/email.test.ts packages/bunderstack/src/auth-email.test.ts packages/bunderstack/src/testing/fixture.test.ts packages/bunderstack/src/manifest.test.ts packages/bunderstack/src/blueprint.test.ts
bun run build
bun run verify:consumer
bun run typecheck:all
```

Expected: all commands PASS.

- [ ] **Step 4: Commit**

```bash
git add website/content/docs/email.mdx website/content/docs/api-reference.mdx website/scripts/gen-code-snippets.ts website/src/lib/code-snippets.gen.json docs/MIGRATION-0.24.md
git commit -m "docs: migrate email to messaging channels"
```
