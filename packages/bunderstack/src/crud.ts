import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import { eq, getTableColumns, getTableName, isTable } from 'drizzle-orm'
import { Hono } from 'hono'

import type { RealtimeBroker } from './realtime/index'

import {
  checkAccess,
  resolveSession,
  rowMatchesScope,
  stampScope,
  sanitizeWriteBody,
  type AccessUser,
  type AuthSessionResolver,
  type CrudOperation,
  type ResolvedAccess,
  type ResolvedTableAccess,
  type ScopeMap,
} from './access'
import { ErrorCode, apiError, ListQueryError } from './errors'
import {
  lookupIdempotency,
  resolveIdempotencyConfig,
  storeIdempotency,
  type IdempotencyConfig,
} from './idempotency'
import { executeList, parseListParams } from './list-query'
import { buildScopeWhere } from './scope'

export type CrudRouterOptions = {
  auth?: AuthSessionResolver
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  broker?: RealtimeBroker
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

export function buildCrudRouter<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  db: LibSQLDatabase<TSchema>,
  options: CrudRouterOptions,
): Hono {
  const router = new Hono()
  const { auth, access, broker } = options
  const idempotency = resolveIdempotencyConfig(options.idempotency)

  const scopeFor = (
    tableAccess: ResolvedTableAccess,
    ctx: {
      user: AccessUser | null
      session: { activeOrganizationId: string | null } | null
      request: Request
    },
  ): ScopeMap | undefined =>
    tableAccess.scope ? tableAccess.scope({ ...ctx }) : undefined

  for (const table of Object.values(schema)) {
    if (!isTable(table)) continue

    const name = getTableName(table)
    const tableAccess = tableEntryForName(access, name)
    if (!tableAccess?.enabled) continue

    const idCol = getTableColumns(table)['id']
    if (!idCol) continue

    router.get(`/${name}`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const session = { activeOrganizationId }
      const denied = await enforce('list', tableAccess, {
        user,
        session,
        request: c.req.raw,
      })
      if (!denied.allowed) {
        return apiError(
          c,
          ErrorCode.FORBIDDEN,
          'Forbidden',
          denied.status === 401 ? 401 : 403,
        )
      }

      try {
        const params = parseListParams(new URL(c.req.url), tableAccess)
        const scope = scopeFor(tableAccess, {
          user,
          session,
          request: c.req.raw,
        })
        const scopeWhere = scope ? buildScopeWhere(table, scope) : undefined
        const result = await executeList(
          db,
          table,
          tableAccess,
          params,
          idCol,
          scopeWhere,
        )
        return c.json(result)
      } catch (err) {
        if (err instanceof ListQueryError) {
          return apiError(c, err.code, err.message, 400, err.details)
        }
        throw err
      }
    })

    router.get(`/${name}/:id`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const session = { activeOrganizationId }
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!rows[0]) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      const denied = await enforce('get', tableAccess, {
        user,
        session,
        request: c.req.raw,
        row: rows[0] as Record<string, unknown>,
      })
      if (!denied.allowed) {
        return apiError(
          c,
          ErrorCode.FORBIDDEN,
          'Forbidden',
          denied.status === 401 ? 401 : 403,
        )
      }

      const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
      if (
        scope &&
        !rowMatchesScope(rows[0] as Record<string, unknown>, scope)
      ) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      return c.json(rows[0])
    })

    router.post(`/${name}`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const session = { activeOrganizationId }
      const denied = await enforce('create', tableAccess, {
        user,
        session,
        request: c.req.raw,
      })
      if (!denied.allowed) {
        return apiError(
          c,
          ErrorCode.FORBIDDEN,
          'Forbidden',
          denied.status === 401 ? 401 : 403,
        )
      }

      const rawBody = await c.req.text()
      let body: unknown
      try {
        body = rawBody ? JSON.parse(rawBody) : null
      } catch {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Invalid JSON', 400)
      }
      if (!isRecord(body)) {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Invalid JSON body', 400)
      }

      const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
      if (idempotency && idempotencyKey) {
        const lookup = await lookupIdempotency(
          db,
          name,
          idempotencyKey,
          rawBody,
          idempotency,
        )
        if (lookup.type === 'conflict') {
          return apiError(
            c,
            ErrorCode.IDEMPOTENCY_CONFLICT,
            'Idempotency key reused with different body',
            409,
          )
        }
        if (lookup.type === 'replay') {
          return new Response(lookup.response, {
            status: lookup.status,
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Replayed': 'true',
            },
          })
        }
      }

      const values = sanitizeWriteBody(
        body,
        tableAccess,
        'create',
        user?.id ?? null,
      )

      const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
      const stamped = scope ? stampScope(values, scope) : values
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).insert(table).values(stamped).returning()
      const created = rows[0]
      void broker?.publish(name, 'create', created as Record<string, unknown>)

      if (idempotency && idempotencyKey) {
        await storeIdempotency(
          db,
          name,
          idempotencyKey,
          rawBody,
          201,
          created,
          idempotency,
        )
      }

      return c.json(created, 201)
    })

    router.patch(`/${name}/:id`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const session = { activeOrganizationId }
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
      if (
        scope &&
        !rowMatchesScope(existing[0] as Record<string, unknown>, scope)
      ) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      const denied = await enforce('update', tableAccess, {
        user,
        session,
        request: c.req.raw,
        row: existing[0] as Record<string, unknown>,
      })
      if (!denied.allowed) {
        return apiError(
          c,
          ErrorCode.FORBIDDEN,
          'Forbidden',
          denied.status === 401 ? 401 : 403,
        )
      }

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Invalid JSON', 400)
      }
      if (!isRecord(body)) {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Invalid JSON body', 400)
      }

      const values = sanitizeWriteBody(
        body,
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
      if (!rows[0]) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }
      void broker?.publish(name, 'update', rows[0] as Record<string, unknown>)
      return c.json(rows[0])
    })

    router.delete(`/${name}/:id`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const session = { activeOrganizationId }
      const rawId = c.req.param('id')
      const id = isNaN(Number(rawId)) ? rawId : Number(rawId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any)
        .select()
        .from(table)
        .where(eq(idCol as any, id))
      if (!existing[0]) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      const scope = scopeFor(tableAccess, { user, session, request: c.req.raw })
      if (
        scope &&
        !rowMatchesScope(existing[0] as Record<string, unknown>, scope)
      ) {
        return apiError(c, ErrorCode.NOT_FOUND, 'Not found', 404)
      }

      const denied = await enforce('delete', tableAccess, {
        user,
        session,
        request: c.req.raw,
        row: existing[0] as Record<string, unknown>,
      })
      if (!denied.allowed) {
        return apiError(
          c,
          ErrorCode.FORBIDDEN,
          'Forbidden',
          denied.status === 401 ? 401 : 403,
        )
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).delete(table).where(eq(idCol as any, id))
      void broker?.publish(
        name,
        'delete',
        existing[0] as Record<string, unknown>,
      )
      return new Response(null, { status: 204 })
    })
  }

  return router
}
