import { expect, test } from 'bun:test'

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
  expect(manifest.background.jobs).toEqual([{ name: 'sendProjectDigest' }])
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
