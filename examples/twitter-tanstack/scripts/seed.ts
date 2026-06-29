/**
 * Seed demo users, educational posts, follows, likes, and threaded replies.
 * Run: bun run seed
 */
import { eq } from 'bunderstack'

import { app } from '~/bunderstack'

import { follows, likes, posts, retweets, user } from '../src/schema'

const PASSWORD = 'password123'

const SEED_USERS = [
  {
    name: 'Alice Chen',
    email: 'alice@example.com',
    image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=alice',
    about:
      'Core maintainer. Drizzle schema → auto-CRUD. Search: access control',
  },
  {
    name: 'Bob Rivera',
    email: 'bob@example.com',
    image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=bob',
    about: 'Full-stack on Bun. TanStack Start + bunderstack-query',
  },
  {
    name: 'Carol Kim',
    email: 'carol@example.com',
    image: 'https://api.dicebear.com/7.x/avataaars/svg?seed=carol',
    about: 'DX nerd. File storage, thumbnails, and owner-only writes',
  },
] as const

const EDUCATIONAL_POSTS: Array<{
  author: (typeof SEED_USERS)[number]['email']
  title: string
  body: string
}> = [
  {
    author: 'alice@example.com',
    title: 'Schema-first auto-CRUD',
    body: 'Define tables in Drizzle — Bunderstack mounts GET/POST/PATCH/DELETE at /api/:table. No hand-written route boilerplate.',
  },
  {
    author: 'alice@example.com',
    title: 'The userId convention',
    body: 'Add a userId column and owner-scoped update/delete kick in automatically. Public list/get, authenticated create, owner mutations.',
  },
  {
    author: 'alice@example.com',
    title: 'Explicit access rules',
    body: 'Use defineAccess() when conventions are not enough: follows use followerId, auth tables stay sealed unless exposeAuthTable.',
  },
  {
    author: 'bob@example.com',
    title: 'BetterAuth, one handler',
    body: 'Email/password sessions live at /api/auth/*. Same app.handler(Request) serves CRUD, auth, and files — mount in TanStack Start or Next.js.',
  },
  {
    author: 'bob@example.com',
    title: 'bunderstack-query',
    body: 'createBunderstackQueryClient exposes listQuery, createMutation, etc. Wire useQuery/useMutation directly — no custom hooks layer.',
  },
  {
    author: 'bob@example.com',
    title: 'Loader + hydration pattern',
    body: 'Prefetch with queryClient.ensureQueryData in route loaders, fall back to Route.useLoaderData() so SSR and client markup match.',
  },
  {
    author: 'carol@example.com',
    title: 'File storage API',
    body: 'POST /api/files/attachments uploads with mime/size rules. GET serves originals; ?w=&h=&format=webp returns on-the-fly thumbnails via sharp.',
  },
  {
    author: 'carol@example.com',
    title: 'Owner-only file delete',
    body: 'Storage access mirrors table access: authenticated upload, public read, owner delete. Metadata tracked in SQLite.',
  },
  {
    author: 'carol@example.com',
    title: 'List search with ?q=',
    body: 'Opt-in searchableColumns in access rules. GET /api/posts?q=drizzle runs parameterized LIKE across title and body — try the search box!',
  },
  {
    author: 'alice@example.com',
    title: 'Social tables are just tables',
    body: 'Follows, likes, retweets, and threaded replies — all plain Drizzle tables with ownerColumn access. Compose Twitter-style UX on top.',
  },
  {
    author: 'bob@example.com',
    title: 'Progressive disclosure',
    body: 'Level 0: createBunderstack({ schema }). Level 2: reach for app.db, app.router, app.auth when auto-CRUD is not enough.',
  },
  {
    author: 'carol@example.com',
    title: 'Auto-provision in dev',
    body: 'drizzle-kit push runs on boot in development so the example works after git clone. Production: run db:push explicitly.',
  },
  {
    author: 'alice@example.com',
    title: 'Try owner-only PATCH',
    body: 'Log in as alice@example.com and edit this post. Log in as bob and PATCH the same id — Bunderstack returns 403. That is row-level security.',
  },
]

const userIds = new Map<string, string>()

async function signUp(name: string, email: string): Promise<string | null> {
  const existing = await app.db.select().from(user).where(eq(user.email, email))
  if (existing[0]) return existing[0].id

  const res = await app.handler(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

console.log('Seeding TanStack Start example…')

for (const seedUser of SEED_USERS) {
  const userId = await signUp(seedUser.name, seedUser.email)
  if (!userId) continue
  userIds.set(seedUser.email, userId)

  await app.db
    .update(user)
    .set({
      image: seedUser.image,
      about: seedUser.about,
      updatedAt: new Date(),
    })
    .where(eq(user.id, userId))
}

// Reset demo content
await app.db.delete(likes)
await app.db.delete(retweets)
await app.db.delete(follows)
await app.db.delete(posts)

const postIds: number[] = []
for (const item of EDUCATIONAL_POSTS) {
  const userId = userIds.get(item.author)
  if (!userId) continue
  const rows = await app.db
    .insert(posts)
    .values({ title: item.title, body: item.body, userId })
    .returning({ id: posts.id })
  if (rows[0]) postIds.push(rows[0].id)
}

console.log(`  posts: ${postIds.length} educational posts`)

const aliceId = userIds.get('alice@example.com')
const bobId = userIds.get('bob@example.com')
const carolId = userIds.get('carol@example.com')

if (aliceId && bobId) {
  await app.db
    .insert(follows)
    .values({ followerId: aliceId, followingId: bobId })
  await app.db
    .insert(follows)
    .values({ followerId: bobId, followingId: aliceId })
}
if (aliceId && carolId) {
  await app.db
    .insert(follows)
    .values({ followerId: aliceId, followingId: carolId })
  await app.db
    .insert(follows)
    .values({ followerId: carolId, followingId: aliceId })
}

if (bobId && postIds[0]) {
  await app.db.insert(likes).values({ userId: bobId, postId: postIds[0] })
  await app.db.insert(posts).values({
    title: 'Reply on schema-first CRUD',
    body: 'Great overview — the search box uses GET /api/posts?q= under the hood.',
    userId: bobId,
    replyToId: postIds[0],
  })
}
if (carolId && postIds[0]) {
  await app.db.insert(posts).values({
    title: 'Nested reply',
    body: 'And replies are just posts with replyToId — open the thread to see the conversation.',
    userId: carolId,
    replyToId: postIds[0],
  })
}
if (carolId && postIds[8]) {
  await app.db.insert(retweets).values({ userId: carolId, postId: postIds[8] })
}

console.log('')
console.log('Done. Demo accounts (password: password123):')
for (const u of SEED_USERS) console.log(`  ${u.email}`)
console.log('')
console.log('Try search: drizzle, thumbnail, access control, bunderstack-query')
