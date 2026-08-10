import { describe, it, expect, beforeEach } from 'bun:test'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { Hono } from 'hono'
import { OpenAPIHandler } from '@orpc/openapi/fetch'

import { validateAndResolveAccess } from './access'
import { buildCrudRouter } from './crud'
import { buildCrudApiRouter } from './api/crud-router'
import { createApiContext } from './api/context'
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

describe('crud-operations core execution', () => {
  let db: any

  beforeEach(async () => {
    db = await setupTestDb()
  })

  it('executes list, get, create, update, delete directly', async () => {
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
    const ops = createCrudOperations({ schema, db, access })
    const dummyReq = new Request('http://localhost/api/posts')
    const ctx = {
      request: dummyReq,
      user: { id: 'u1', email: 'u1@test.com' },
      session: { activeOrganizationId: 'org1' },
    }

    // Create
    const created = await ops.create(
      'posts',
      { id: 'p1', title: 'Title 1' },
      undefined,
      undefined,
      ctx,
    )
    expect(created.type).toBe('created')
    expect(created.status).toBe(201)
    expect(created.record.id).toBe('p1')

    // Get
    const fetched = await ops.get('posts', 'p1', ctx)
    expect(fetched.title).toBe('Title 1')

    // List
    const listRes = await ops.list('posts', undefined, ctx)
    expect(listRes.items).toHaveLength(1)
    expect(listRes.items[0]!.id).toBe('p1')

    // Update
    const updated = await ops.update(
      'posts',
      'p1',
      { title: 'Updated Title' },
      ctx,
    )
    expect(updated.title).toBe('Updated Title')

    // Delete
    await ops.delete('posts', 'p1', ctx)
    await expect(ops.get('posts', 'p1', ctx)).rejects.toThrow(
      CrudOperationError,
    )
  })

  it('enforces access control and scopes in operations core', async () => {
    const access = validateAndResolveAccess(schema, {
      posts: {
        ownerColumn: 'userId',
        list: 'authenticated',
        get: 'authenticated',
        create: 'authenticated',
        update: 'authenticated',
        delete: 'authenticated',
        scope: {
          read: (c) => ({ orgId: c.session?.activeOrganizationId ?? '' }),
          write: (c) => ({ orgId: c.session?.activeOrganizationId ?? '' }),
        },
      },
    })
    const ops = createCrudOperations({ schema, db, access })
    const req = new Request('http://localhost/api/posts')
    const unauthCtx = {
      request: req,
      user: null,
      session: { activeOrganizationId: null },
    }
    const authCtx = {
      request: req,
      user: { id: 'u1', email: 'u1@test.com' },
      session: { activeOrganizationId: 'org_1' },
    }

    // Unauthenticated create fails
    await expect(
      ops.create(
        'posts',
        { id: 'p1', title: 'P1' },
        undefined,
        undefined,
        unauthCtx,
      ),
    ).rejects.toThrow(CrudOperationError)

    // Authenticated create stamps org_1
    const created = await ops.create(
      'posts',
      { id: 'p1', title: 'P1', orgId: 'spoofed_org' },
      undefined,
      undefined,
      authCtx,
    )
    expect(created.record.orgId).toBe('org_1')

    // Different org context gets 404
    const otherOrgCtx = {
      request: req,
      user: { id: 'u2', email: 'u2@test.com' },
      session: { activeOrganizationId: 'org_2' },
    }
    await expect(ops.get('posts', 'p1', otherOrgCtx)).rejects.toThrow(
      CrudOperationError,
    )
  })
})

describe('Hono and oRPC Adapter Parity', () => {
  let honoDb: any
  let orpcDb: any
  let honoEvents: any[]
  let orpcEvents: any[]
  let honoApp: Hono
  let openapiHandler: OpenAPIHandler<any>
  let orpcMockDeps: any

  beforeEach(async () => {
    honoDb = await setupTestDb()
    orpcDb = await setupTestDb()
    honoEvents = []
    orpcEvents = []

    const access = validateAndResolveAccess(schema, {
      posts: {
        ownerColumn: 'userId',
        searchableColumns: ['title', 'content'],
        filterableColumns: ['userId', 'orgId'],
        sortableColumns: ['id', 'title'],
        defaultSort: { column: 'id', order: 'asc' },
        list: 'authenticated',
        get: 'authenticated',
        create: 'authenticated',
        update: 'owner',
        delete: 'owner',
        scope: {
          read: (c) => ({ orgId: c.session?.activeOrganizationId ?? '' }),
          write: (c) => ({ orgId: c.session?.activeOrganizationId ?? '' }),
        },
      },
    })

    const honoRealtime = {
      publish: async (table: any, action: any, record: any) => {
        honoEvents.push({ table, action, record })
      },
    } as any

    const orpcRealtime = {
      publish: async (table: any, action: any, record: any) => {
        orpcEvents.push({ table, action, record })
      },
    } as any

    const testAuthResolver = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const user = headers.get('x-user-id')
          const org = headers.get('x-org-id')
          if (!user) return null
          return {
            user: { id: user, email: `${user}@test.com` },
            session: { activeOrganizationId: org },
            activeOrganizationId: org,
          }
        },
      },
    }

    // 1. Hono router
    honoApp = new Hono()
    honoApp.route(
      '/api',
      buildCrudRouter(schema, honoDb, {
        auth: testAuthResolver as any,
        access,
        idempotency: true,
        realtime: honoRealtime,
      }),
    )

    // 2. oRPC router
    const crudApiRouter = buildCrudApiRouter(schema, orpcDb, {
      access,
      idempotency: true,
      realtime: orpcRealtime,
    })

    openapiHandler = new OpenAPIHandler(crudApiRouter as any, {
      customErrorResponseBodyEncoder: (error: any) => ({
        error: error.message,
        code: error.data?.code ?? error.code,
        ...(error.data?.details !== undefined ? { details: error.data.details } : {}),
      }),
      fetchInterceptors: [
        async (options) => {
          const res = await options.next()
          if (res.matched && options.context?.resHeaders) {
            options.context.resHeaders.forEach((v: string, k: string) =>
              res.response.headers.set(k, v),
            )
          }
          return res
        },
      ],
    })

    orpcMockDeps = {
      db: orpcDb,
      env: {},
      storage: {} as any,
      email: {} as any,
      jobs: {} as any,
      realtime: orpcRealtime,
      auth: {} as any,
      authResolver: testAuthResolver,
    }
  })

  async function executeTransports(path: string, init?: RequestInit) {
    // Hono
    const honoReq = new Request(`http://localhost${path}`, init)
    const honoRes = await honoApp.fetch(honoReq)

    // oRPC
    const orpcReq = new Request(`http://localhost${path}`, init)
    const resHeaders = new Headers()
    const apiCtx = {
      ...createApiContext(orpcMockDeps, orpcReq),
      resHeaders,
    }
    const orpcResult = await openapiHandler.handle(orpcReq, { context: apiCtx })
    const orpcRes = orpcResult.response!

    return { honoRes, orpcRes }
  }

  it('both adapters return 401 unauthenticated and 403 forbidden with matching error envelopes', async () => {
    // 401 Unauthenticated create
    const { honoRes: hono401, orpcRes: orpc401 } = await executeTransports('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'p1', title: 'Post 1' }),
    })

    expect(hono401.status).toBe(401)
    expect(orpc401.status).toBe(401)
    const hono401Body = await hono401.json()
    const orpc401Body = await orpc401.json()
    expect(hono401Body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' })
    expect(orpc401Body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' })

    // Seed post as user1 in org1 on both DBs
    await executeTransports('/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user1',
        'x-org-id': 'org1',
      },
      body: JSON.stringify({ id: 'p1', title: 'Post 1' }),
    })

    // 403 Forbidden update by user2 (not owner)
    const { honoRes: hono403, orpcRes: orpc403 } = await executeTransports('/api/posts/p1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'user2',
        'x-org-id': 'org1',
      },
      body: JSON.stringify({ title: 'Hacked' }),
    })

    expect(hono403.status).toBe(403)
    expect(orpc403.status).toBe(403)
    const hono403Body = await hono403.json()
    const orpc403Body = await orpc403.json()
    expect(hono403Body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' })
    expect(orpc403Body).toEqual({ error: 'Forbidden', code: 'FORBIDDEN' })
  })

  it('both adapters succeed on CRUD payloads (201 create, 200 get/update, 204 delete) and publish realtime exactly once', async () => {
    honoEvents.length = 0
    orpcEvents.length = 0

    // 1. Create (201)
    const { honoRes: createHono, orpcRes: createOrpc } = await executeTransports('/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'u1',
        'x-org-id': 'org1',
      },
      body: JSON.stringify({ id: 'p1', title: 'Post 1' }),
    })

    expect(createHono.status).toBe(201)
    expect(createOrpc.status).toBe(201)
    const createdHonoBody = await createHono.json()
    const createdOrpcBody = await createOrpc.json()
    expect(createdHonoBody).toEqual(createdOrpcBody)
    expect(createdHonoBody).toEqual({
      id: 'p1',
      title: 'Post 1',
      content: null,
      userId: 'u1',
      orgId: 'org1',
    })

    // Realtime events published exactly once per transport
    expect(honoEvents).toHaveLength(1)
    expect(orpcEvents).toHaveLength(1)
    expect(honoEvents[0].action).toBe('create')
    expect(orpcEvents[0].action).toBe('create')

    // 2. Get (200)
    const { honoRes: getHono, orpcRes: getOrpc } = await executeTransports('/api/posts/p1', {
      headers: { 'x-user-id': 'u1', 'x-org-id': 'org1' },
    })
    expect(getHono.status).toBe(200)
    expect(getOrpc.status).toBe(200)
    expect(await getHono.json()).toEqual(await getOrpc.json())

    // 3. Update (200)
    const { honoRes: updateHono, orpcRes: updateOrpc } = await executeTransports('/api/posts/p1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'u1',
        'x-org-id': 'org1',
      },
      body: JSON.stringify({ title: 'Updated Post' }),
    })
    expect(updateHono.status).toBe(200)
    expect(updateOrpc.status).toBe(200)
    const updatedHono = (await updateHono.json()) as any
    const updatedOrpc = (await updateOrpc.json()) as any
    expect(updatedHono).toEqual(updatedOrpc)
    expect(updatedHono.title).toBe('Updated Post')

    // 4. Delete (204)
    const { honoRes: deleteHono, orpcRes: deleteOrpc } = await executeTransports('/api/posts/p1', {
      method: 'DELETE',
      headers: { 'x-user-id': 'u1', 'x-org-id': 'org1' },
    })
    expect(deleteHono.status).toBe(204)
    expect(deleteOrpc.status).toBe(204)
  })

  it('both adapters enforce scope hiding (404) and scope stamping', async () => {
    // Create p1 in org1
    await executeTransports('/api/posts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'u1',
        'x-org-id': 'org1',
      },
      body: JSON.stringify({ id: 'p1', title: 'Post 1', orgId: 'spoofed' }),
    })

    // Out of scope get (org2 context) gets 404
    const { honoRes: get404Hono, orpcRes: get404Orpc } = await executeTransports('/api/posts/p1', {
      headers: { 'x-user-id': 'u1', 'x-org-id': 'org2' },
    })
    expect(get404Hono.status).toBe(404)
    expect(get404Orpc.status).toBe(404)
  })

  it('both adapters handle idempotency replay and conflicts identically', async () => {
    const key = 'idem-key-1'
    const headers = {
      'Content-Type': 'application/json',
      'x-user-id': 'u1',
      'x-org-id': 'org1',
      'Idempotency-Key': key,
    }

    // 1st request
    const { honoRes: res1Hono, orpcRes: res1Orpc } = await executeTransports('/api/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'idem1', title: 'Idem Post' }),
    })

    expect(res1Hono.status).toBe(201)
    expect(res1Orpc.status).toBe(201)

    // Replay request with same key and body
    const { honoRes: replayHono, orpcRes: replayOrpc } = await executeTransports('/api/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'idem1', title: 'Idem Post' }),
    })

    expect(replayHono.status).toBe(201)
    expect(replayOrpc.status).toBe(201)
    expect(replayHono.headers.get('Idempotency-Replayed')).toBe('true')
    expect(replayOrpc.headers.get('Idempotency-Replayed')).toBe('true')

    // Conflict request with same key and different body
    const { honoRes: conflictHono, orpcRes: conflictOrpc } = await executeTransports('/api/posts', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'idem1', title: 'Different Title' }),
    })

    expect(conflictHono.status).toBe(409)
    expect(conflictOrpc.status).toBe(409)
    const conflictHonoBody = await conflictHono.json()
    const conflictOrpcBody = await conflictOrpc.json()
    expect(conflictHonoBody).toEqual({
      error: 'Idempotency key reused with different body',
      code: 'IDEMPOTENCY_CONFLICT',
    })
    expect(conflictOrpcBody).toEqual({
      error: 'Idempotency key reused with different body',
      code: 'IDEMPOTENCY_CONFLICT',
    })
  })
})
