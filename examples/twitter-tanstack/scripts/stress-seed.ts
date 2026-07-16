/**
 * Bulk-generates a large social graph for stress/perf testing — feed
 * pagination, infinite scroll, search, and busy thread/profile pages.
 * Purely additive (never deletes existing rows); safe to run repeatedly.
 *
 * Run: bun run stress-seed
 *   or: bun scripts/stress-seed.ts --users=2000 --posts=20000 --replies=5000 --follows=10000 --likes=40000 --retweets=10000
 */
import { generateTypeId, type TypeId } from 'bunderstack'
import { eq } from 'drizzle-orm'

import { app } from '~/bunderstack'

import { follows, likes, posts, retweets, user } from '../src/schema'

function intArg(name: string, fallback: number): number {
  const flag = `--${name}=`
  const arg = process.argv.find((a) => a.startsWith(flag))
  return arg ? Number(arg.slice(flag.length)) : fallback
}

const USERS = intArg('users', 500)
const ROOT_POSTS = intArg('posts', 6000)
const REPLIES = intArg('replies', 2000)
const FOLLOWS = intArg('follows', 3000)
const LIKES = intArg('likes', 12000)
const RETWEETS = intArg('retweets', 3000)
const BATCH_SIZE = 200

// ---- tiny zero-dep random content generators ----

const FIRST_NAMES = [
  'Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia',
  'Alan', 'Katherine', 'John', 'Hedy', 'Tim', 'Joan', 'Bjarne', 'Frances',
  'Guido', 'Sophie', 'James', 'Rasmus', 'Yukihiro', 'Anita', 'Brendan', 'Ellen',
]
const LAST_NAMES = [
  'Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson',
  'Perlman', 'Turing', 'Johnson', 'Carmack', 'Lamarr', 'Berners-Lee', 'Clarke',
  'Stroustrup', 'Allen', 'van Rossum', 'Wilson', 'Gosling', 'Lerdorf', 'Matsumoto',
  'Borg', 'Eich', 'Spertus',
]
const WORDS = [
  'schema', 'drizzle', 'migration', 'access', 'rule', 'owner', 'column',
  'query', 'cache', 'invalidate', 'realtime', 'broadcast', 'bucket', 'upload',
  'thumbnail', 'sharp', 'webp', 'typeid', 'prefix', 'sqlite', 'libsql', 'hono',
  'handler', 'route', 'crud', 'auth', 'session', 'token', 'provision',
  'transaction', 'index', 'pagination', 'cursor', 'infinite', 'scroll',
  'hydration', 'ssr', 'loader', 'mutation', 'devtools', 'bun', 'runtime',
  'progressive', 'disclosure', 'instance', 'level', 'zero', 'dependency',
  'thread', 'reply', 'follow', 'like', 'retweet', 'feed', 'search', 'fast',
  'tiny', 'composable', 'pragmatic', 'shipped', 'works', 'today', 'finally',
]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

function randomDate(daysAgo: number): Date {
  return new Date(Date.now() - randomInt(0, daysAgo * 24 * 60 * 60 * 1000))
}

function randomName(): string {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`
}

function randomSentence(minWords: number, maxWords: number): string {
  const n = randomInt(minWords, maxWords)
  const sentence = Array.from({ length: n }, () => pick(WORDS)).join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

async function insertBatches<T extends Record<string, unknown>>(
  label: string,
  table: Parameters<typeof app.db.insert>[0],
  rows: T[],
) {
  if (rows.length === 0) return
  await app.db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      await tx.insert(table).values(rows.slice(i, i + BATCH_SIZE))
    }
  })
  console.log(`  ${label}: +${rows.length}`)
}

console.log(
  `Stress-seeding: ${USERS} users, ${ROOT_POSTS} posts, ${REPLIES} replies, ` +
    `${FOLLOWS} follows, ${LIKES} likes, ${RETWEETS} retweets`,
)
const start = Date.now()

// 1. Bulk users — inserted directly (bypassing better-auth sign-up, which
// hashes passwords and is far too slow for thousands of synthetic accounts).
// None of these can log in; they exist purely to populate feeds/threads.
const userRows = Array.from({ length: USERS }, (_, i) => {
  const id = generateTypeId('user')
  const name = randomName()
  const createdAt = randomDate(365)
  return {
    id,
    name,
    email: `stress-${i}-${id.slice(-8)}@example.com`,
    emailVerified: false,
    image: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(name)}-${i}`,
    about: Math.random() < 0.6 ? randomSentence(4, 14) : '',
    createdAt,
    updatedAt: createdAt,
  }
})
await insertBatches('users', user, userRows)

// Pull every user id (including pre-existing alice/bob/carol) so posts,
// follows, likes, and retweets reference real accounts across the board.
const allUsers = await app.db.select({ id: user.id }).from(user)
const allUserIds = allUsers.map((u) => u.id)

// 2. Root posts
const rootPostIds: TypeId<'post'>[] = []
const rootPostRows = Array.from({ length: ROOT_POSTS }, () => {
  const id = generateTypeId('post')
  rootPostIds.push(id)
  const body = randomSentence(8, 40)
  return {
    id,
    title: body.slice(0, 60),
    body,
    userId: pick(allUserIds),
    replyToId: null,
    createdAt: randomDate(365),
  }
})
await insertBatches('posts (root)', posts, rootPostRows)

// 3. Replies — single-level, matching the app's thread model (only direct
// replyToId === postId rows are shown on a thread page).
const replyRows = Array.from({ length: REPLIES }, () => {
  const body = randomSentence(4, 24)
  return {
    id: generateTypeId('post'),
    title: body.slice(0, 60),
    body,
    userId: pick(allUserIds),
    replyToId: pick(rootPostIds),
    createdAt: randomDate(365),
  }
})
await insertBatches('posts (replies)', posts, replyRows)

const allPostIds = [...rootPostIds, ...replyRows.map((r) => r.id)]

// 4. Follows — deduped (followerId, followingId) pairs, no self-follows
function dedupedPairs<A, B>(
  count: number,
  pickA: () => A,
  pickB: () => B,
  reject: (a: A, b: B) => boolean,
) {
  const seen = new Set<string>()
  const rows: { a: A; b: B }[] = []
  let attempts = 0
  while (rows.length < count && attempts < count * 5) {
    attempts++
    const a = pickA()
    const b = pickB()
    if (reject(a, b)) continue
    const key = `${a}:${b}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ a, b })
  }
  return rows
}

const followRows = dedupedPairs(
  FOLLOWS,
  () => pick(allUserIds),
  () => pick(allUserIds),
  (a, b) => a === b,
).map(({ a, b }) => ({ followerId: a, followingId: b }))
await insertBatches('follows', follows, followRows)

// 5. Likes — deduped (userId, postId) pairs
const likeRows = dedupedPairs(
  LIKES,
  () => pick(allUserIds),
  () => pick(allPostIds),
  () => false,
).map(({ a, b }) => ({ userId: a, postId: b }))
await insertBatches('likes', likes, likeRows)

// 6. Retweets — deduped (userId, postId) pairs
const retweetRows = dedupedPairs(
  RETWEETS,
  () => pick(allUserIds),
  () => pick(allPostIds),
  () => false,
).map(({ a, b }) => ({ userId: a, postId: b }))
await insertBatches('retweets', retweets, retweetRows)

const elapsed = ((Date.now() - start) / 1000).toFixed(1)
console.log(`\nDone in ${elapsed}s.`)

const [userCount, postCount, followCount, likeCount, retweetCount] =
  await Promise.all([
    app.db.$count(user),
    app.db.$count(posts),
    app.db.$count(follows),
    app.db.$count(likes),
    app.db.$count(retweets),
  ])
console.log('Totals in db now:')
console.log(`  users: ${userCount}`)
console.log(`  posts: ${postCount}`)
console.log(`  follows: ${followCount}`)
console.log(`  likes: ${likeCount}`)
console.log(`  retweets: ${retweetCount}`)
