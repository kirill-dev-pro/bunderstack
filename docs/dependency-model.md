# Dependency Model

Bunderstack operates on a **static dependency model**, which is different from most other "batteries-included" frameworks.

We provide the glue to connect Drizzle ORM, tRPC, BetterAuth, Hono, and other core libraries together without wrapping them in an opaque abstraction layer.

## The Problem with Dynamic Imports

Previously, Bunderstack used dynamic imports (`import()`) and bundler escape hatches (e.g. `@vite-ignore`) to lazily load heavy optional features (like database drivers or authentication systems) only when they were needed.

This approach was convenient for development, but caused significant issues in advanced production build pipelines like Next.js, Vite, and Rolldown, resulting in failed builds, missing dependencies, or unoptimized server bundles.

## The Static Solution

Bunderstack now relies on **Explicit Peer Dependencies**.

Instead of bundling Drizzle ORM or BetterAuth, Bunderstack requires you to install them alongside the framework in your application's `package.json`.

By shifting from an "implicit dependencies" model to an "explicit peer dependencies" model, Bunderstack ensures that:

1. **Zero Bundler Warnings**: Your bundler (Vite, Next.js, Webpack) statically analyzes all dependencies correctly without needing escape hatches or workarounds.
2. **Direct Access**: You have direct, type-safe access to the underlying libraries.
3. **Type Consistency**: Because you provide the dependency, TypeScript infers a single unified version of types like `sqliteTable` or `betterAuth`, eliminating nasty nominal typing mismatches in monorepos.

## How to use Bunderstack

When you start a new Bunderstack project, you install all the required pieces:

```sh
bun add bunderstack drizzle-orm better-auth hono @trpc/server zod @libsql/client
```

When defining your database schema, you import directly from the ORM instead of the framework:

```ts
// schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  // ...
})
```

Because Bunderstack operates on static bindings, the entire stack compiles flawlessly into a standard HTTP Request-Response handler that can be deployed to any edge runtime.
