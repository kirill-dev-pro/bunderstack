// src/crud.ts
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { isTable, getTableName } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

export function buildCrudRouter<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  db: LibSQLDatabase<TSchema>,
): Hono {
  const router = new Hono()

  for (const table of Object.values(schema)) {
    if (!isTable(table)) continue

    const name = getTableName(table as Parameters<typeof getTableName>[0])
    const idCol = (table as Record<string, unknown>)['id']
    if (!idCol) continue

    router.get(`/${name}`, async (c) => {
      const limit = Math.min(Number(c.req.query('limit') ?? 20), 100)
      const offset = Number(c.req.query('offset') ?? 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = await (db as any).select().from(table).limit(limit).offset(offset)
      return c.json({ items, limit, offset })
    })

    router.get(`/${name}/:id`, async (c) => {
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).select().from(table).where(eq(idCol as any, id))
      if (!rows[0]) return c.json({ error: 'Not found' }, 404)
      return c.json(rows[0])
    })

    router.post(`/${name}`, async (c) => {
      const body = await c.req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).insert(table).values(body).returning()
      return c.json(rows[0], 201)
    })

    router.patch(`/${name}/:id`, async (c) => {
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      const body = await c.req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).update(table).set(body).where(eq(idCol as any, id)).returning()
      if (!rows[0]) return c.json({ error: 'Not found' }, 404)
      return c.json(rows[0])
    })

    router.delete(`/${name}/:id`, async (c) => {
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).delete(table).where(eq(idCol as any, id))
      return new Response(null, { status: 204 })
    })
  }

  return router
}
