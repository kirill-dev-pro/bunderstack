import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { desc, eq, sql } from 'drizzle-orm'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'

import { access } from './access'
import * as schema from './schema'

export const app = await createBunderstack({
  schema,
  access,
  database: {
    adapter: libsql(),
    url: process.env.DATABASE_URL ?? 'file:./data.db',
  },
  auth: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
    emailAndPassword: { enabled: true },
    secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
    advanced: {
      database: {
        generateId: () => false,
      },
    },
  },
  storage: {
    local: './uploads',
    defaultBucket: 'attachments',
    buckets: {
      avatars: {
        visibility: 'public',
        access: { create: 'authenticated', get: 'public', delete: 'owner' },
        upload: {
          maxSize: '2mb',
          accept: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        },
        transforms: true,
      },
      attachments: {
        visibility: 'public',
        access: { create: 'authenticated', get: 'public', delete: 'owner' },
        upload: {
          maxSize: '10mb',
          accept: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
        },
        transforms: true,
      },
    },
  },
  api: (o) => ({
    feed: o.public
      .meta(openapi({ method: 'GET', path: '/api/feed' }))
      .input(
        z
          .object({ limit: z.number().int().min(1).max(50).default(20) })
          .optional(),
      )
      .handler(async ({ context, input }: { context: any; input: any }) => {
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
  }),
})
