import type { BunderstackTRPC } from 'bunderstack/trpc'
import { TRPCError } from '@trpc/server'
import { and, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import type { RelayEnv } from './env'
import * as schema from './schema'

/**
 * Procedures for work that generated CRUD cannot express: writes that stamp
 * server-owned columns, and reads whose authorization depends on a role.
 */
export function createAppRouter(t: BunderstackTRPC<typeof schema, RelayEnv>) {
  const adminProcedure = t.protectedProcedure.use(({ ctx, next }) => {
    if (ctx.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN' })
    return next({ ctx })
  })

  return t.router({
    projects: t.router({
      create: t.protectedProcedure
        .input(
          z.object({
            name: z.string().min(1).max(120),
            clientName: z.string().max(120).default(''),
            dueAt: z.date().optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const [project] = await ctx.db
            .insert(schema.projects)
            .values({
              // Owner is stamped from the session, never from the input.
              ownerId: ctx.user.id,
              name: input.name,
              clientName: input.clientName,
              dueAt: input.dueAt ?? null,
            })
            .returning()

          if (!project) {
            throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' })
          }

          await ctx.realtime.publish(schema.projects, 'create', project)
          return project
        }),
    }),

    tasks: t.router({
      add: t.protectedProcedure
        .input(
          z.object({
            projectId: z.string().min(1),
            title: z.string().min(1).max(200),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          // Authorization depends on a related row, so it is checked here
          // rather than through a generated CRUD rule.
          const [project] = await ctx.db
            .select()
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.id, input.projectId),
                eq(schema.projects.ownerId, ctx.user.id),
              ),
            )
            .limit(1)
          if (!project) throw new TRPCError({ code: 'NOT_FOUND' })

          const [task] = await ctx.db
            .insert(schema.tasks)
            .values({
              projectId: project.id,
              ownerId: ctx.user.id,
              title: input.title,
            })
            .returning()

          if (!task) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' })

          await ctx.realtime.publish(schema.tasks, 'create', task)
          return task
        }),

      complete: t.protectedProcedure
        .input(z.object({ taskId: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          const [task] = await ctx.db
            .update(schema.tasks)
            .set({
              status: 'done',
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.tasks.id, input.taskId),
                eq(schema.tasks.ownerId, ctx.user.id),
              ),
            )
            .returning()

          if (!task) throw new TRPCError({ code: 'NOT_FOUND' })

          // The write has committed and the complete row is returned, so the
          // access filter can evaluate owner and read-scope columns.
          await ctx.realtime.publish(schema.tasks, 'update', task)
          return task
        }),
    }),

    admin: t.router({
      overview: adminProcedure.query(async ({ ctx }) => {
        const [users] = await ctx.db.select({ value: count() }).from(schema.user)
        const [projects] = await ctx.db
          .select({ value: count() })
          .from(schema.projects)
        const [openTasks] = await ctx.db
          .select({ value: count() })
          .from(schema.tasks)
          .where(eq(schema.tasks.status, 'todo'))

        const recent = await ctx.db
          .select()
          .from(schema.projects)
          .orderBy(desc(schema.projects.createdAt))
          .limit(10)

        return {
          users: users?.value ?? 0,
          projects: projects?.value ?? 0,
          openTasks: openTasks?.value ?? 0,
          recent,
        }
      }),
    }),
  })
}
