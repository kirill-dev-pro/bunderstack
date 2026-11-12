import type { ApiContext } from 'bunderstack'

import { and, eq } from 'drizzle-orm'

import * as schema from './schema'

/**
 * Tasks arrive from three places: the project page, a signed webhook and an
 * email to the project's address. All of them end here, so the owner check and
 * the realtime update are written once.
 */
export async function addTaskToProject(
  ctx: Pick<ApiContext<typeof schema>, 'db' | 'realtime'>,
  input: { projectId: string; ownerId: string; title: string },
) {
  const [project] = await ctx.db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, input.projectId),
        eq(schema.projects.ownerId, input.ownerId),
      ),
    )
    .limit(1)
  if (!project) return null

  const [task] = await ctx.db
    .insert(schema.tasks)
    .values({
      projectId: project.id,
      ownerId: input.ownerId,
      title: input.title.trim().slice(0, 200) || 'Untitled task',
    })
    .returning()
  if (task) await ctx.realtime.publish(schema.tasks, 'create', task)
  return task ?? null
}
