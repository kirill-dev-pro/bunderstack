/**
 * Apply committed Drizzle migrations.
 * Run: bun run migrate
 */
import { migrate } from 'drizzle-orm/libsql/migrator'

import { app } from '~/bunderstack'

console.log('Applying migrations…')

await migrate(app.db, { migrationsFolder: './migrations' })

console.log('Done.')
