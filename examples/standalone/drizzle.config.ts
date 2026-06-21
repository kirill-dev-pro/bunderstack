import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './examples/standalone/schema.ts',
  out: './examples/standalone/migrations',
  dialect: 'sqlite',
  dbCredentials: { url: './examples/standalone/data.db' },
})
