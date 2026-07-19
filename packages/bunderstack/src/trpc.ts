// src/trpc.ts — pre-wired tRPC instance for bunderstack endpoints.
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'

import type { AccessUser } from './access'
import type { DbFor } from './db'
import type { EmailFacade } from './email'
import type { JobsRuntimeFacade } from './jobs/index'
import type { RealtimeFacade } from './realtime/facade'

export type TRPCContext<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = {
  db: DbFor<TSchema>
  user: AccessUser | null
  env: TEnvResult
  email: EmailFacade
  jobs: JobsRuntimeFacade
  realtime: RealtimeFacade<TSchema>
  req: Request
}

/**
 * Build the `t` instance bunderstack hands to the config's `trpc` builder
 * callback (and exports for multi-file router setups). superjson is the
 * transformer, so Dates/Maps/Sets/BigInt/undefined round-trip.
 */
export function createTRPC<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
>() {
  const t = initTRPC.context<TRPCContext<TSchema, TEnvResult>>().create({
    transformer: superjson,
  })

  const protectedProcedure = t.procedure.use(({ ctx, next }) => {
    if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' })
    return next({ ctx: { ...ctx, user: ctx.user } })
  })

  return {
    router: t.router,
    middleware: t.middleware,
    mergeRouters: t.mergeRouters,
    procedure: t.procedure,
    protectedProcedure,
  }
}

/** Type of the `t` instance — for builder callbacks declared in separate files. */
export type BunderstackTRPC<
  TSchema extends Record<string, unknown>,
  TEnvResult = Record<string, unknown>,
> = ReturnType<typeof createTRPC<TSchema, TEnvResult>>
