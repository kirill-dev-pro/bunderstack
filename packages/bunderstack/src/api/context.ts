import type { AccessUser, AuthSessionResolver } from '../access'
import type { DbFor } from '../db'
import type { EmailFacade } from '../email'
import type { JobsRuntimeFacade } from '../jobs/define'
import type { BunderstackLogger } from '../logging'
import type { RealtimeFacade } from '../realtime/facade'
import type { AuthInstance, StorageFacade } from '../runtime'

import { resolveSession } from '../access'
import { consoleLogger } from '../logging'

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
  logger?: BunderstackLogger
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
  logger: BunderstackLogger
  request: Request
  resHeaders: Headers
  getRawBody: () => Promise<string>
  getSession: () => Promise<{
    user: AccessUser | null
    activeOrganizationId: string | null
  }>
  /**
   * The session that some earlier code already resolved, or `undefined`.
   * Never starts a resolution, so a global middleware can log the caller
   * without removing the lazy session behavior that signed webhooks rely on.
   * Use it for observability only. Never use it for authorization.
   */
  peekSession: () =>
    | { user: AccessUser | null; activeOrganizationId: string | null }
    | undefined
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

  let settledSession:
    | { user: AccessUser | null; activeOrganizationId: string | null }
    | undefined

  const getSession = () => {
    if (!sessionPromise) {
      sessionPromise = resolveSession(deps.authResolver, request.headers).then(
        (session) => {
          settledSession = session
          return session
        },
      )
    }
    return sessionPromise
  }

  const peekSession = () => settledSession

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
    logger: deps.logger ?? consoleLogger,
    request,
    resHeaders: new Headers(),
    getRawBody,
    getSession,
    peekSession,
  }
}
