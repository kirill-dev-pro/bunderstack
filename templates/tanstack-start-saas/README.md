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

## Features

- **Dual Dashboards & Auth Contexts**:
  - **Client Workspace (`/app/*`)**: Guarded by `clientAuth` route context for project owners.
  - **Admin Portal (`/admin/*`)**: Guarded by `adminAuth` route context (`role: 'admin'`).
- **Catch-all API Routing**: Integrated via `createApiHandlers(app)` in `src/routes/api/$.tsx`.
- **Typed Client**: Exported via `bunderstackStart<App>()` in `src/api.ts`.
- **Auth Flow**: Complete Better Auth sign-in (`/login`) and registration (`/register`) with session management.
- **BunderSaaS Delivery Rail**: Visual and interactive status tracking for client project deliverables.
- **shadcn/ui Ready**: Fully configured with `components.json`, Tailwind v4, Radix primitives, Lucide icons, and `cn()` helper (`bunx shadcn@latest add <component>`).
