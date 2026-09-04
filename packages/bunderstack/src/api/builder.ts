import {
  os,
  type AnyMiddleware,
  type AnyRouter,
  type Context,
  type Middleware,
} from '@orpc/server'

import type { EnvConfigInput, ValidatedEnv } from '../env'
import type { MessagingConfig } from '../messaging'
import type { ApiContext } from './context'

import {
  BUNDERSTACK_ERRORS,
  BunderstackError,
  mapBunderstackErrors,
} from '../errors'
export type { ProtectedContextAdditions } from './types'

export function createApiBuilder<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnv = Record<string, unknown>,
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
>() {
  const base = os
    .$context<ApiContext<TSchema, TEnv, TMessaging>>()
    .errors(BUNDERSTACK_ERRORS)
    .use(mapBunderstackErrors)

  const protectedProc = base.use(async ({ context, next }) => {
    const session = await context.getSession()
    if (!session.user) {
      throw new BunderstackError('UNAUTHORIZED', 'Authentication required')
    }
    return next({
      context: {
        user: session.user,
        session: {
          activeOrganizationId: session.activeOrganizationId,
        },
      },
    })
  })

  return {
    public: base,
    protected: protectedProc,
    webhook: base,
    /**
     * Declares a standalone middleware over the base context. Use it for
     * `bunderstack({ middleware })`, which reaches every procedure in
     * the graph, and for `.use(...)` on any base declared here.
     *
     * The annotation is explicit because the inferred `DecoratedMiddleware`
     * is internal to `@orpc/server` and cannot be named in the emitted types.
     */
    middleware: base.middleware.bind(base) as <TOutContext extends Context>(
      middleware: Middleware<
        ApiContext<TSchema, TEnv, TMessaging>,
        TOutContext,
        unknown,
        unknown,
        typeof BUNDERSTACK_ERRORS
      >,
    ) => AnyMiddleware,
  }
}

/**
 * Same builder as `createApiBuilder`, but the generics come from the values an
 * application already has. It reads nothing at runtime, so a module can call it
 * at import time and export the bases that its router modules import.
 */
export function defineApi<
  TSchema extends Record<string, unknown>,
  TEnv extends EnvConfigInput | undefined = undefined,
  TMessaging extends MessagingConfig = MessagingConfig,
>(_options: { schema: TSchema; env?: TEnv; messaging?: TMessaging }) {
  return createApiBuilder<TSchema, ValidatedEnv<TEnv>, TMessaging>()
}

export type BunderstackApiBuilder<
  TSchema extends Record<string, unknown>,
  TEnv = Record<string, unknown>,
  TMessaging extends MessagingConfig | undefined = MessagingConfig,
> = ReturnType<typeof createApiBuilder<TSchema, TEnv, TMessaging>>

export type ApiFactory<
  TSchema extends Record<string, unknown>,
  TEnv,
  TCustomApiRouter extends AnyRouter,
> = (builder: BunderstackApiBuilder<TSchema, TEnv>) => TCustomApiRouter
