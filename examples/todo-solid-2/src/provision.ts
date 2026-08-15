/**
 * Creates or migrates the database, then exits.
 *
 * `bun run dev` and `bun run start` run this before serving, so the schema is
 * ready before the first request instead of being pushed on it.
 *
 * It lives here rather than at the bottom of src/bunderstack.ts because that
 * module is imported by the Vite dev server to answer `/api` requests, and
 * drizzle-kit — which the dev-time schema push needs — does not resolve inside
 * Vite's module runner. Provisioning is a startup step, not an import side
 * effect.
 *
 * With no migrations/ folder this pushes the schema; once migrations are
 * generated and committed, the same call applies them instead.
 */
import { provision } from 'bunderstack/provision'

import { app, todos } from './bunderstack'

await provision(app)

// A fresh database has nothing to summarise, and the summarise button is
// disabled on an empty list. `seedTodos` used to fill this gap; a startup
// insert is cheaper than keeping a job for it.
const existing = await app.db.select({ id: todos.id }).from(todos).limit(1)
if (existing.length === 0) {
  await app.db
    .insert(todos)
    .values([
      { title: 'Read the Solid 2 release notes' },
      { title: 'Try the summarise button' },
      { title: 'Open a second tab and watch it stream' },
    ])
}

await app.close()
