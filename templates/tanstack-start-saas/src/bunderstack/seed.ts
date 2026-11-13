import { hashPassword } from 'better-auth/crypto'
import { defineSeed } from 'bunderstack/seed'

import { backend } from './backend'

/**
 * Who to sign in as in a database this seed has filled: a fresh local one
 * (`bun run dev`), or a preview that Bunderhost starts from the seed.
 */
export const DEMO_USER = {
  name: 'Demo User',
  email: 'demo@example.com',
  password: 'demo-password',
} as const

const DAY = 86_400_000

/**
 * What an empty database starts with. Runs once per database and never in
 * production: only a process started with `BUNDERSTACK_SEED=1` runs it. Every
 * write goes through `db`, which is one transaction, so a seed that fails
 * leaves nothing behind.
 */
export default defineSeed(backend, async ({ db, schema }) => {
  const now = new Date()
  const [demo] = await db
    .insert(schema.user)
    .values({
      name: DEMO_USER.name,
      email: DEMO_USER.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  // A password sign-in is an `account` row with Better Auth's own hash.
  await db.insert(schema.account).values({
    accountId: demo!.id,
    providerId: 'credential',
    userId: demo!.id,
    password: await hashPassword(DEMO_USER.password),
    createdAt: now,
    updatedAt: now,
  })

  const [website, launch] = await db
    .insert(schema.projects)
    .values([
      {
        ownerId: demo!.id,
        name: 'Website refresh',
        clientName: 'Northwind',
        status: 'production',
        dueAt: new Date(now.getTime() + 14 * DAY),
      },
      {
        ownerId: demo!.id,
        name: 'Spring launch',
        clientName: 'Contoso',
        status: 'brief',
        dueAt: new Date(now.getTime() + 45 * DAY),
      },
    ])
    .returning()
  // One statement for all the rows: quicker, and a remote database does not
  // hold a transaction open for long.
  await db.insert(schema.tasks).values([
    {
      projectId: website!.id,
      ownerId: demo!.id,
      title: 'Collect the brand assets',
      status: 'done',
      position: 0,
      completedAt: now,
    },
    {
      projectId: website!.id,
      ownerId: demo!.id,
      title: 'Draft the home page',
      status: 'doing',
      position: 1,
    },
    {
      projectId: website!.id,
      ownerId: demo!.id,
      title: 'Review with the client',
      position: 2,
    },
    {
      projectId: launch!.id,
      ownerId: demo!.id,
      title: 'Write the brief',
      position: 0,
    },
  ])
})
