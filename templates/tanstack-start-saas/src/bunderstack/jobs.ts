import type { BunderstackJobsBuilder } from 'bunderstack'

import { and, eq, lt } from 'drizzle-orm'
import * as v from 'valibot'

import type { RelayEnv } from './env'

import * as schema from './schema'

/**
 * Background work. Queue handlers are at-least-once, so they must be
 * idempotent. Cron tasks are delivered by the platform and appear in the
 * deployment blueprint — never as an application HTTP route behind a secret.
 */
export const defineJobs = (
  jobs: BunderstackJobsBuilder<typeof schema, RelayEnv>,
) =>
  jobs.define({
    sendProjectDigest: jobs.job({
      input: v.object({ projectId: v.pipe(v.string(), v.minLength(1)) }),
      concurrency: 2,
      timeout: 60_000,
      handler: async ({ projectId }, ctx) => {
        const [project] = await ctx.db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .limit(1)
        if (!project) return

        const [owner] = await ctx.db
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, project.ownerId))
          .limit(1)
        if (!owner) return

        const open = await ctx.db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.projectId, projectId),
              eq(schema.tasks.status, 'todo'),
            ),
          )

        await ctx.email.send({
          to: owner.email,
          subject: `${project.name}: ${open.length} open deliverables`,
          html: `<p>${open.length} deliverables are still open on ${project.name}.</p>`,
        })
      },
    }),

    archiveCompletedTasks: jobs.cron({
      schedule: '0 3 * * *',
      // Cron handlers receive the invocation first, then the job context.
      handler: async (_invocation, ctx) => {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        await ctx.db
          .delete(schema.tasks)
          .where(
            and(
              eq(schema.tasks.status, 'done'),
              lt(schema.tasks.completedAt, cutoff),
            ),
          )
      },
    }),
  })
