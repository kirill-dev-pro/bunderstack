import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { app } from '~/bunderstack'
import { posts } from '~/schema'

export type PostType = typeof posts.$inferSelect

export const fetchPosts = createServerFn({ method: 'GET' }).handler(() =>
  app.db.select().from(posts).orderBy(posts.createdAt),
)

export const fetchPost = createServerFn({ method: 'GET' })
  .validator((postId: number) => postId)
  .handler(async ({ data }) => {
    const [post] = await app.db.select().from(posts).where(eq(posts.id, data))
    if (!post) throw notFound()
    return post
  })

export const createPost = createServerFn({ method: 'POST' })
  .validator((d: { title: string; body: string; userId: string }) => d)
  .handler(async ({ data }) => {
    const [post] = await app.db.insert(posts).values(data).returning()
    return post
  })

export const deletePost = createServerFn({ method: 'POST' })
  .validator((postId: number) => postId)
  .handler(async ({ data }) => {
    await app.db.delete(posts).where(eq(posts.id, data))
  })
