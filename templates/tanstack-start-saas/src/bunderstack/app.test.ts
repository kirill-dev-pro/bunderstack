import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'

import { backend } from './backend'
import * as schema from './schema'

type BunderSaaSApp = Awaited<ReturnType<typeof backend.start>>
type BunderSaaSTest = Awaited<ReturnType<typeof backend.test>>

const createTestApp = () => backend.test({ database: { schema: 'push' } })

async function seedUser(
  app: BunderSaaSApp,
  id: string,
  role: 'user' | 'admin' = 'user',
) {
  const now = new Date()
  await app.db
    .insert(schema.user)
    .values({
      id,
      name: id,
      email: `${id}@bunderstack.test`,
      role,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
}

/**
 * A mocked session is an identity, not global state: its headers must reach
 * the request, so two identities can act in the same test without collision.
 */
function signIn(
  testApp: BunderSaaSTest,
  id: string,
  role: 'user' | 'admin' = 'user',
) {
  return testApp.auth.mockSession({
    id,
    email: `${id}@bunderstack.test`,
    name: id,
    role,
  })
}

test('declares the full SaaS runtime', () => {
  const manifest = backend.inspect()
  expect(manifest.realtime.required).toBe(true)
  expect(manifest.background.jobs.map((job) => job.name)).toEqual([
    'sendProjectDigest',
    'taskFromEmail',
  ])
  expect(manifest.background.cron).toEqual([
    { name: 'archiveCompletedTasks', schedule: '0 3 * * *', timezone: 'UTC' },
    {
      name: 'bunderstack:storage-sweep',
      schedule: '0 4 * * *',
      timezone: 'UTC',
    },
  ])
})

test('does not expose projects without a session', async () => {
  await using t = await createTestApp()
  const { app } = t
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects'),
  )
  expect(response.status).toBe(401)
})

test('scopes the project list to the signed-in owner', async () => {
  await using t = await createTestApp()
  const { app } = t

  await seedUser(app, 'user_alice')
  await seedUser(app, 'user_bob')
  await app.db.insert(schema.projects).values([
    { id: 'project_a', ownerId: 'user_alice', name: 'Alice launch' },
    { id: 'project_b', ownerId: 'user_bob', name: 'Bob rebrand' },
  ])

  const alice = signIn(t, 'user_alice')
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects', {
      headers: alice.headers,
    }),
  )
  expect(response.status).toBe(200)

  const body = (await response.json()) as { items: { id: string }[] }
  expect(body.items.map((row) => row.id)).toEqual(['project_a'])
})

test('keeps custom creation procedures reachable at unique REST paths', async () => {
  await using t = await createTestApp()
  const { app } = t

  await seedUser(app, 'user_alice')
  const alice = signIn(t, 'user_alice')
  const headers = new Headers(alice.headers)
  headers.set('Content-Type', 'application/json')

  const projectResponse = await app.handler(
    new Request('http://bunderstack.test/api/create-project', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Alice launch', clientName: 'Acme' }),
    }),
  )
  expect(projectResponse.status).toBe(201)
  const project = (await projectResponse.json()) as { id: string }

  const taskResponse = await app.handler(
    new Request('http://bunderstack.test/api/add-task', {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: project.id, title: 'Ship it' }),
    }),
  )
  expect(taskResponse.status).toBe(201)
})

test('refuses a cross-owner project read', async () => {
  await using t = await createTestApp()
  const { app } = t

  await seedUser(app, 'user_alice')
  await seedUser(app, 'user_bob')
  await app.db
    .insert(schema.projects)
    .values({ id: 'project_b', ownerId: 'user_bob', name: 'Bob rebrand' })

  const alice = signIn(t, 'user_alice')
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects/project_b', {
      headers: alice.headers,
    }),
  )
  // The owner rule refuses before the read scope filters, so this is 403
  // rather than the 404 a scope-only configuration would produce.
  expect(response.status).toBe(403)
})

const WEBHOOK_SECRET = 'test-webhook-secret-0123456789'

async function seedProject(app: BunderSaaSApp) {
  await seedUser(app, 'user_alice')
  await app.db
    .insert(schema.projects)
    .values({ id: 'project_a', ownerId: 'user_alice', name: 'Alice launch' })
}

const tasksOf = (app: BunderSaaSApp) => app.db.select().from(schema.tasks).all()

function webhook(body: string, signature?: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (signature) headers.set('X-Relay-Signature', signature)
  return new Request('http://bunderstack.test/api/webhooks/tasks', {
    method: 'POST',
    headers,
    body,
  })
}

test('adds a task from a webhook only when the body is signed', async () => {
  await using t = await backend.test({
    database: { schema: 'push' },
    env: { TASKS_WEBHOOK_SECRET: WEBHOOK_SECRET },
  })
  const { app } = t
  await seedProject(app)
  const body = JSON.stringify({ projectId: 'project_a', title: 'From CI' })

  expect((await app.handler(webhook(body))).status).toBe(401)
  expect((await app.handler(webhook(body, 'sha256=00'))).status).toBe(401)

  const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`
  const response = await app.handler(webhook(body, signature))
  expect(response.status).toBe(201)
  expect((await tasksOf(app)).map((task) => task.title)).toEqual(['From CI'])
})

test('refuses every webhook while no secret is set', async () => {
  await using t = await createTestApp()
  await seedProject(t.app)
  const body = JSON.stringify({ projectId: 'project_a', title: 'From CI' })
  const signature = `sha256=${createHmac('sha256', '').update(body).digest('hex')}`
  expect((await t.app.handler(webhook(body, signature))).status).toBe(401)
})

test("turns the owner's email to a project address into a task", async () => {
  await using t = await createTestApp()
  await seedProject(t.app)

  await t.messaging.inbox.receive({
    from: 'Alice <user_alice@bunderstack.test>',
    to: 'tasks+project_a@inbox.example',
    subject: 'Call the printer',
  })
  await t.messaging.inbox.receive({
    from: 'mallory@elsewhere.example',
    to: 'tasks+project_a@inbox.example',
    subject: 'Not from the owner',
  })
  await t.jobs.runUntilIdle()

  expect((await tasksOf(t.app)).map((task) => task.title)).toEqual([
    'Call the printer',
  ])
})

test('queues one digest per project and the worker emails it', async () => {
  await using t = await createTestApp()
  await seedProject(t.app)
  const alice = signIn(t, 'user_alice')
  const headers = new Headers(alice.headers)
  headers.set('Content-Type', 'application/json')
  const request = () =>
    new Request('http://bunderstack.test/api/projects/project_a/digest', {
      method: 'POST',
      headers,
      body: '{}',
    })

  expect((await t.app.handler(request())).status).toBe(200)
  expect((await t.app.handler(request())).status).toBe(200)
  expect(await t.jobs.pending({ name: 'sendProjectDigest' })).toHaveLength(1)

  await t.jobs.runUntilIdle()
  expect(t.messaging.email.sent).toHaveLength(1)
  expect(t.messaging.email.sent[0]?.to).toEqual(['user_alice@bunderstack.test'])
})

test("will not attach another user's file", async () => {
  await using t = await createTestApp()
  const { app } = t
  await seedProject(app)
  await seedUser(app, 'user_bob')
  await app.db.insert(schema.bunderstackFiles).values({
    fileId: 'project-files/bob.pdf',
    bucket: 'project-files',
    ownerId: 'user_bob',
    status: 'ready',
    filename: 'bob.pdf',
    contentType: 'application/pdf',
    size: 10,
    createdAt: Date.now(),
  })

  const alice = signIn(t, 'user_alice')
  const headers = new Headers(alice.headers)
  headers.set('Content-Type', 'application/json')
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects/project_a/attachments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileId: 'project-files/bob.pdf' }),
    }),
  )
  expect(response.status).toBe(404)
  expect(await app.db.select().from(schema.attachments).all()).toEqual([])
})
