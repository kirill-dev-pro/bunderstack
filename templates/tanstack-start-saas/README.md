# BunderSaaS — Bunderstack + TanStack Start SaaS Template

BunderSaaS is a production-ready SaaS template built with **Bunderstack** and **TanStack Start**. It features 2 separate dashboards (Client Workspace and Admin Portal) with distinct TanStack Start auth contexts (`clientAuth` and `adminAuth`), owner-scoped CRUD, email/password authentication (Better Auth), real-time delivery status, file attachments, and background task processing.

## Quick Start

### 1. Installation

```bash
bun install
```

### 2. Environment Setup

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### 3. Database & Schema Provisioning

Generate or push database schema:

```bash
bun run db:generate
```

### 4. Development Server

Start the full stack development server (Vite + SSR + Bunderstack backend):

```bash
bun run dev
```

Run the background worker in a separate terminal:

```bash
bun run worker
```

### 5. Blueprint Validation

Validate the Bunderstack blueprint manifest:

```bash
bun run blueprint:check
```

To update the blueprint manifest:

```bash
bun run blueprint
```

## Code Quality

This template includes Uncheck, Oxlint, and Oxfmt. `.oxfmtrc.json` is a copy
of Bunderstack's formatting defaults, not a shared preset: edit it freely for
your project. Oxlint uses its default rules; add `.oxlintrc.json` to customize
them.

```bash
bun run check # lint, check formatting, and type check the whole project
bun run fix   # apply safe lint fixes and formatting
```

After `git init`, `bun install` installs a pre-commit hook through `prepare`.
If you installed before initializing Git, run `bun run prepare` afterwards.
Each commit lints and formats staged files, stages safe fixes, and blocks on
remaining errors. Uncheck preserves partially staged changes. Type checking
is left to `bun run check` rather than the commit hook.

Run `bun run check` in CI too: local hooks can be skipped. Production installs
that omit devDependencies should disable lifecycle scripts, since `prepare`
needs the development tooling.

## Features

- **Dual Dashboards & Auth Contexts**:
  - **Client Workspace (`/app/*`)**: Guarded by `clientAuth` route context for project owners.
  - **Admin Portal (`/admin/*`)**: Guarded by `adminAuth` route context (`role: 'admin'`).
- **Catch-all API Routing**: Integrated via `createApiHandlers(app)` in `src/routes/api/$.tsx`.
- **Typed Client**: Exported via `bunderstackStart<App>()` in `src/api.ts`.
- **Auth Flow**: Complete Better Auth sign-in (`/login`) and registration (`/register`) with session management.
- **BunderSaaS Delivery Rail**: Visual and interactive status tracking for client project deliverables.
- **shadcn/ui Ready**: Fully configured with `components.json`, Tailwind v4, Radix primitives, Lucide icons, and `cn()` helper (`bunx shadcn@latest add <component>`).
