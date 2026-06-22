import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: 'file:./data.db' },
})
