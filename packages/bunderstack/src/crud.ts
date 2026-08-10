import { getTableColumns, getTableName, isTable } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import type { AnyDb } from './dialect'
import type { RealtimeFacade } from './realtime/facade'

import {
  resolveSession,
  tableEntryForName,
  type AuthSessionResolver,
  type ResolvedAccess,
} from './access'
import { createCrudOperations, CrudOperationError } from './crud-operations'
import { ErrorCode, apiError } from './errors'
import type { IdempotencyConfig } from './idempotency'

export type CrudRouterOptions<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = {
  auth?: AuthSessionResolver
  access: ResolvedAccess
  idempotency?: boolean | IdempotencyConfig
  realtime?: RealtimeFacade<TSchema>
}

export function buildCrudRouter<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  db: AnyDb,
  options: CrudRouterOptions<TSchema>,
): Hono {
  const router = new Hono()
  const { auth, access, realtime, idempotency } = options

  const operations = createCrudOperations({
    schema,
    db,
    access,
    idempotency,
    realtime,
  })

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
      const ctx = {
        request: c.req.raw,
        user,
        session: { activeOrganizationId },
      }
      try {
        const result = await operations.list(name, new URL(c.req.url), ctx)
        return c.json(result)
      } catch (err) {
        if (err instanceof CrudOperationError) {
          return apiError(
            c,
            err.code,
            err.message,
            err.status as ContentfulStatusCode,
            err.details,
          )
        }
        throw err
      }
    })

    router.get(`/${name}/:id`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const ctx = {
        request: c.req.raw,
        user,
        session: { activeOrganizationId },
      }
      try {
        const row = await operations.get(name, c.req.param('id'), ctx)
        return c.json(row)
      } catch (err) {
        if (err instanceof CrudOperationError) {
          return apiError(
            c,
            err.code,
            err.message,
            err.status as ContentfulStatusCode,
            err.details,
          )
        }
        throw err
      }
    })

    router.post(`/${name}`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const ctx = {
        request: c.req.raw,
        user,
        session: { activeOrganizationId },
      }

      const rawBody = await c.req.text()
      let body: unknown
      try {
        body = rawBody ? JSON.parse(rawBody) : null
      } catch {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Invalid JSON', 400)
      }

      const idempotencyKey = c.req.header('Idempotency-Key')?.trim()

      try {
        const result = await operations.create(
          name,
          body,
          rawBody,
          idempotencyKey,
          ctx,
        )
        if (result.type === 'replay') {
          return new Response(result.body, {
            status: result.status,
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Replayed': 'true',
            },
          })
        }
        return c.json(result.record, 201)
      } catch (err) {
        if (err instanceof CrudOperationError) {
          return apiError(
            c,
            err.code,
            err.message,
            err.status as ContentfulStatusCode,
            err.details,
          )
        }
        throw err
      }
    })

    router.patch(`/${name}/:id`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const ctx = {
        request: c.req.raw,
        user,
        session: { activeOrganizationId },
      }

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return apiError(c, ErrorCode.VALIDATION_ERROR, 'Invalid JSON', 400)
      }

      try {
        const updated = await operations.update(
          name,
          c.req.param('id'),
          body,
          ctx,
        )
        return c.json(updated)
      } catch (err) {
        if (err instanceof CrudOperationError) {
          return apiError(
            c,
            err.code,
            err.message,
            err.status as ContentfulStatusCode,
            err.details,
          )
        }
        throw err
      }
    })

    router.delete(`/${name}/:id`, async (c) => {
      const { user, activeOrganizationId } = await resolveSession(
        auth,
        c.req.raw.headers,
      )
      const ctx = {
        request: c.req.raw,
        user,
        session: { activeOrganizationId },
      }

      try {
        await operations.delete(name, c.req.param('id'), ctx)
        return new Response(null, { status: 204 })
      } catch (err) {
        if (err instanceof CrudOperationError) {
          return apiError(
            c,
            err.code,
            err.message,
            err.status as ContentfulStatusCode,
            err.details,
          )
        }
        throw err
      }
    })
  }

  return router
}
