import { defineApi } from 'bunderstack'
import { and, count, desc, eq } from 'drizzle-orm'
import * as v from 'valibot'

import { envSchema } from './env'
import * as schema from './schema'

// The builder is a plain module value. Router modules import the bases they
// need; nothing has to be threaded through the config callback.
export const o = defineApi({ schema, env: envSchema })

/**
 * A base is an oRPC builder, so `.use()` gives you your own. Declaring the
 * admin rule once keeps it out of every handler that depends on it.
 */
const adminProcedure = o.protected.use(async ({ context, next, errors }) => {
  if (context.user.role !== 'admin') {
    throw errors.FORBIDDEN({ message: 'Admin access required' })
  }
  return next()
})

const projectOutput = v.object({
  id: v.string(),
  ownerId: v.string(),
  name: v.string(),
  clientName: v.string(),
  status: v.picklist(schema.PROJECT_STATUSES),
  dueAt: v.nullable(v.date()),
  createdAt: v.date(),
  updatedAt: v.date(),
})

const taskOutput = v.object({
  id: v.string(),
  projectId: v.string(),
  ownerId: v.string(),
  title: v.string(),
  status: v.picklist(schema.TASK_STATUSES),
  position: v.number(),
  completedAt: v.nullable(v.date()),
  createdAt: v.date(),
  updatedAt: v.date(),
})

/**
 * Registered in `createBunderstack({ middleware })`, so it covers the
 * generated CRUD, storage, and realtime procedures too — a middleware placed
 * on a base above would only see the procedures declared in this file.
 *
 * It runs before authentication, so the caller is read with `peekSession()`
 * after the handler returns. That never forces a session resolution, which
 * keeps signed webhooks free of an auth round trip.
 */
export const requestTiming = o.middleware(async ({ context, next, path }) => {
  // A realtime subscription lives until the client disconnects, so timing it
  // here would measure the connection, not the work.
  if (path[0] === 'realtime') return next()

  const name = path.join('.')
  const startedAt = performance.now()
  try {
    return await next()
  } finally {
    console.info('[rpc]', name, {
      ms: Math.round(performance.now() - startedAt),
      userId: context.peekSession()?.user?.id ?? null,
    })
  }
})

export const api = {
  createProject: o.protected
    .route({ method: 'POST', path: '/api/create-project', successStatus: 201 })
    .input(
      v.object({
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
        clientName: v.optional(v.pipe(v.string(), v.maxLength(120)), ''),
        dueAt: v.optional(v.date()),
      }),
    )
    .output(projectOutput)
    .handler(async ({ context, input, errors }) => {
      const [project] = await context.db
        .insert(schema.projects)
        .values({
          ownerId: context.user.id,
          name: input.name,
          clientName: input.clientName,
          dueAt: input.dueAt ?? null,
        })
        .returning()
      if (!project)
        throw errors.CONFLICT({ message: 'Project was not created' })
      await context.realtime.publish(schema.projects, 'create', project)
      return project
    }),

  addTask: o.protected
    .route({ method: 'POST', path: '/api/add-task', successStatus: 201 })
    .input(
      v.object({
        projectId: v.pipe(v.string(), v.minLength(1)),
        title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      }),
    )
    .output(taskOutput)
    .handler(async ({ context, input, errors }) => {
      const [project] = await context.db
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, input.projectId),
            eq(schema.projects.ownerId, context.user.id),
          ),
        )
        .limit(1)
      if (!project) throw errors.NOT_FOUND({ message: 'Project not found' })

      const [task] = await context.db
        .insert(schema.tasks)
        .values({
          projectId: project.id,
          ownerId: context.user.id,
          title: input.title,
        })
        .returning()
      if (!task) throw errors.CONFLICT({ message: 'Task was not created' })
      await context.realtime.publish(schema.tasks, 'create', task)
      return task
    }),

  completeTask: o.protected
    .route({ method: 'POST', path: '/api/tasks/{taskId}/complete' })
    .input(v.object({ taskId: v.pipe(v.string(), v.minLength(1)) }))
    .output(taskOutput)
    .handler(async ({ context, input, errors }) => {
      const [task] = await context.db
        .update(schema.tasks)
        .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.tasks.id, input.taskId),
            eq(schema.tasks.ownerId, context.user.id),
          ),
        )
        .returning()
      if (!task) throw errors.NOT_FOUND({ message: 'Task not found' })
      await context.realtime.publish(schema.tasks, 'update', task)
      return task
    }),

  adminOverview: adminProcedure
    .route({ method: 'GET', path: '/api/admin/overview' })
    .input(v.optional(v.object({})))
    .output(
      v.object({
        users: v.number(),
        projects: v.number(),
        openTasks: v.number(),
        recent: v.array(projectOutput),
      }),
    )
    .handler(async ({ context }) => {
      const [users] = await context.db
        .select({ value: count() })
        .from(schema.user)
      const [projects] = await context.db
        .select({ value: count() })
        .from(schema.projects)
      const [openTasks] = await context.db
        .select({ value: count() })
        .from(schema.tasks)
        .where(eq(schema.tasks.status, 'todo'))
      const recent = await context.db
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
}
