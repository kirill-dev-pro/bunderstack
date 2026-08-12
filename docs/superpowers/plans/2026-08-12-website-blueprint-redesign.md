# Website Blueprint Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stale tRPC/Hono/SSE public story with an accurate oRPC-first documentation set and an expressive architectural-blueprint landing page.

**Architecture:** Public documentation is the source of truth for concepts and task instructions. The landing page uses a small, purpose-built set of generated type-safe snippets and focused React sections; shared CSS tokens carry the identity into Fumadocs without replacing its navigation primitives.

**Tech Stack:** TanStack Start, React 19, Tailwind CSS 4, Fumadocs, Shiki/Twoslash, Bun tests.

## Global Constraints

- Keep historical files under `docs/plans` and `docs/superpowers` unchanged except for this design and implementation plan.
- Use oRPC, Standard Schema, and Valibot in current public examples.
- Show inferred types only for significant values and boundaries.
- Keep the page responsive, keyboard accessible, and respectful of `prefers-reduced-motion`.
- Add no new runtime dependency.

---

### Task 1: Public website contracts

**Files:**

- Create: `scripts/website-contract.test.ts`
- Modify: `website/content/docs/meta.json`

**Interfaces:**

- Consumes: public MDX, landing source, and snippet generator source.
- Produces: executable constraints for current terminology, navigation, and type-trace scope.

- [ ] Write tests that require `api-procedures`, oRPC/Standard Schema/Publisher guidance, mutation reconciliation, and the blueprint/type-trace landing vocabulary.
- [ ] Run `bun test scripts/website-contract.test.ts` and confirm failures identify the stale site.
- [ ] Rename navigation entries from `trpc` and `custom-routes` to `api-procedures` and `http-webhooks`.
- [ ] Keep the contract red until the corresponding content and UI tasks land.

### Task 2: Core documentation path

**Files:**

- Modify: `website/content/docs/index.mdx`
- Modify: `website/content/docs/getting-started.mdx`
- Modify: `website/content/docs/crud.mdx`
- Create: `website/content/docs/api-procedures.mdx`
- Modify: `website/content/docs/query-client.mdx`
- Modify: `website/content/docs/sync-collections.mdx`
- Delete: `website/content/docs/trpc.mdx`

**Interfaces:**

- Consumes: `createBunderstack({ api: (o) })`, `createClient<App>`, generated CRUD procedures, and `realtime.changes`.
- Produces: the primary learning sequence linked by the landing page.

- [ ] Rewrite the introduction around one typed graph and one Web Standard handler.
- [ ] Make Getting Started use Valibot and a minimal custom procedure.
- [ ] Explain CRUD as generated procedures available over typed RPC and ordinary HTTP.
- [ ] Document public, protected, and webhook procedure bases, optional output schemas, typed errors, and route metadata.
- [ ] Rewrite query-client examples to use oRPC `.call`, `.queryOptions`, and `.mutationOptions` utilities.
- [ ] Document Publisher transport, internal heartbeat/backoff, canonical mutation reconciliation, and reconnect refetch.

### Task 3: Capability and reference documentation

**Files:**

- Create: `website/content/docs/http-webhooks.mdx`
- Delete: `website/content/docs/custom-routes.mdx`
- Modify: all remaining files in `website/content/docs/*.mdx`

**Interfaces:**

- Consumes: the current package exports and the terminology established by Task 2.
- Produces: concise task pages with no legacy framework extension model.

- [ ] Replace Hono route instructions with oRPC HTTP procedures and webhook detailed inputs.
- [ ] Update env and job schemas to Standard Schema examples using Valibot.
- [ ] Update auth, email, storage, framework adapter, templates, and reference pages to the unified API context.
- [ ] Remove current public claims about tRPC, SuperJSON, custom SSE clients, Hono routers, and Zod as a required dependency.
- [ ] Run the contract test and confirm documentation assertions pass.

### Task 4: Focused typed snippets

**Files:**

- Modify: `website/scripts/gen-code-snippets.ts`
- Regenerate: `website/src/lib/code-snippets.gen.json`

**Interfaces:**

- Consumes: actual workspace package sources through TypeScript path mappings.
- Produces: `procedure`, `client`, and `realtime` highlighted snippets plus small supporting snippets.

- [ ] Replace the legacy tRPC/Zod/Hono virtual app with Valibot and `api: (o)`.
- [ ] Reduce landing snippets to the three primary stories and supporting capability examples.
- [ ] Add explicit type markers only for the important app, procedure result, and collection/event values.
- [ ] Run `bun website/scripts/gen-code-snippets.ts` and reject any degraded `any` hover.

### Task 5: Blueprint landing page

**Files:**

- Rewrite: `website/src/routes/index.tsx`
- Modify: `website/src/styles/app.css`
- Modify: `website/src/lib/layout.shared.tsx`
- Modify: `website/src/routes/__root.tsx`

**Interfaces:**

- Consumes: generated snippets and public docs routes.
- Produces: responsive landing UI and visually related documentation chrome.

- [ ] Build the hero system trace with semantic HTML and restrained motion.
- [ ] Build procedure, client, and realtime story sections with four to six static type traces.
- [ ] Replace the autoplay battery carousel with a capability map.
- [ ] Restyle examples, comparison, install CTA, navigation, and Fumadocs tokens.
- [ ] Add visible focus states, mobile type-label behavior, and reduced-motion rules.
- [ ] Run typecheck and website build.

### Task 6: Visual and repository verification

**Files:**

- Modify only files revealed by verification failures.

**Interfaces:**

- Consumes: the built website.
- Produces: evidence that content, rendering, and repository contracts pass.

- [ ] Run `bun test scripts/website-contract.test.ts scripts/skills-contract.test.ts scripts/template-contract.test.ts`.
- [ ] Run `bun run --cwd website build` and the repository typecheck.
- [ ] Inspect the homepage and documentation at desktop and mobile widths in the in-app browser.
- [ ] Exercise navigation, copy actions, code type labels, and keyboard focus.
- [ ] Run `git diff --check` and review the complete diff for unrelated changes.
