import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import {
  eq,
  isTable,
  getTableName,
  getTableColumns,
  like,
  or,
  type SQL,
} from 'drizzle-orm'
import { Hono } from 'hono'

import {
  checkAccess,
  resolveAccessUser,
  sanitizeWriteBody,
  type AuthSessionResolver,
  type CrudOperation,
  type ResolvedAccess,
  type ResolvedTableAccess,
} from './access.ts'

export type CrudRouterOptions = {
  auth?: AuthSessionResolver
  access: ResolvedAccess
}

function tableEntryForName(
  access: ResolvedAccess,
  tableName: string,
): ResolvedTableAccess | undefined {
  for (const entry of access.values()) {
    if (entry.tableName === tableName) return entry
  }
  return undefined
}

async function enforce(
  operation: CrudOperation,
  access: ResolvedTableAccess,
  ctx: Parameters<typeof checkAccess>[1],
) {
  const rule = access[operation]
  const result = await checkAccess(rule, ctx, access.ownerColumn)
  return result
}

function buildSearchWhere(
  table: Parameters<typeof getTableColumns>[0],
  searchableColumns: string[] | undefined,
  q: string,
): SQL | undefined {
  if (!q || !searchableColumns?.length) return undefined
  const columns = getTableColumns(table)
  const pattern = `%${q.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`
  const conditions = searchableColumns
    .filter((name) => name in columns)
    .map((name) => like(columns[name]!, pattern))
  return conditions.length ? or(...conditions) : undefined
}

export function buildCrudRouter<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  db: LibSQLDatabase<TSchema>,
  options: CrudRouterOptions,
): Hono {
  const router = new Hono()
  const { auth, access } = options

  for (const table of Object.values(schema)) {
    if (!isTable(table)) continue

    const name = getTableName(table as Parameters<typeof getTableName>[0])
    const tableAccess = tableEntryForName(access, name)
    if (!tableAccess?.enabled) continue

    const idCol = (table as unknown as Record<string, unknown>)['id']
    if (!idCol) continue

    router.get(`/${name}`, async (c) => {
      const user = await resolveAccessUser(auth, c.req.raw.headers)
      const denied = await enforce('list', tableAccess, {
        user,
        request: c.req.raw,
      })
      if (!denied.allowed) return c.json({ error: 'Forbidden' }, denied.status)

      const limit = Math.min(Number(c.req.query('limit')) || 20, 100)
      const offset = Number(c.req.query('offset')) || 0
      const q = c.req.query('q')?.trim().slice(0, 100) ?? ''
      const where = buildSearchWhere(table, tableAccess.searchableColumns, q)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (db as any).select().from(table)
      if (where) query = query.where(where)
      const items = await query.limit(limit).offset(offset)
      return c.json({ items, limit, offset, ...(q ? { q } : {}) })
    })

    router.get(`/${name}/:id`, async (c) => {
      const user = await resolveAccessUser(auth, c.req.raw.headers)
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!rows[0]) return c.json({ error: 'Not found' }, 404)

      const denied = await enforce('get', tableAccess, {
        user,
        request: c.req.raw,
        row: rows[0] as Record<string, unknown>,
      })
      if (!denied.allowed) return c.json({ error: 'Forbidden' }, denied.status)

      return c.json(rows[0])
    })

    router.post(`/${name}`, async (c) => {
      const user = await resolveAccessUser(auth, c.req.raw.headers)
      const denied = await enforce('create', tableAccess, {
        user,
        request: c.req.raw,
      })
      if (!denied.allowed) return c.json({ error: 'Forbidden' }, denied.status)

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const values = sanitizeWriteBody(
        body as Record<string, unknown>,
        tableAccess,
        'create',
        user?.id ?? null,
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).insert(table).values(values).returning()
      return c.json(rows[0], 201)
    })

    router.patch(`/${name}/:id`, async (c) => {
      const user = await resolveAccessUser(auth, c.req.raw.headers)
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) return c.json({ error: 'Not found' }, 404)

      const denied = await enforce('update', tableAccess, {
        user,
        request: c.req.raw,
        row: existing[0] as Record<string, unknown>,
      })
      if (!denied.allowed) return c.json({ error: 'Forbidden' }, denied.status)

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const values = sanitizeWriteBody(
        body as Record<string, unknown>,
        tableAccess,
        'update',
        user?.id ?? null,
      )

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any)
        .update(table)
        .set(values)
        .where(eq(idCol as any, id))
        .returning()
      if (!rows[0]) return c.json({ error: 'Not found' }, 404)
      return c.json(rows[0])
    })

    router.delete(`/${name}/:id`, async (c) => {
      const user = await resolveAccessUser(auth, c.req.raw.headers)
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) return c.json({ error: 'Not found' }, 404)

      const denied = await enforce('delete', tableAccess, {
        user,
        request: c.req.raw,
        row: existing[0] as Record<string, unknown>,
      })
      if (!denied.allowed) return c.json({ error: 'Forbidden' }, denied.status)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).delete(table).where(eq(idCol as any, id))
      return new Response(null, { status: 204 })
    })
  }

  return router
}
