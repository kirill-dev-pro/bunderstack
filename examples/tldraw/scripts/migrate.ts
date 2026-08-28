/**
 * Apply committed Drizzle migrations.
 * Run: bun run migrate
 */
import { migrate } from 'drizzle-orm/libsql/migrator'

import { app } from '~/bunderstack'

console.log('Applying migrations…')

await migrate(app.db, { migrationsFolder: './migrations' })

console.log('Done.')

// `backend.start()` holds open a database connection and a worker, so the
// script has to close the app; otherwise `migrate && dev` never reaches dev.
await app.close()
