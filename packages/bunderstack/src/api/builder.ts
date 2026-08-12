import { os, type AnyRouter } from '@orpc/server'

import type { EnvConfigInput, ValidatedEnv } from '../env'
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
>() {
  const base = os
    .$context<ApiContext<TSchema, TEnv>>()
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
>(_options: { schema: TSchema; env?: TEnv }) {
  return createApiBuilder<TSchema, ValidatedEnv<TEnv>>()
}

export type BunderstackApiBuilder<
  TSchema extends Record<string, unknown>,
  TEnv = Record<string, unknown>,
> = ReturnType<typeof createApiBuilder<TSchema, TEnv>>

export type ApiFactory<
  TSchema extends Record<string, unknown>,
  TEnv,
  TCustomApiRouter extends AnyRouter,
> = (builder: BunderstackApiBuilder<TSchema, TEnv>) => TCustomApiRouter
