import { defineApi, type ApiContext } from 'bunderstack'
import { and, count, desc, eq } from 'drizzle-orm'
import { createHmac, timingSafeEqual } from 'node:crypto'
import * as v from 'valibot'

import type { Channels } from './messaging'

import { envSchema } from './env'
import * as schema from './schema'
import { addTaskToProject } from './tasks'

// The builder is a plain module value. Router modules import the bases they
// need; nothing has to be threaded through the config callback. Naming the
// channels gives procedures the exact `context.messaging` type.
export const o = defineApi<typeof schema, typeof envSchema, Channels>({
  schema,
  env: envSchema,
})

/** The public bucket's name, shared with the storage declaration. */
export const PUBLIC_BUCKET = 'public'

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
  coverUrl: v.nullable(v.string()),
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
 * Registered in `bunderstack({ middleware })`, so it covers the
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
      const task = await addTaskToProject(context, {
        ...input,
        ownerId: context.user.id,
      })
      if (!task) throw errors.NOT_FOUND({ message: 'Project not found' })
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

  /**
   * Queues the digest job instead of sending inline: the request returns at
   * once, the worker sends, and a retry never sends twice for one click
   * because the dedupe key collapses repeated enqueues.
   */
  requestDigest: o.protected
    .route({ method: 'POST', path: '/api/projects/{projectId}/digest' })
    .input(v.object({ projectId: v.pipe(v.string(), v.minLength(1)) }))
    .output(v.object({ queued: v.literal(true) }))
    .handler(async ({ context, input, errors }) => {
      const project = await ownProject(context, input.projectId)
      if (!project) throw errors.NOT_FOUND({ message: 'Project not found' })
      await context.jobs.enqueue(
        'sendProjectDigest',
        { projectId: project.id },
        { dedupeKey: `digest:${project.id}` },
      )
      return { queued: true as const }
    }),

  /**
   * Records a file the browser uploaded to the private `project-files` bucket
   * as an attachment of a project. Storage already knows who owns the file;
   * this checks it before linking the two.
   */
  attachFile: o.protected
    .route({ method: 'POST', path: '/api/projects/{projectId}/attachments' })
    .input(
      v.object({
        projectId: v.pipe(v.string(), v.minLength(1)),
        fileId: v.pipe(v.string(), v.startsWith('project-files/')),
      }),
    )
    .output(v.object({ id: v.string() }))
    .handler(async ({ context, input, errors }) => {
      const project = await ownProject(context, input.projectId)
      if (!project) throw errors.NOT_FOUND({ message: 'Project not found' })
      const file = await ownReadyFile(context, input.fileId)
      if (!file) throw errors.NOT_FOUND({ message: 'File not found' })
      const [attachment] = await context.db
        .insert(schema.attachments)
        .values({
          projectId: project.id,
          ownerId: context.user.id,
          fileId: file.fileId,
          filename: file.filename ?? 'file',
          contentType: file.contentType ?? '',
          size: file.size ?? 0,
        })
        .returning()
      if (!attachment) throw errors.CONFLICT({ message: 'Not attached' })
      await context.realtime.publish(schema.attachments, 'create', attachment)
      return { id: attachment.id }
    }),

  /** Deletes the attachment row and the stored file with it. */
  removeAttachment: o.protected
    .route({ method: 'POST', path: '/api/attachments/{attachmentId}/remove' })
    .input(v.object({ attachmentId: v.pipe(v.string(), v.minLength(1)) }))
    .output(v.object({ removed: v.literal(true) }))
    .handler(async ({ context, input, errors }) => {
      const [attachment] = await context.db
        .delete(schema.attachments)
        .where(
          and(
            eq(schema.attachments.id, input.attachmentId),
            eq(schema.attachments.ownerId, context.user.id),
          ),
        )
        .returning()
      if (!attachment) throw errors.NOT_FOUND({ message: 'Not found' })
      await context.storage.delete(attachment.fileId)
      await context.realtime.publish(schema.attachments, 'delete', attachment)
      return { removed: true as const }
    }),

  /**
   * Sets a project's cover from an image in the public bucket. Public files
   * are served to anyone at their URL, which is what a cover, an avatar or an
   * image in a newsletter needs.
   */
  setProjectCover: o.protected
    .route({ method: 'POST', path: '/api/projects/{projectId}/cover' })
    .input(
      v.object({
        projectId: v.pipe(v.string(), v.minLength(1)),
        fileId: v.pipe(v.string(), v.startsWith(`${PUBLIC_BUCKET}/`)),
      }),
    )
    .output(projectOutput)
    .handler(async ({ context, input, errors }) => {
      const file = await ownReadyFile(context, input.fileId)
      if (!file?.contentType?.startsWith('image/')) {
        throw errors.BAD_REQUEST({ message: 'Upload an image first' })
      }
      const [project] = await context.db
        .update(schema.projects)
        .set({ coverUrl: `/api/files/${file.fileId}`, updatedAt: new Date() })
        .where(
          and(
            eq(schema.projects.id, input.projectId),
            eq(schema.projects.ownerId, context.user.id),
          ),
        )
        .returning()
      if (!project) throw errors.NOT_FOUND({ message: 'Project not found' })
      await context.realtime.publish(schema.projects, 'update', project)
      return project
    }),

  /**
   * The address that turns mail into tasks for this project, once the host
   * routes a domain to the `inbox` channel; null until then.
   */
  projectInbox: o.protected
    .route({ method: 'GET', path: '/api/projects/{projectId}/inbox' })
    .input(v.object({ projectId: v.pipe(v.string(), v.minLength(1)) }))
    .output(v.object({ address: v.nullable(v.string()) }))
    .handler(async ({ context, input, errors }) => {
      const project = await ownProject(context, input.projectId)
      if (!project) throw errors.NOT_FOUND({ message: 'Project not found' })
      const inbox = context.messaging.inbox
      const domain = inbox.receiving ? inbox.domains[0] : undefined
      return { address: domain ? `tasks+${project.id}@${domain}` : null }
    }),

  /**
   * A signed webhook: another system adds a task by POSTing
   * `{ projectId, title }` with `X-Relay-Signature: sha256=<hex HMAC of the
   * body under TASKS_WEBHOOK_SECRET>`. Signed requests skip the session
   * lookup, and without the secret every request is refused.
   */
  taskWebhook: o.webhook
    .route({
      method: 'POST',
      path: '/api/webhooks/tasks',
      inputStructure: 'detailed',
      successStatus: 201,
    })
    .input(
      v.object({
        params: v.optional(v.object({}), {}),
        query: v.optional(v.record(v.string(), v.unknown()), {}),
        headers: v.record(v.string(), v.unknown()),
        body: v.object({
          projectId: v.pipe(v.string(), v.minLength(1)),
          title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        }),
      }),
    )
    .output(v.object({ taskId: v.string() }))
    .handler(async ({ context, input, errors }) => {
      const secret = context.env.TASKS_WEBHOOK_SECRET
      const signature = input.headers['x-relay-signature']
      if (
        !secret ||
        typeof signature !== 'string' ||
        !signatureMatches(secret, await context.getRawBody(), signature)
      ) {
        throw errors.UNAUTHORIZED({ message: 'Bad signature' })
      }
      const [project] = await context.db
        .select({ ownerId: schema.projects.ownerId })
        .from(schema.projects)
        .where(eq(schema.projects.id, input.body.projectId))
        .limit(1)
      const task = project
        ? await addTaskToProject(context, {
            ...input.body,
            ownerId: project.ownerId,
          })
        : null
      if (!task) throw errors.NOT_FOUND({ message: 'Project not found' })
      return { taskId: task.id }
    }),

  /**
   * Adds the signed-in user to the newsletter: a contact tagged `newsletter`,
   * with consent recorded. Calling it again changes nothing. Broadcasts to
   * `newsletter` go out through the `news` channel.
   */
  subscribeToNews: o.protected
    .route({ method: 'POST', path: '/api/subscribe-to-news' })
    .input(v.optional(v.object({})))
    .output(v.object({ subscribed: v.literal(true) }))
    .handler(async ({ context }) => {
      await context.contacts.upsert({
        email: context.user.email,
        name: context.user.name,
        userId: context.user.id,
        source: 'sign-up',
        tags: ['newsletter'],
        consent: { source: 'sign-up form' },
      })
      // Someone who unsubscribed and ticks the box again means it.
      await context.contacts.resubscribe({ email: context.user.email })
      return { subscribed: true as const }
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

type OwnerContext = {
  db: ApiContext<typeof schema>['db']
  user: { id: string }
}

function ownProject(context: OwnerContext, projectId: string) {
  return context.db
    .select()
    .from(schema.projects)
    .where(
      and(
        eq(schema.projects.id, projectId),
        eq(schema.projects.ownerId, context.user.id),
      ),
    )
    .get()
}

function ownReadyFile(context: OwnerContext, fileId: string) {
  return context.db
    .select()
    .from(schema.bunderstackFiles)
    .where(
      and(
        eq(schema.bunderstackFiles.fileId, fileId),
        eq(schema.bunderstackFiles.ownerId, context.user.id),
        eq(schema.bunderstackFiles.status, 'ready'),
      ),
    )
    .get()
}

function signatureMatches(secret: string, body: string, header: string) {
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  )
  const actual = Buffer.from(header)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
