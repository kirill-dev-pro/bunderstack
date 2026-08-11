import type { AccessUser, AuthSessionResolver } from '../access'
import type { DbFor } from '../db'
import type { EmailFacade } from '../email'
import type { AuthInstance, StorageFacade } from '../index'
import type { JobsRuntimeFacade } from '../jobs/define'
import type { RealtimeFacade } from '../realtime/facade'

import { resolveSession } from '../access'

export interface ApiContextDeps<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnv = Record<string, unknown>,
> {
  db: DbFor<TSchema>
  env: TEnv
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  authResolver?: AuthSessionResolver
}

export interface ApiContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnv = Record<string, unknown>,
> {
  db: DbFor<TSchema>
  env: TEnv
  storage: StorageFacade
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  auth: AuthInstance
  request: Request
  resHeaders: Headers
  getRawBody: () => Promise<string>
  getSession: () => Promise<{
    user: AccessUser | null
    activeOrganizationId: string | null
  }>
}

export function createApiContext<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnv = Record<string, unknown>,
>(
  deps: ApiContextDeps<TSchema, TEnv>,
  request: Request,
): ApiContext<TSchema, TEnv> {
  // Reserve the body stream before a transport codec consumes `request`.
  const rawBodyRequest = request.clone()
  let rawBodyPromise: Promise<string> | undefined
  let sessionPromise:
    | Promise<{ user: AccessUser | null; activeOrganizationId: string | null }>
    | undefined

  const getSession = () => {
    if (!sessionPromise) {
      sessionPromise = resolveSession(deps.authResolver, request.headers)
    }
    return sessionPromise
  }

  const getRawBody = () => {
    if (!rawBodyPromise) rawBodyPromise = rawBodyRequest.text()
    return rawBodyPromise
  }

  return {
    db: deps.db,
    env: deps.env,
    storage: deps.storage,
    email: deps.email,
    jobs: deps.jobs,
    realtime: deps.realtime,
    auth: deps.auth,
    request,
    resHeaders: new Headers(),
    getRawBody,
    getSession,
  }
}
