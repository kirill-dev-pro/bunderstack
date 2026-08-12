import { QueryClient } from '@tanstack/react-query'
import { describe, it, expect } from 'bun:test'

import { createTableCollection } from './collection'

type Post = { id: string; title: string; replyToId: string | null }

/** 450 root posts p001..p450, server pages capped at 200, cursor = last id. */
function paginatedProcedureFactory() {
  const rows: Post[] = Array.from({ length: 450 }, (_, i) => ({
    id: `p${String(i + 1).padStart(3, '0')}`,
    title: `post ${i + 1}`,
    replyToId: null,
  }))
  const calls: Record<string, unknown>[] = []
  const list = async (input: Record<string, any> = {}) => {
    calls.push(input)
    const limit = Math.min(Number(input.limit ?? 20), 200)
    const idFilter = input.filters?.id as string[] | undefined
    if (idFilter) {
      const wanted = new Set(idFilter)
      return {
        items: rows.filter((r) => wanted.has(r.id)),
        hasMore: false,
      }
    }
    const cursor = input.cursor as string | undefined
    const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0
    const items = rows.slice(start, start + limit)
    const hasMore = start + limit < rows.length
    return {
      items,
      hasMore,
      nextCursor: hasMore ? items[items.length - 1]!.id : undefined,
    }
  }
  return { procedures: { list: { call: list }, get: { call: async ({ id }: { id: string }) => rows.find((row) => row.id === id)! }, create: { call: async (v: any) => v }, update: { call: async ({ body }: any) => body }, delete: { call: async () => {} } }, calls, rows }
}

function makeTable(procedures: ReturnType<typeof paginatedProcedureFactory>['procedures']) {
  return createTableCollection<Post>({
    tableName: 'posts',
    procedures,
    queryClient: new QueryClient(),
  })
}

describe('scopedCollection', () => {
  it('returns the same instance for the same options', () => {
    const t = makeTable(paginatedProcedureFactory().procedures)
    const a = t.scopedCollection({ filters: { replyToId: null }, order: 'desc' })
    const b = t.scopedCollection({ filters: { replyToId: null }, order: 'desc' })
    expect(a).toBe(b)
    const c = t.scopedCollection({
      filters: { replyToId: 'p1' },
      order: 'desc',
    })
    expect(c).not.toBe(a)
  })

  it('grows the window across cursor pages and tracks hasMore', async () => {
    const { procedures } = paginatedProcedureFactory()
    const t = makeTable(procedures)
    const scoped = t.scopedCollection({ initialCount: 20 })
    await scoped.collection.stateWhenReady()
    expect(scoped.collection.size).toBe(20)
    expect(scoped.hasMore()).toBe(true)

    await scoped.loadMore(430) // to exactly 450 = table size
    expect(scoped.collection.size).toBe(450)
    expect(scoped.hasMore()).toBe(false)
    expect(scoped.size()).toBe(450)
  })
})

describe('collectionByIds', () => {
  it('chunks requests at the server cap and caches by id set', async () => {
    const { procedures, calls, rows } = paginatedProcedureFactory()
    const t = makeTable(procedures)
    const ids = rows.slice(0, 250).map((r) => r.id)
    const byIds = t.collectionByIds(ids)
    expect(t.collectionByIds([...ids].reverse())).toBe(byIds) // order-insensitive cache
    await byIds.stateWhenReady()
    expect(byIds.size).toBe(250)
    const idCalls = calls.filter((c) => (c.filters as any)?.id)
    expect(idCalls.length).toBe(2) // 200 + 50
  })

  it('returns an empty collection for no ids without fetching', async () => {
    const { procedures, calls } = paginatedProcedureFactory()
    const t = makeTable(procedures)
    const byIds = t.collectionByIds([])
    await byIds.stateWhenReady()
    expect(byIds.size).toBe(0)
    expect(calls.length).toBe(0)
  })
})

describe('applyRealtimeEvent', () => {
  it('upserts matching rows into scoped collections and skips non-matching', async () => {
    const { procedures } = paginatedProcedureFactory()
    const t = makeTable(procedures)
    const feed = t.scopedCollection({ filters: { replyToId: null } })
    await feed.collection.stateWhenReady()
    const before = feed.collection.size

    t.applyRealtimeEvent('create', { id: 'new1', title: 'x', replyToId: null })
    expect(feed.collection.size).toBe(before + 1)

    t.applyRealtimeEvent('create', {
      id: 'new2',
      title: 'y',
      replyToId: 'p001',
    })
    expect(feed.collection.get('new2')).toBeUndefined()

    // update that stops matching the filter removes the row from the scope
    t.applyRealtimeEvent('update', {
      id: 'new1',
      title: 'x',
      replyToId: 'p001',
    })
    expect(feed.collection.get('new1')).toBeUndefined()

    t.applyRealtimeEvent('delete', { id: 'p001' })
    expect(feed.collection.get('p001')).toBeUndefined()
  })

  it('routes realtime rows into byIds collections only for tracked ids', async () => {
    const { procedures } = paginatedProcedureFactory()
    const t = makeTable(procedures)
    const byIds = t.collectionByIds(['p001', 'p002'])
    await byIds.stateWhenReady()

    t.applyRealtimeEvent('update', {
      id: 'p001',
      title: 'renamed',
      replyToId: null,
    })
    expect(byIds.get('p001')).toMatchObject({ title: 'renamed' })

    t.applyRealtimeEvent('create', { id: 'p999', title: 'z', replyToId: null })
    expect(byIds.get('p999')).toBeUndefined()
  })
})
