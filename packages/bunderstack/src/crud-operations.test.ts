import { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'

import { validateAndResolveAccess } from './access'
import { createCrudOperations, CrudOperationError } from './crud-operations'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content'),
  userId: text('user_id'),
  orgId: text('org_id'),
})
const schema = { posts }

async function setupTestDb() {
  const client = new PGlite()
  await client.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      user_id TEXT,
      org_id TEXT
    );
    CREATE TABLE _bunderstack_idempotency (
      key TEXT NOT NULL,
      table_name TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      PRIMARY KEY (key, table_name)
    );
  `)
  return drizzle(client, { schema })
}

const publicContext = {
  request: new Request('http://localhost/api/posts'),
  user: { id: 'u1', email: 'u1@test.com' },
  session: { activeOrganizationId: 'org1' },
}

describe('crud operations', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>

  beforeEach(async () => {
    db = await setupTestDb()
  })

  it('executes list, get, create, update, and delete directly', async () => {
    const access = validateAndResolveAccess(schema, {
      posts: {
        ownerColumn: 'userId',
        list: 'public',
        get: 'public',
        create: 'public',
        update: 'public',
        delete: 'public',
      },
    })
    const operations = createCrudOperations({ schema, db, access })

    const created = await operations.create(
      'posts',
      { id: 'p1', title: 'Title 1' },
      undefined,
      undefined,
      publicContext,
    )
    expect(created).toMatchObject({
      type: 'created',
      status: 201,
      record: { id: 'p1', title: 'Title 1' },
    })

    expect(await operations.get('posts', 'p1', publicContext)).toMatchObject({
      id: 'p1',
      title: 'Title 1',
    })
    expect(
      (await operations.list('posts', undefined, publicContext)).items,
    ).toHaveLength(1)
    expect(
      await operations.update(
        'posts',
        'p1',
        { title: 'Updated' },
        publicContext,
      ),
    ).toMatchObject({ id: 'p1', title: 'Updated' })

    await operations.delete('posts', 'p1', publicContext)
    await expect(operations.get('posts', 'p1', publicContext)).rejects.toThrow(
      CrudOperationError,
    )
  })

  it('maps unauthenticated and forbidden access to distinct framework codes', async () => {
    const access = validateAndResolveAccess(schema, {
      posts: {
        ownerColumn: 'userId',
        create: 'authenticated',
        update: 'owner',
      },
    })
    const operations = createCrudOperations({ schema, db, access })
    const unauthenticated = { ...publicContext, user: null }

    const unauthorized = await operations
      .create(
        'posts',
        { id: 'p1', title: 'Title' },
        undefined,
        undefined,
        unauthenticated,
      )
      .catch((value) => value)
    expect(unauthorized).toBeInstanceOf(CrudOperationError)
    expect(unauthorized.code).toBe('UNAUTHORIZED')

    await operations.create(
      'posts',
      { id: 'p1', title: 'Title' },
      undefined,
      undefined,
      publicContext,
    )
    const forbidden = await operations
      .update(
        'posts',
        'p1',
        { title: 'Changed' },
        {
          ...publicContext,
          user: { id: 'u2', email: 'u2@test.com' },
        },
      )
      .catch((value) => value)
    expect(forbidden).toBeInstanceOf(CrudOperationError)
    expect(forbidden.code).toBe('FORBIDDEN')
  })

  it('replays identical idempotent creates and conflicts on different raw bytes', async () => {
    const access = validateAndResolveAccess(schema, {
      posts: { create: 'public' },
    })
    const operations = createCrudOperations({
      schema,
      db,
      access,
      idempotency: true,
    })
    const compact = '{"id":"p1","title":"Title"}'
    const formatted = '{ "id": "p1", "title": "Title" }'

    const created = await operations.create(
      'posts',
      JSON.parse(compact),
      compact,
      'same-key',
      publicContext,
    )
    expect(created.type).toBe('created')

    const replay = await operations.create(
      'posts',
      JSON.parse(compact),
      compact,
      'same-key',
      publicContext,
    )
    expect(replay.type).toBe('replay')

    const conflict = await operations
      .create(
        'posts',
        JSON.parse(formatted),
        formatted,
        'same-key',
        publicContext,
      )
      .catch((value) => value)
    expect(conflict).toBeInstanceOf(CrudOperationError)
    expect(conflict.code).toBe('CONFLICT')
    expect(conflict.details).toEqual({ code: 'IDEMPOTENCY_CONFLICT' })
  })
})
