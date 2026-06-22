import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: '../standalone/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: 'file:./data.db' },
})
