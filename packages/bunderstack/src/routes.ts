// src/routes.ts — mounting user-supplied Hono routes inside the app.

/** A route as Hono reports it on `app.routes`. */
export type DeclaredRoute = { method: string; path: string }

const RESERVED_EXACT = [
  '/health',
  '/api/health',
  '/api/openapi.json',
  '/api/realtime',
  '/api/rpc',
  '/api/auth',
  '/api/trpc',
  '/api/files',
  '/files',
] as const

const RESERVED_PREFIXES = [
  '/api/rpc/',
  '/api/auth/',
  '/api/trpc/',
  '/api/files/',
  '/files/',
  '/api/realtime/',
] as const

/** The first path segment under `/api/`, or undefined when not under it. */
function apiSegment(path: string): string | undefined {
  if (!path.startsWith('/api/')) return undefined
  return path.slice('/api/'.length).split('/')[0]
}

export function collisionForBunderstackPath(
  path: string,
  tableNames: readonly string[],
): string | undefined {
  if (RESERVED_EXACT.includes(path as (typeof RESERVED_EXACT)[number])) {
    return `it is reserved by bunderstack`
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (path.startsWith(prefix)) {
      return `"${prefix}*" is reserved by bunderstack`
    }
  }
  const segment = apiSegment(path)
  if (segment === undefined) return undefined
  if (segment === '*' || segment.startsWith(':')) {
    return `a parameter or wildcard here would shadow every generated CRUD route`
  }
  if (tableNames.includes(segment)) {
    return `it collides with the generated CRUD route for table "${segment}"`
  }
  return undefined
}

function collisionFor(
  route: DeclaredRoute,
  tableNames: readonly string[],
): string | undefined {
  return collisionForBunderstackPath(route.path, tableNames)
}

/**
 * Throws when any declared route would collide with a bunderstack route.
 *
 * Custom routes are registered before the built-ins, so a collision silently
 * shadows core behaviour — including authentication. Failing at construction is
 * the cheapest place to find out.
 */
export function validateCustomRoutes(
  routes: readonly DeclaredRoute[],
  tableNames: readonly string[],
): void {
  const problems: string[] = []
  for (const route of routes) {
    const reason = collisionFor(route, tableNames)
    if (reason) {
      problems.push(`  ${route.method} ${route.path} — ${reason}`)
    }
  }
  if (problems.length === 0) return
  throw new Error(
    `[bunderstack] routes: ${problems.length} route(s) collide with bunderstack's own:\n${problems.join('\n')}\nChoose different paths.`,
  )
}

import type { Hono } from 'hono'

import type { AccessUser, AuthSessionResolver } from './access'
import type { DbFor } from './db'
import type { EmailFacade } from './email'
import type { JobsRuntimeFacade } from './jobs/define'
import type { RealtimeFacade } from './realtime/facade'
import type { AuthInstance, StorageFacade } from './index'

import { resolveAccessUser, resolveSession } from './access'

export type RouteContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  env: TEnvResult
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  /** Resolve the caller's session. Costs an auth round-trip; call only when needed. */
  getSession(
    request: Request,
  ): Promise<{ user: AccessUser | null; activeOrganizationId: string | null }>
  /** Convenience wrapper over getSession when the organization is irrelevant. */
  getUser(request: Request): Promise<AccessUser | null>
}

/** Alias mirroring the JobContext / BunderstackJobContext pair. */
export type BunderstackRouteContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = RouteContext<TSchema, TEnvResult>

export type RoutesBuilder<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = (ctx: RouteContext<TSchema, TEnvResult>) => Hono

export function createRouteContext<
  TSchema extends Record<string, unknown>,
  TEnvResult,
>(deps: {
  db: DbFor<TSchema>
  env: TEnvResult
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  authResolver: AuthSessionResolver | undefined
}): RouteContext<TSchema, TEnvResult> {
  return {
    db: deps.db,
    env: deps.env,
    storage: deps.storage,
    email: deps.email,
    jobs: deps.jobs,
    realtime: deps.realtime,
    auth: deps.auth,
    // Lazy on purpose: a webhook has no session, and resolving one eagerly
    // would spend an auth round-trip per request on a value nobody reads.
    getSession: (request) => resolveSession(deps.authResolver, request.headers),
    getUser: (request) => resolveAccessUser(deps.authResolver, request.headers),
  }
}
