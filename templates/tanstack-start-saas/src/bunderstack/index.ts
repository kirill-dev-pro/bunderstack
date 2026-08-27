import { provision } from 'bunderstack/provision'

import { backend } from './backend'

export { backend }

/** The production singleton. Tests import backend.ts and own lexical fixtures. */
export const app = await backend.start()
export const { db, auth, env } = app
export type App = typeof app

// Development pushes the schema until `migrations/` is committed, after which
// this applies the committed migrations instead.
await provision(app)
