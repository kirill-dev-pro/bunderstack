import { BunderstackError, createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { provision } from 'bunderstack/provision'
import { and, count, desc, eq } from 'drizzle-orm'
import * as v from 'valibot'

import { access } from './access'
import { authConfig } from './auth'
import { envSchema } from './env'
import { defineJobs } from './jobs'
import * as schema from './schema'

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
 * Factory form so tests can own an isolated in-memory database. Production
 * uses the module-level `app` below.
 */
export async function createBunderSaaSApp(options: { databaseUrl?: string } = {}) {
  return createBunderstack({
    schema,
    access,
    env: envSchema,
    database: {
      adapter: libsql(),
      url: options.databaseUrl ?? process.env.DATABASE_URL ?? 'file:./data.db',
    },
    auth: authConfig,
    email: {
      from: process.env.EMAIL_FROM ?? 'BunderSaaS <hello@example.com>',
    },
    storage: {
      local: './uploads',
      defaultBucket: 'project-files',
      buckets: {
        'project-files': {
          visibility: 'private',
          access: { create: 'authenticated', get: 'owner', delete: 'owner' },
          upload: { maxSize: '10mb' },
        },
      },
    },
    // A shared Redis transport is required once the worker runs as its own
    // process, because the in-memory broker cannot cross process boundaries.
    realtime: process.env.REDIS_URL ? { redis: process.env.REDIS_URL } : true,
    jobs: defineJobs,
    api: (o) => ({
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
        .handler(async ({ context, input }) => {
          const [project] = await context.db
            .insert(schema.projects)
            .values({
              ownerId: context.user.id,
              name: input.name,
              clientName: input.clientName,
              dueAt: input.dueAt ?? null,
            })
            .returning()
          if (!project) throw new BunderstackError('CONFLICT', 'Project was not created')
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
        .handler(async ({ context, input }) => {
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
          if (!project) throw new BunderstackError('NOT_FOUND', 'Project not found')

          const [task] = await context.db
            .insert(schema.tasks)
            .values({ projectId: project.id, ownerId: context.user.id, title: input.title })
            .returning()
          if (!task) throw new BunderstackError('CONFLICT', 'Task was not created')
          await context.realtime.publish(schema.tasks, 'create', task)
          return task
        }),

      completeTask: o.protected
        .route({ method: 'POST', path: '/api/tasks/{taskId}/complete' })
        .input(v.object({ taskId: v.pipe(v.string(), v.minLength(1)) }))
        .output(taskOutput)
        .handler(async ({ context, input }) => {
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
          if (!task) throw new BunderstackError('NOT_FOUND', 'Task not found')
          await context.realtime.publish(schema.tasks, 'update', task)
          return task
        }),

      adminOverview: o.protected
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
          if (context.user.role !== 'admin') {
            throw new BunderstackError('FORBIDDEN', 'Admin access required')
          }
          const [users] = await context.db.select({ value: count() }).from(schema.user)
          const [projects] = await context.db.select({ value: count() }).from(schema.projects)
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
    }),
  })
}

export const createRelayApp = createBunderSaaSApp
export const app = await createBunderSaaSApp()
export const { db, auth, env } = app
export type App = typeof app

// Development pushes the schema until `migrations/` is committed, after which
// this applies the committed migrations instead.
await provision(app)
