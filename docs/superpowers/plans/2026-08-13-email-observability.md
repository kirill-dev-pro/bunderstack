# Email Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release Bunderstack 0.17.1 with a provider-neutral, host-readable journal for every outgoing email.

**Architecture:** `createEmail` becomes a journaled facade backed by Bunderstack's internal Drizzle tables. It writes before provider delivery, updates after the provider response, and exposes provider-neutral event application helpers for hosts.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, libSQL/SQLite, PostgreSQL/PGlite, Resend HTTP API.

**Spec:** `docs/superpowers/specs/2026-08-13-email-observability-design.md`

## Global Constraints

- Preserve custom email adapters and the existing `app.email.send()` call shape.
- Do not add the Resend SDK.
- Support SQLite and PostgreSQL internal-table twins.
- Keep manifest version 3 and blueprint version 1.
- Use Bun for tests, builds, formatting, and typechecking.

---

### Task 1: Internal email tables

**Files:**

- Modify: `packages/bunderstack/src/internal-tables.ts`
- Modify: `packages/bunderstack/src/internal-tables-pg.ts`
- Modify: `packages/bunderstack/src/schema-export.ts`
- Modify: `packages/bunderstack/src/schema-export-pg.ts`
- Modify: `packages/bunderstack/src/manifest.ts`
- Test: `packages/bunderstack/src/internal-tables.test.ts`
- Test: `packages/bunderstack/src/manifest.test.ts`

**Interfaces:**

- Produces: `emailsTableFor(db)`, `emailEventsTableFor(db)`, `_system.emails`, and `_system.emailEvents`.

- [ ] Add failing SQLite/Postgres table-identity and manifest tests.
- [ ] Run the focused tests and confirm the new exports/system declarations are missing.
- [ ] Add the dialect twins, internal-table registration, schema exports, and manifest entries.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Journaled email facade

**Files:**

- Modify: `packages/bunderstack/src/email.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/email.test.ts`

**Interfaces:**

- Consumes: `emailsTableFor(db)` and `emailEventsTableFor(db)`.
- Produces: `createEmail(config, { env, db, fetchFn })`, `SentEmail { id, providerId? }`, and persisted lifecycle states.

- [ ] Add failing tests proving capture-only persistence, Resend correlation tags, successful provider IDs, and persisted failures.
- [ ] Run the focused tests and verify each fails because journaling is absent.
- [ ] Inject the merged-schema database into `createEmail`, generate an internal UUID, persist before delivery, and update after delivery.
- [ ] Make an omitted provider capture-only in production and allow `BUNDERSTACK_EMAIL_PROVIDER=resend` to select Resend.
- [ ] Run the focused tests and the auth-email tests.

### Task 3: Provider event application

**Files:**

- Create: `packages/bunderstack/src/email-events.ts`
- Modify: `packages/bunderstack/src/index.ts`
- Test: `packages/bunderstack/src/email-events.test.ts`

**Interfaces:**

- Produces: `applyEmailEvent(db, { externalId, emailId, type, occurredAt, detail })` with idempotent timeline insertion and delivery-state precedence.

- [ ] Add failing tests for duplicate events, out-of-order delivered/opened events, bounce detail, and missing email IDs.
- [ ] Run the test and confirm the event API is absent.
- [ ] Implement provider-neutral event normalization and transactional persistence.
- [ ] Run focused and package tests.

### Task 4: Release metadata and verification

**Files:**

- Modify: `packages/bunderstack/package.json`
- Modify: `CHANGELOG.md`
- Modify: `packages/bunderstack/README.md`
- Modify: `packages/bunderstack/llms.txt`
- Modify: `bun.lock`

**Interfaces:**

- Produces: publishable `bunderstack@0.17.1` documentation and package metadata.

- [ ] Update the version and document capture-only plus hosted Resend behavior.
- [ ] Run `bun test --cwd packages/bunderstack`.
- [ ] Run `bun run typecheck`, `bun run build`, and `bun run verify:consumer`.
