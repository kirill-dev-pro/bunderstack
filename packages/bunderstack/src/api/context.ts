import type { AccessUser, AuthSessionResolver } from '../access'
import { resolveSession } from '../access'
import type { DbFor } from '../db'
import type { EmailFacade } from '../email'
import type { AuthInstance, StorageFacade } from '../index'
import type { JobsRuntimeFacade } from '../jobs/define'
import type { RealtimeFacade } from '../realtime/facade'

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
  let sessionPromise:
    | Promise<{ user: AccessUser | null; activeOrganizationId: string | null }>
    | undefined

  const getSession = () => {
    if (!sessionPromise) {
      sessionPromise = resolveSession(deps.authResolver, request.headers)
    }
    return sessionPromise
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
    getSession,
  }
}
