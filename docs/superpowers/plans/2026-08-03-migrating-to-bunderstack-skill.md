# Migrating to Bunderstack Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing Gemini migration skill into the repository and correct it for current Bunderstack APIs and deployment practices.

**Architecture:** Preserve the useful migration decision model, replace outdated runtime prescriptions with current contracts, and split detailed audit checklists into references. Validate this skill independently after the creating skill and template are complete.

**Tech Stack:** Markdown agent skill, OpenAI skill metadata, Bun contract tests, Bunderstack 0.15.x APIs.

## Global Constraints

- Source: `/Users/kirill/.gemini/config/skills/migrating-to-bunderstack/SKILL.md`.
- Destination: `.agents/skills/migrating-to-bunderstack/`.
- Keep migration and greenfield creation as separate trigger domains.
- Use separate production workers when queue jobs exist.
- Publish direct writes through `publish(table, event, completeRow)`.
- Prefer `createApiHandlers(app)` for TanStack Start.

---

### Task 1: Baseline migration failures

**Files:**

- Modify: `scripts/skills-contract.test.ts`
- Create: `docs/superpowers/plans/evidence/migrating-to-bunderstack-baseline.md`

**Interfaces:**

- Consumes: existing Gemini skill and current HR Breakers application shape.
- Produces: exact outdated claims and a failing repository contract.

- [ ] **Step 1: Run fresh-context migration scenarios without the repository skill**

```text
Migrate a TanStack Start app with Better Auth, BullMQ jobs, Resend, S3 wrappers,
and custom API routes to current Bunderstack. Keep production deployment safe.
```

```text
Review this large Bunderstack migration layout. Decide which compatibility
wrappers must be removed and whether the worker belongs in the web entry.
```

Score duplicate auth/DB instances, handler mounting, access scopes, jobs/cron,
worker topology, realtime direct writes, storage/email facades, migrations,
blueprint, and cleanup verification.

- [ ] **Step 2: Add a failing migration-skill contract**

```ts
test('migration skill uses current runtime contracts', () => {
  const markdown = readFileSync(
    resolve(root, '.agents/skills/migrating-to-bunderstack/SKILL.md'),
    'utf8',
  )
  expect(markdown).toContain(
    "ctx.realtime.publish(schema.tasks, 'update', row)",
  )
  expect(markdown).toContain('createApiHandlers(app)')
  expect(markdown).toContain('app.runWorker()')
  expect(markdown).not.toContain("ctx.realtime.publish('channel', payload)")
  expect(markdown).not.toContain('await app.startWorker()')
})
```

- [ ] **Step 3: Verify RED and commit evidence**

```bash
bun test scripts/skills-contract.test.ts
git add scripts/skills-contract.test.ts docs/superpowers/plans/evidence/migrating-to-bunderstack-baseline.md
git commit -m "test: define Bunderstack migration skill contract"
```

---

### Task 2: Initialize, migrate, and correct the skill

**Files:**

- Create: `.agents/skills/migrating-to-bunderstack/SKILL.md`
- Create: `.agents/skills/migrating-to-bunderstack/agents/openai.yaml`
- Create: `.agents/skills/migrating-to-bunderstack/references/audit-checklist.md`
- Create: `.agents/skills/migrating-to-bunderstack/references/runtime-replacements.md`

**Interfaces:**

- Produces: `$migrating-to-bunderstack`, a phased migration audit, and current replacement contracts.

- [ ] **Step 1: Initialize the destination through the official generator**

```bash
python3 /Users/kirill/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  migrating-to-bunderstack \
  --path .agents/skills \
  --resources references \
  --interface display_name="Migrating to Bunderstack" \
  --interface short_description="Move existing applications onto Bunderstack" \
  --interface 'default_prompt=Use $migrating-to-bunderstack to migrate this application to Bunderstack.'
```

- [ ] **Step 2: Rewrite the workflow around migration phases**

Use this sequence:

```markdown
1. Inventory current auth, DB, API, storage, email, jobs, cron, realtime, env,
   migrations, and deployment ownership.
2. Add a migration contract test before removing legacy paths.
3. Establish one Bunderstack app and schema aggregate.
4. Move auth and access without creating duplicate instances.
5. Replace infrastructure capability by capability.
6. Mount one handler and separate the production worker.
7. Remove wrappers only after call sites and tests move.
8. Generate migrations and blueprint, then verify production topology.
```

Keep HR Breakers as an architectural example, not as a universal file list.

- [ ] **Step 3: Correct outdated guidance**

Replace embedded workers with `src/worker.ts` and `await app.runWorker()`.
Explain the explicit process-local realtime override only for acknowledged local
or embedded use. Replace channel payload publishing with typed table/row
publishing after committed writes. Replace handwritten TanStack method maps
with `createApiHandlers(app)`. Require explicit database adapter imports,
committed Drizzle migrations, `package.json#bunderstack.entry`, blueprint check,
and `app.close()` in tests/scripts that own app instances.

- [ ] **Step 4: Add audit and replacement references**

`audit-checklist.md` maps legacy capability, authoritative replacement, evidence,
and deletion gate. `runtime-replacements.md` contains complete current snippets
for modular entry, TanStack route, worker, direct realtime write, storage,
email, env, provisioning, and blueprint scripts.

- [ ] **Step 5: Validate and run GREEN**

```bash
python3 /Users/kirill/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/migrating-to-bunderstack
bun test scripts/skills-contract.test.ts
```

- [ ] **Step 6: Commit corrected migration skill**

```bash
git add .agents/skills/migrating-to-bunderstack scripts/skills-contract.test.ts
git commit -m "feat: add current Bunderstack migration skill"
```

---

### Task 3: Independent forward test and refactor

**Files:**

- Modify as needed: `.agents/skills/migrating-to-bunderstack/**`
- Create: `docs/superpowers/plans/evidence/migrating-to-bunderstack-forward.md`

**Interfaces:**

- Consumes: the Task 1 prompts with explicit `$migrating-to-bunderstack` invocation.
- Produces: migration evidence with no leaked expected answer.

- [ ] **Step 1: Re-run baseline prompts with the repository skill**

Require a phased plan that preserves a working system, identifies dual-instance
risks, uses current runtime contracts, and provides deletion gates.

- [ ] **Step 2: Refactor observed gaps and re-run scenarios**

Do not add hypothetical sections. Put detailed additions in one of the two
references and keep the central workflow scannable.

- [ ] **Step 3: Run final validation**

```bash
python3 /Users/kirill/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/migrating-to-bunderstack
bun test scripts/skills-contract.test.ts
bun run test
```

- [ ] **Step 4: Commit final evidence**

```bash
git add .agents/skills/migrating-to-bunderstack docs/superpowers/plans/evidence/migrating-to-bunderstack-forward.md
git commit -m "docs: verify Bunderstack migration skill"
```
