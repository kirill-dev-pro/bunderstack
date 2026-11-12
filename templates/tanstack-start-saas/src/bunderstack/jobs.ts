import type { BunderstackJobsBuilder } from 'bunderstack'

import { and, eq, lt } from 'drizzle-orm'
import * as v from 'valibot'

import type { RelayEnv } from './env'
import type { Channels } from './messaging'

import * as schema from './schema'
import { addTaskToProject } from './tasks'

/**
 * Background work. Queue handlers are at-least-once, so they must be
 * idempotent. Cron tasks are delivered by the platform and appear in the
 * deployment blueprint — never as an application HTTP route behind a secret.
 */
export const defineJobs = (
  jobs: BunderstackJobsBuilder<typeof schema, RelayEnv, Channels>,
) =>
  jobs.define({
    // Enqueued by the "Email me a digest" button (`requestDigest`).
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

        const list = open
          .map((task) => `<li>${escapeHtml(task.title)}</li>`)
          .join('')
        await ctx.messaging.email.send({
          to: owner.email,
          subject: `${project.name}: ${open.length} open deliverables`,
          html: `<p>${open.length} deliverables are still open on ${escapeHtml(project.name)}.</p>${list ? `<ul>${list}</ul>` : ''}`,
        })
      },
    }),

    // Mail to tasks+<projectId>@<your domain> becomes a task in that project,
    // when it comes from the project's owner and passes the host's checks.
    taskFromEmail: jobs.inbound('inbox', {
      concurrency: 2,
      handler: async (message, ctx) => {
        const { verdicts } = message
        if (
          verdicts.dmarc === 'FAIL' ||
          verdicts.spam === 'FAIL' ||
          verdicts.virus === 'FAIL'
        ) {
          return
        }
        const recipients = [
          ...message.envelope.to,
          ...message.to.map((entry) => entry.address),
        ]
        const projectId = recipients
          .map((address) => /\+(project_[a-z0-9]+)@/i.exec(address)?.[1])
          .find(Boolean)
        const sender = message.from?.address.toLowerCase()
        if (!projectId || !sender) return

        const [owner] = await ctx.db
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(eq(schema.user.email, sender))
          .limit(1)
        if (!owner) return

        await addTaskToProject(ctx, {
          projectId: projectId.toLowerCase(),
          ownerId: owner.id,
          title: message.subject,
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

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
