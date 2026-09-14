import { provision } from 'bunderstack/provision'

import { backend } from './backend'

export { backend }

/** The production singleton. Tests import backend.ts and own lexical fixtures. */
export const app = await backend.start()
export const { db, auth, env } = app
export type App = typeof app

// Apply the template's committed migrations without importing Drizzle Kit.
await provision(app)
