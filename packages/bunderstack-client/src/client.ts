import { OPERATION_ID_HEADER, type CallOptions, type Fetch } from './rpc-client'

export type RouteOperation<
  TMethod extends string,
  TPath extends string,
  TQuery = undefined,
  TBody = undefined,
  TOutput = undefined,
  TStream extends boolean = false,
> = {
  method: TMethod
  path: TPath
  query?: TQuery
  body?: TBody
  output?: TOutput
  stream?: TStream
}

type AnyOperation = {
  method: string
  path: string
  query?: unknown
  body?: unknown
  output?: unknown
  stream?: boolean
}

type QueryOf<O extends AnyOperation> = NonNullable<O['query']>
type BodyOf<O extends AnyOperation> = NonNullable<O['body']>
type OutputOf<O extends AnyOperation> = NonNullable<O['output']>

export type RouteCallOptions = CallOptions

type PathParamNames<TPath extends string> =
  TPath extends `${string}{${infer TParam}}${infer TRest}`
    ? TParam extends `+${infer TName}`
      ? TName | PathParamNames<TRest>
      : TParam | PathParamNames<TRest>
    : never

type PathArgs<O extends AnyOperation> = [PathParamNames<O['path']>] extends [
  never,
]
  ? object
  : { params: Record<PathParamNames<O['path']>, string> }

type QueryArgs<O extends AnyOperation> = [O['query']] extends [undefined]
  ? object
  : { query?: QueryOf<O> }

type BodyArgs<O extends AnyOperation> = [O['body']] extends [undefined]
  ? object
  : { body: BodyOf<O> }

type CallArgs<O extends AnyOperation> = PathArgs<O> & QueryArgs<O> & BodyArgs<O>

type HasRequiredArgs<O extends AnyOperation> = [
  PathParamNames<O['path']>,
] extends [never]
  ? [O['body']] extends [undefined]
    ? false
    : true
  : true

export type RouteMethod<O extends AnyOperation> = (
  ...args: true extends HasRequiredArgs<O>
    ? [args: CallArgs<O>, options?: RouteCallOptions]
    : [args?: CallArgs<O>, options?: RouteCallOptions]
) => true extends O['stream']
  ? AsyncIterable<OutputOf<O>>
  : Promise<OutputOf<O>>

export type ClientOf<TRoutes> = {
  [K in keyof TRoutes]: TRoutes[K] extends AnyOperation
    ? RouteMethod<TRoutes[K]>
    : never
}

export type RestClientOptions = {
  baseUrl?: string
  fetch?: Fetch
}

type RouteDescriptor = { method: string; path: string; stream?: boolean }

function joinUrl(baseUrl: string | undefined, path: string): string {
  if (!baseUrl) return path
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function fillPath(
  path: string,
  params: Record<string, string> | undefined,
): string {
  return path.replace(/\{(\+?)([^}]+)\}/g, (_, catchAll, name: string) => {
    const value = params?.[name]
    if (value === undefined) throw new Error(`Missing path parameter: ${name}`)
    if (catchAll) return value.split('/').map(encodeURIComponent).join('/')
    return encodeURIComponent(value)
  })
}

function buildUrl(
  baseUrl: string | undefined,
  path: string,
  query: Record<string, unknown> | undefined,
): string {
  const url = joinUrl(baseUrl, path)
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return params.size ? `${url}?${params}` : url
}

async function requestJson(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, init)
  if (!response.ok)
    throw new Error(`${response.status} ${await response.text()}`)
  if (response.status === 204) return undefined
  return response.json()
}

async function* streamJsonEvents(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
): AsyncGenerator<unknown> {
  const response = await fetcher(url, init)
  if (!response.ok || !response.body) {
    throw new Error(`Stream request failed (${response.status})`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let data: string[] = []
  const flush = () => {
    if (!data.length) return undefined
    const value = JSON.parse(data.join('\n')) as unknown
    data = []
    return value
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const event = flush()
          if (event !== undefined) yield event
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
        newline = buffer.indexOf('\n')
      }
    }
    const event = flush()
    if (event !== undefined) yield event
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function createRestClient<TRoutes>(
  routes: Record<string, RouteDescriptor>,
  options: RestClientOptions = {},
): ClientOf<TRoutes> {
  const fetcher = options.fetch ?? globalThis.fetch
  const client: Record<string, unknown> = {}
  for (const [name, route] of Object.entries(routes)) {
    client[name] = (
      args: {
        params?: Record<string, string>
        query?: Record<string, unknown>
        body?: unknown
      } = {},
      callOptions: RouteCallOptions = {},
    ) => {
      const path = fillPath(route.path, args.params)
      const url = buildUrl(options.baseUrl, path, args.query)
      const headers = new Headers(callOptions.headers)
      if (callOptions.operationId)
        headers.set(OPERATION_ID_HEADER, callOptions.operationId)
      if (route.stream) {
        headers.set('accept', 'text/event-stream')
        return streamJsonEvents(fetcher, url, {
          method: route.method,
          signal: callOptions.signal,
          headers,
        })
      }
      if (args.body !== undefined)
        headers.set('content-type', 'application/json')
      return requestJson(fetcher, url, {
        method: route.method,
        signal: callOptions.signal,
        headers,
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      })
    }
  }
  return client as ClientOf<TRoutes>
}
