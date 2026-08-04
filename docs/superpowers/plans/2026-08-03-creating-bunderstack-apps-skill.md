# Creating Bunderstack Apps Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repository-owned skill that reliably guides agents from a new-product brief to a correctly structured Bunderstack application.

**Architecture:** Keep the skill procedural and concise. Put detailed current API contracts in direct references, point full SaaS requests to the separately tested repository template, and use repository tests plus fresh-context scenarios to verify discovery and application.

**Tech Stack:** Markdown agent skill, OpenAI skill metadata, Bun tests, Bunderstack 0.15.x APIs.

## Global Constraints

- Create the skill at `.agents/skills/creating-bunderstack-apps/`.
- Do not embed or duplicate the application template in the skill.
- Treat TanStack Start as canonical and other frameworks as Web Standard handler integrations.
- Use Bun commands only.
- Complete RED, GREEN, and REFACTOR before starting the migration skill.

---

### Task 1: Baseline scenarios and repository contract

**Files:**
- Create: `scripts/skills-contract.test.ts`
- Create: `docs/superpowers/plans/evidence/creating-bunderstack-apps-baseline.md`

**Interfaces:**
- Consumes: approved design at `docs/plans/2026-08-03-bunderstack-app-skill-template-design.md`.
- Produces: executable structural expectations and recorded no-skill failure evidence.

- [ ] **Step 1: Run three fresh-context scenarios without the skill**

Use these prompts without exposing the desired answer:

```text
Start a production-ready Bunderstack SaaS on TanStack Start with auth, projects,
tasks, jobs, realtime, storage, email, and deployment scripts.
```

```text
Add Bunderstack to a tiny Bun JSON API. Keep the setup proportionate to the
project and show how HTTP traffic reaches Bunderstack.
```

```text
Build a React SPA backed by Bunderstack. Explain which process owns the API and
how the frontend reaches it.
```

Record whether the agent chooses the correct layout, handler, worker model,
realtime publish signature, provisioning, and template path.

- [ ] **Step 2: Write the failing repository contract test**

```ts
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const skill = resolve(root, '.agents/skills/creating-bunderstack-apps')

describe('creating-bunderstack-apps skill', () => {
  test('declares a discoverable repository skill', () => {
    const markdown = readFileSync(resolve(skill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain('name: creating-bunderstack-apps')
    expect(markdown).toContain('description: Use when')
    expect(existsSync(resolve(skill, 'agents/openai.yaml'))).toBe(true)
  })

  test('points full apps to the versioned template without embedding it', () => {
    const markdown = readFileSync(resolve(skill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain('templates/tanstack-start-saas')
    expect(existsSync(resolve(skill, 'assets'))).toBe(false)
  })
})
```

- [ ] **Step 3: Verify RED**

Run: `bun test scripts/skills-contract.test.ts`

Expected: FAIL because `.agents/skills/creating-bunderstack-apps/SKILL.md` does not exist.

- [ ] **Step 4: Commit baseline evidence and test**

```bash
git add scripts/skills-contract.test.ts docs/superpowers/plans/evidence/creating-bunderstack-apps-baseline.md
git commit -m "test: define creating Bunderstack skill contract"
```

---

### Task 2: Initialize and author the minimal skill

**Files:**
- Create: `.agents/skills/creating-bunderstack-apps/SKILL.md`
- Create: `.agents/skills/creating-bunderstack-apps/agents/openai.yaml`
- Create: `.agents/skills/creating-bunderstack-apps/references/application-structure.md`
- Create: `.agents/skills/creating-bunderstack-apps/references/runtime-integrations.md`
- Create: `.agents/skills/creating-bunderstack-apps/references/verification.md`

**Interfaces:**
- Consumes: current `createBunderstack`, `createApiHandlers`, `bunderstackStart`, `provision`, `runWorker`, blueprint, access, storage, jobs, and realtime APIs.
- Produces: `$creating-bunderstack-apps` and three directly linked references.

- [ ] **Step 1: Initialize through the official skill generator**

```bash
python3 /Users/kirill/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  creating-bunderstack-apps \
  --path .agents/skills \
  --resources references \
  --interface display_name="Creating Bunderstack Apps" \
  --interface short_description="Start production-ready Bunderstack applications" \
  --interface 'default_prompt=Use $creating-bunderstack-apps to start a new Bunderstack application.'
```

- [ ] **Step 2: Replace SKILL.md with the decision-oriented workflow**

The body must contain this order:

```markdown
# Creating Bunderstack Apps

## Workflow
1. Inspect the product brief and target runtime.
2. Choose the layout from the table below.
3. For a full TanStack Start SaaS, copy `templates/tanstack-start-saas/`.
4. Configure schema, access, auth, env, storage, jobs, realtime, and tRPC.
5. Mount the single `app.handler` integration.
6. Add committed migrations and a deployment blueprint before production.
7. Run the verification contract.

| Condition | Layout |
| --- | --- |
| Small API with short configuration | `src/bunderstack.ts` |
| Auth, access, jobs, env, or tRPC need independent modules | `src/bunderstack/` |
| Full SaaS | Copy `templates/tanstack-start-saas/` and keep its modular layout |
```

Link each reference directly and state exactly when to read it.

- [ ] **Step 3: Write references with current contracts**

`application-structure.md` defines entry purity, schema aggregation, access
scopes, auth schema, environment ownership, and direct Drizzle publish rules.
`runtime-integrations.md` shows:

```ts
export const Route = createFileRoute('/api/$')({
  server: { handlers: createApiHandlers(app) },
})

Bun.serve({ fetch: app.handler })
```

It also states that Astro adapters convert to/from Web Standard requests and a
browser-only React SPA needs a separate Bun API process. `verification.md`
defines `bun install`, `bun test`, `bun run typecheck`, `bun run build`,
`bun run blueprint`, and `bun run blueprint:check` gates.

- [ ] **Step 4: Validate and run GREEN**

```bash
python3 /Users/kirill/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/creating-bunderstack-apps
bun test scripts/skills-contract.test.ts
```

Expected: validator succeeds and contract tests pass.

- [ ] **Step 5: Commit the minimal skill**

```bash
git add .agents/skills/creating-bunderstack-apps scripts/skills-contract.test.ts
git commit -m "feat: add creating Bunderstack apps skill"
```

---

### Task 3: Forward-test and refactor the skill

**Files:**
- Modify: `.agents/skills/creating-bunderstack-apps/SKILL.md`
- Modify as needed: `.agents/skills/creating-bunderstack-apps/references/*.md`
- Create: `docs/superpowers/plans/evidence/creating-bunderstack-apps-forward.md`

**Interfaces:**
- Consumes: the same three prompts from Task 1 with explicit `$creating-bunderstack-apps` invocation.
- Produces: evidence that layout and runtime decisions improve with the skill loaded.

- [ ] **Step 1: Re-run all baseline scenarios with the skill**

Score each output for the seven criteria recorded in Task 1. Do not tell the
fresh-context agent which baseline failures are expected.

- [ ] **Step 2: Refactor only observed gaps**

Use a positive decision recipe for wrong-shaped outputs. Add prohibitions only
for an observed discipline failure. Keep `SKILL.md` under 500 lines and keep
detailed material in its three references.

- [ ] **Step 3: Re-run validation and tests**

```bash
python3 /Users/kirill/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/creating-bunderstack-apps
bun test scripts/skills-contract.test.ts
```

- [ ] **Step 4: Commit verified skill evidence**

```bash
git add .agents/skills/creating-bunderstack-apps docs/superpowers/plans/evidence/creating-bunderstack-apps-forward.md
git commit -m "docs: verify creating Bunderstack skill"
```
