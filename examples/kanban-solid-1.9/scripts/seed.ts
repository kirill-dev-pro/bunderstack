/**
 * Seed the Acme organization with a Roadmap board.
 * Run: bun run seed
 */
import { eq } from 'drizzle-orm'

import { app } from '../src/bunderstack.ts'
import {
  boards,
  cards,
  lists,
  member,
  organization,
  user,
} from '../src/schema.ts'

const PASSWORD = 'password123'

const SEED_USERS = [
  { name: 'Alice Chen', email: 'alice@example.com', role: 'owner' },
  { name: 'Bob Rivera', email: 'bob@example.com', role: 'member' },
  { name: 'Carol Kim', email: 'carol@example.com', role: 'member' },
] as const

/** Sign-up goes through the real auth handler so passwords hash the same way. */
async function signUp(name: string, email: string): Promise<string | null> {
  const existing = await app.db.select().from(user).where(eq(user.email, email))
  if (existing[0]) return existing[0].id

  const res = await app.handler(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, password: PASSWORD }),
    }),
  )
  if (!res.ok) {
    console.warn(`  sign-up ${email}: ${res.status} ${await res.text()}`)
    return null
  }
  const body = (await res.json()) as { user?: { id: string } }
  return body.user?.id ?? null
}

console.log('Seeding kanban example…')

const userIds = new Map<string, string>()
for (const seedUser of SEED_USERS) {
  const id = await signUp(seedUser.name, seedUser.email)
  if (id) userIds.set(seedUser.email, id)
}

const ORG_ID = 'org_acme'
const existingOrg = await app.db
  .select()
  .from(organization)
  .where(eq(organization.id, ORG_ID))

if (!existingOrg[0]) {
  await app.db.insert(organization).values({
    id: ORG_ID,
    name: 'Acme',
    slug: 'acme',
    createdAt: new Date(),
  })
  for (const seedUser of SEED_USERS) {
    const userId = userIds.get(seedUser.email)
    if (!userId) continue
    await app.db.insert(member).values({
      id: `mbr_${seedUser.email.split('@')[0]}`,
      organizationId: ORG_ID,
      userId,
      role: seedUser.role,
      createdAt: new Date(),
    })
  }
}

const existingBoards = await app.db
  .select()
  .from(boards)
  .where(eq(boards.organizationId, ORG_ID))

if (!existingBoards[0]) {
  const [board] = await app.db
    .insert(boards)
    .values({ organizationId: ORG_ID, title: 'Roadmap' })
    .returning()

  if (board) {
    const columns = ['Backlog', 'In Progress', 'Done']
    for (const [index, title] of columns.entries()) {
      const [list] = await app.db
        .insert(lists)
        .values({
          organizationId: ORG_ID,
          boardId: board.id,
          title,
          position: (index + 1) * 1000,
        })
        .returning()
      if (!list) continue
      if (title !== 'Backlog') continue
      await app.db.insert(cards).values([
        {
          organizationId: ORG_ID,
          boardId: board.id,
          listId: list.id,
          title: 'Drag a card between columns',
          position: 1000,
        },
        {
          organizationId: ORG_ID,
          boardId: board.id,
          listId: list.id,
          title: 'Open a card to comment',
          position: 2000,
        },
      ])
    }
  }
}

console.log('')
console.log('Done. Demo accounts (password: password123):')
for (const seedUser of SEED_USERS) {
  console.log(`  ${seedUser.email} — ${seedUser.role} in Acme`)
}

await app.close()
