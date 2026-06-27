import { auth, db } from '../src/bunderstack'
import * as schema from '../src/schema'

const users = [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Carol', email: 'carol@example.com' },
]

const created: { id: string }[] = []
for (const u of users) {
  const res = await auth.api.signUpEmail({ body: { ...u, password: 'password123' } })
  created.push({ id: res.user.id })
}

const orgId = crypto.randomUUID()
await db.insert(schema.organization).values({
  id: orgId,
  name: 'Acme',
  slug: 'acme',
  createdAt: new Date(),
})
for (const u of created) {
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: u.id,
    role: u === created[0] ? 'owner' : 'member',
    createdAt: new Date(),
  })
}

const boardId = (
  await db.insert(schema.boards).values({ organizationId: orgId, title: 'Roadmap' }).returning()
)[0]!.id
const listDefs = ['Backlog', 'In Progress', 'Done']
let pos = 1000
for (const title of listDefs) {
  const listId = (
    await db
      .insert(schema.lists)
      .values({ organizationId: orgId, boardId, title, position: pos })
      .returning()
  )[0]!.id
  await db.insert(schema.cards).values({
    organizationId: orgId,
    boardId,
    listId,
    title: `Sample card in ${title}`,
    position: 1000,
  })
  pos += 1000
}
console.log('Seeded org', orgId, 'board', boardId)
process.exit(0)
