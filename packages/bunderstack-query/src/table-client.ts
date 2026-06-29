import type { ListParams, Paginated } from './types.ts'

import { BunderstackApiError } from './errors.ts'

const RESERVED_LIST_PARAMS = new Set([
  'limit',
  'offset',
  'sort',
  'order',
  'q',
  'cursor',
  'count',
  'cursorMode',
])

export type TableClientConfig = {
  tableName: string
  baseUrl: string
  fetch: typeof fetch
}

async function parseError(res: Response): Promise<BunderstackApiError> {
  const body = await res.json().catch(() => ({}))
  const message =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
      ? body.error
      : `Request failed (${res.status})`
  return new BunderstackApiError(message, res.status, body)
}

export function createTableClient<
  TRow,
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
>(config: TableClientConfig) {
  const { tableName, baseUrl, fetch: fetchFn } = config
  const root = `${baseUrl.replace(/\/$/, '')}/${tableName}`

  const keys = {
    all: [tableName] as const,
    lists: () => [tableName, 'list'] as const,
    list: (params: ListParams) => [tableName, 'list', params] as const,
    details: () => [tableName, 'detail'] as const,
    detail: (id: string | number) => [tableName, 'detail', id] as const,
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchFn(`${root}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })

    if (!res.ok) throw await parseError(res)
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  const list = (params: ListParams = {}) => {
    const qs = new URLSearchParams()

    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    if (params.offset !== undefined) qs.set('offset', String(params.offset))
    if (params.sort) qs.set('sort', params.sort)
    if (params.order) qs.set('order', params.order)
    if (params.q?.trim()) qs.set('q', params.q.trim())
    if (params.cursor) qs.set('cursor', params.cursor)
    if (params.count) qs.set('count', 'true')

    for (const [key, value] of Object.entries(params)) {
      if (RESERVED_LIST_PARAMS.has(key)) continue
      if (value === undefined) continue
      qs.set(key, value === null ? 'null' : String(value))
    }

    if (!qs.has('limit')) qs.set('limit', '20')
    if (!qs.has('offset') && !qs.has('cursor') && !params.cursorMode) {
      qs.set('offset', '0')
    }

    return request<Paginated<TRow>>(`?${qs}`)
  }

  const listInfiniteQuery = (params: ListParams = {}) => {
    const {
      offset: _offset,
      cursor: _cursor,
      cursorMode: _cursorMode,
      ...base
    } = params
    return {
      queryKey: [...keys.list(params), 'infinite'] as const,
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        list({
          ...base,
          cursorMode: true,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage: Paginated<TRow>) =>
        lastPage.nextCursor ?? undefined,
    }
  }

  const get = (id: string | number) => request<TRow>(`/${id}`)

  return {
    keys,
    list,
    get,
    create: (data: Partial<TCreate>) =>
      request<TRow>('', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string | number, data: TUpdate) =>
      request<TRow>(`/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string | number) =>
      request<void>(`/${id}`, { method: 'DELETE' }),
    listQuery: (params: ListParams = {}) => ({
      queryKey: keys.list(params),
      queryFn: () => list(params),
    }),
    listInfiniteQuery,
    getQuery: (id: string | number) => ({
      queryKey: keys.detail(id),
      queryFn: () => get(id),
    }),
  }
}

export type TableClient<
  TRow,
  TCreate = Partial<TRow>,
  TUpdate = Partial<TRow>,
> = ReturnType<typeof createTableClient<TRow, TCreate, TUpdate>>
