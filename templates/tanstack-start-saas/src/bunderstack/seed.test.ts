import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { backend } from './backend'
import * as schema from './schema'
import { DEMO_USER } from './seed'

test('the seed gives a fresh database a demo user who can sign in', async () => {
  // The committed migrations build the tables, as on a host.
  await using fixture = await backend.test({
    seed: true,
    database: { schema: 'migrations' },
  })
  const { app } = fixture

  const signedIn = await app.auth.api.signInEmail({
    body: { email: DEMO_USER.email, password: DEMO_USER.password },
  })
  expect(signedIn.user.email).toBe(DEMO_USER.email)
  await expect(
    app.auth.api.signInEmail({
      body: { email: DEMO_USER.email, password: 'not-the-password' },
    }),
  ).rejects.toThrow()

  const [demo] = await app.db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, DEMO_USER.email))
  const projects = await app.db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.ownerId, demo!.id))
  expect(projects.map((project) => project.name).sort()).toEqual([
    'Spring launch',
    'Website refresh',
  ])
  expect(await app.db.select().from(schema.tasks)).toHaveLength(4)
})

test('a database is empty unless a seed is asked for', async () => {
  await using fixture = await backend.test({
    database: { schema: 'migrations' },
  })
  expect(await fixture.app.db.select().from(schema.user)).toEqual([])
})
