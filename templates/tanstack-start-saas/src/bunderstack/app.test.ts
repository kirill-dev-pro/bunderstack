import { afterEach, expect, test } from 'bun:test'
import { mockAuthSession } from 'bunderstack'
import { provision } from 'bunderstack/provision'

import { createBunderSaaSApp } from './index'
import * as schema from './schema'

type BunderSaaSApp = Awaited<ReturnType<typeof createBunderSaaSApp>>

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

function signIn(app: BunderSaaSApp, id: string, role: 'user' | 'admin' = 'user') {
  mockAuthSession(app, async () => ({
    user: { id, email: `${id}@bunderstack.test`, name: id, role },
  }))
}

const apps: Awaited<ReturnType<typeof createBunderSaaSApp>>[] = []
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('declares the full SaaS runtime', async () => {
  const app = await createBunderSaaSApp({ databaseUrl: 'file::memory:' })
  apps.push(app)
  expect(app.manifest.realtime.required).toBe(true)
  expect(app.manifest.background.jobs).toEqual([{ name: 'sendProjectDigest' }])
  expect(app.manifest.background.cron).toEqual([
    { name: 'archiveCompletedTasks', schedule: '0 3 * * *', timezone: 'UTC' },
    { name: 'bunderstack:storage-sweep', schedule: '0 4 * * *', timezone: 'UTC' },
  ])
})

test('does not expose projects without a session', async () => {
  const app = await createBunderSaaSApp({ databaseUrl: 'file::memory:' })
  apps.push(app)
  await provision(app, { force: true })
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects'),
  )
  expect(response.status).toBe(401)
})

test('scopes the project list to the signed-in owner', async () => {
  const app = await createBunderSaaSApp({ databaseUrl: 'file::memory:' })
  apps.push(app)
  await provision(app, { force: true })

  await seedUser(app, 'user_alice')
  await seedUser(app, 'user_bob')
  await app.db.insert(schema.projects).values([
    { id: 'project_a', ownerId: 'user_alice', name: 'Alice launch' },
    { id: 'project_b', ownerId: 'user_bob', name: 'Bob rebrand' },
  ])

  signIn(app, 'user_alice')
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects'),
  )
  expect(response.status).toBe(200)

  const body = (await response.json()) as { items: { id: string }[] }
  expect(body.items.map((row) => row.id)).toEqual(['project_a'])
})

test('refuses a cross-owner project read', async () => {
  const app = await createBunderSaaSApp({ databaseUrl: 'file::memory:' })
  apps.push(app)
  await provision(app, { force: true })

  await seedUser(app, 'user_alice')
  await seedUser(app, 'user_bob')
  await app.db
    .insert(schema.projects)
    .values({ id: 'project_b', ownerId: 'user_bob', name: 'Bob rebrand' })

  signIn(app, 'user_alice')
  const response = await app.handler(
    new Request('http://bunderstack.test/api/projects/project_b'),
  )
  // The owner rule refuses before the read scope filters, so this is 403
  // rather than the 404 a scope-only configuration would produce.
  expect(response.status).toBe(403)
})
