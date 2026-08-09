import { os, ORPCError, type AnyRouter } from '@orpc/server'
import type { AccessUser } from '../access'
import type { ApiContext } from './context'

export interface ProtectedContextAdditions {
  user: AccessUser
  session: {
    activeOrganizationId: string | null
  }
}

export function createApiBuilder<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
  TEnv = Record<string, unknown>,
>() {
  const base = os.$context<ApiContext<TSchema, TEnv>>()

  const protectedProc = base.use(async ({ context, next }) => {
    const session = await context.getSession()
    if (!session.user) {
      throw new ORPCError('UNAUTHORIZED', {
        message: 'Authentication required',
      })
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
  }
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

