// In-memory stand-ins for Worker bindings, so Durable Object classes and the
// Worker entry run under `bun test`. Not a full emulation: alarms fire only
// when a test calls `alarm()`.
import type {
  DurableObjectNamespaceLike,
  DurableObjectStateLike,
  R2BucketLike,
  R2ObjectLike,
} from '../workers/types'

export function createFakeState() {
  let alarm: number | null = null
  const state: DurableObjectStateLike & { alarmAt(): number | null } = {
    storage: {
      async getAlarm() {
        return alarm
      },
      async setAlarm(time) {
        alarm = typeof time === 'number' ? time : time.getTime()
      },
      async deleteAlarm() {
        alarm = null
      },
    },
    alarmAt: () => alarm,
  }
  return state
}

export function createFakeNamespace<
  T extends { fetch(request: Request): Promise<Response> },
>(make: (state: DurableObjectStateLike, name: string) => T) {
  const instances = new Map<
    string,
    { object: T; state: ReturnType<typeof createFakeState> }
  >()
  const entry = (name: string) => {
    let found = instances.get(name)
    if (!found) {
      const state = createFakeState()
      found = { object: make(state, name), state }
      instances.set(name, found)
    }
    return found
  }
  const namespace: DurableObjectNamespaceLike & {
    instance(name: string): T
    state(name: string): ReturnType<typeof createFakeState>
  } = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (input, init) =>
        entry(String(id)).object.fetch(new Request(input, init)),
    }),
    instance: (name) => entry(name).object,
    state: (name) => entry(name).state,
  }
  return namespace
}

export function createFakeR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  const meta = (key: string): R2ObjectLike | null => {
    const found = objects.get(key)
    return found
      ? {
          key,
          size: found.bytes.byteLength,
          httpMetadata: { contentType: found.contentType },
        }
      : null
  }
  // Pages of two keys, so a cursor loop is exercised.
  const PAGE = 2
  const bucket: R2BucketLike & { objects: typeof objects } = {
    objects,
    async put(key, value, options) {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(await new Response(value).arrayBuffer())
      objects.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType,
      })
      return meta(key)
    },
    async get(key) {
      const found = objects.get(key)
      if (!found) return null
      return {
        ...meta(key)!,
        body: new Response(found.bytes as unknown as BodyInit).body!,
      }
    },
    async head(key) {
      return meta(key)
    },
    async delete(key) {
      objects.delete(key)
    },
    async list(options) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .sort()
      const start = options?.cursor ? Number(options.cursor) : 0
      const truncated = start + PAGE < keys.length
      return {
        objects: keys.slice(start, start + PAGE).map((key) => meta(key)!),
        truncated,
        cursor: truncated ? String(start + PAGE) : undefined,
      }
    },
  }
  return bucket
}
