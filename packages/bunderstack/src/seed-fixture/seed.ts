import { defineSeed } from '../seed'
import { backend } from './backend'

export default defineSeed(backend, async ({ db, schema, env }) => {
  const [ada] = await db
    .insert(schema.users)
    .values({ name: 'Ada', email: env.SEED_ADMIN_EMAIL ?? 'ada@example.com' })
    .returning()
  await db.insert(schema.orders).values({ userId: ada!.id, total: 4200 })
  if (ada!.name === 'never') {
    // @ts-expect-error a column the table does not have
    await db.insert(schema.orders).values({ userId: ada!.id, sum: 1 })
    // @ts-expect-error a table the schema does not have
    void schema.invoices
  }
})
