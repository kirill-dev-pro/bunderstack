import { defineApi } from 'bunderstack'
import { desc, eq, sql } from 'drizzle-orm'
import * as v from 'valibot'

import * as schema from './schema'

// The builder is a plain module value, so router modules import the bases they
// need instead of receiving them through a factory argument.
const o = defineApi({ schema })

export const api = {
  feed: o.public
    .route({ method: 'GET', path: '/api/feed' })
    .input(
      v.optional(
        v.object({
          limit: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
            20,
          ),
        }),
      ),
    )
    .handler(async ({ context, input }) => {
      const limit = input?.limit ?? 20
      const rows = await context.db
        .select({
          post: schema.posts,
          author: {
            id: schema.user.id,
            name: schema.user.name,
            image: schema.user.image,
          },
          likeCount: sql<number>`count(${schema.likes.id})`,
        })
        .from(schema.posts)
        .innerJoin(schema.user, eq(schema.posts.userId, schema.user.id))
        .leftJoin(schema.likes, eq(schema.likes.postId, schema.posts.id))
        .groupBy(schema.posts.id)
        .orderBy(desc(schema.posts.createdAt))
        .limit(limit)
      return rows
    }),
}
