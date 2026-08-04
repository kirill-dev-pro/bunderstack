# Relay — Bunderstack + TanStack Start SaaS Template

Relay is a production-ready SaaS template built with **Bunderstack** and **TanStack Start**. It features a creative studio project delivery workspace with owner-scoped CRUD, email/password authentication (Better Auth), real-time delivery status, file attachments, and an admin dashboard.

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

- **Catch-all API Routing**: Integrated via `createApiHandlers(app)` in `src/routes/api/$.tsx`.
- **Typed Client**: Exported via `bunderstackStart<App>()` in `src/api.ts`.
- **Auth Flow**: Complete Better Auth sign-in (`/login`) and registration (`/register`) with session management.
- **Relay Delivery Rail**: Visual and interactive status tracking for client project deliverables.
- **Dashboard & Workspaces**: Responsive project overview, task completion, and proof attachment uploads.
- **Admin Overview**: Server-authorized metrics overview at `/app/admin`.
- **shadcn/ui Ready**: Fully configured with `components.json`, Tailwind v4, Radix primitives, Lucide icons, and `cn()` helper (`bunx shadcn@latest add <component>`).

