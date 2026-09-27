// src/workers/types.ts — the small part of the Workers API that bunderstack
// uses. Local interfaces keep `cloudflare:workers` and its type package out of
// the core, so the same classes run under `bun test` with in-memory fakes.
export interface DurableObjectStorageLike {
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike
}

export interface FetcherLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): FetcherLike
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
}

export interface R2ObjectLike {
  key: string
  size: number
  httpMetadata?: { contentType?: string }
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream
}

export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
  get(key: string): Promise<R2ObjectBodyLike | null>
  head(key: string): Promise<R2ObjectLike | null>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    objects: R2ObjectLike[]
    truncated: boolean
    cursor?: string
  }>
}

export type WorkerEnv = {
  SCHEDULER?: DurableObjectNamespaceLike
  REALTIME?: DurableObjectNamespaceLike
  RATE_LIMITER?: DurableObjectNamespaceLike
  ASSETS?: FetcherLike
  [binding: string]: unknown
}

export function stub(
  namespace: DurableObjectNamespaceLike,
  name: string,
): FetcherLike {
  return namespace.get(namespace.idFromName(name))
}
