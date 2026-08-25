/**
 * Creates or migrates the database, then exits. Run before serving — see
 * examples/todo-solid-2/src/provision.ts for why provisioning is a startup
 * step and not an import side effect.
 */
import { provision } from 'bunderstack/provision'

import { app, todos } from './bunderstack'

await provision(app)

const existing = await app.db.select({ id: todos.id }).from(todos).limit(1)
if (existing.length === 0) {
  await app.db.insert(todos).values([
    { title: 'Open a second window next to this one' },
    { title: 'Toggle me from the other tab' },
    { title: 'Every update arrives as an async iterator event' },
  ])
}

await app.close()
