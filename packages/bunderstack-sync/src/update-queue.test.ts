import { describe, it, expect } from 'bun:test'

import { createUpdateQueue } from './update-queue'

type Row = { id: string; x?: number; y?: number }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let every already-resolved promise callback run. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A queue whose requests only settle when the test says so, so ordering is
 * asserted directly instead of being raced against timers. */
function gatedQueue() {
  const sent: { key: string; changes: Record<string, unknown> }[] = []
  const gates: ReturnType<typeof deferred<Row>>[] = []
  const applied: Row[] = []
  const queue = createUpdateQueue<string, Row>({
    send: (key, changes) => {
      sent.push({ key, changes })
      const gate = deferred<Row>()
      gates.push(gate)
      return gate.promise
    },
    onResult: (row) => {
      applied.push(row)
    },
  })
  return { queue, sent, gates, applied }
}

describe('createUpdateQueue', () => {
  it('sends the first update immediately', async () => {
    const { queue, sent, gates, applied } = gatedQueue()

    const first = queue.enqueue('p1', { x: 1 })
    await tick()

    expect(sent).toEqual([{ key: 'p1', changes: { x: 1 } }])

    gates[0]!.resolve({ id: 'p1', x: 1 })
    await first

    expect(applied).toEqual([{ id: 'p1', x: 1 }])
  })

  it('merges updates that arrive mid-flight into one follow-up request', async () => {
    const { queue, sent, gates } = gatedQueue()

    const first = queue.enqueue('p1', { x: 1 })
    await tick()
    const second = queue.enqueue('p1', { x: 2 })
    const third = queue.enqueue('p1', { x: 3, y: 9 })
    await tick()

    expect(sent.length).toBe(1)

    gates[0]!.resolve({ id: 'p1', x: 1 })
    await first
    await tick()

    // Later value wins per field; the untouched field rides along.
    expect(sent.length).toBe(2)
    expect(sent[1]).toEqual({ key: 'p1', changes: { x: 3, y: 9 } })

    gates[1]!.resolve({ id: 'p1', x: 3, y: 9 })
    await Promise.all([second, third])
  })

  it('keeps separate keys in separate flights', async () => {
    const { queue, sent, gates } = gatedQueue()

    const a = queue.enqueue('p1', { x: 1 })
    const b = queue.enqueue('p2', { x: 2 })
    await tick()

    expect(sent).toEqual([
      { key: 'p1', changes: { x: 1 } },
      { key: 'p2', changes: { x: 2 } },
    ])

    gates[0]!.resolve({ id: 'p1', x: 1 })
    gates[1]!.resolve({ id: 'p2', x: 2 })
    await Promise.all([a, b])
  })

  it('resolves a waiter only once a request carrying its changes completes', async () => {
    const { queue, gates } = gatedQueue()

    const first = queue.enqueue('p1', { x: 1 })
    await tick()
    const second = queue.enqueue('p1', { x: 2 })
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })

    gates[0]!.resolve({ id: 'p1', x: 1 })
    await first
    await tick()

    // The second update only went out in request 2, which is still in flight —
    // resolving here would let TanStack DB drop optimistic state too early.
    expect(secondSettled).toBe(false)

    gates[1]!.resolve({ id: 'p1', x: 2 })
    await second

    expect(secondSettled).toBe(true)
  })

  it('rejects the in-flight batch and the queued changes when a request fails', async () => {
    const { queue, sent, gates } = gatedQueue()

    const first = queue.enqueue('p1', { x: 1 })
    await tick()
    const second = queue.enqueue('p1', { x: 2 })

    // allSettled attaches handlers synchronously, matching how `onUpdate`
    // awaits its promise the moment it gets one.
    const settled = Promise.allSettled([first, second])
    gates[0]!.reject(new Error('boom'))

    expect(await settled).toMatchObject([
      { status: 'rejected', reason: { message: 'boom' } },
      { status: 'rejected', reason: { message: 'boom' } },
    ])
    await tick()

    // Queued changes are dropped rather than replayed on top of a failed base.
    expect(sent.length).toBe(1)
  })

  it('starts a fresh flight after a failure', async () => {
    const { queue, sent, gates } = gatedQueue()

    const first = queue.enqueue('p1', { x: 1 })
    await tick()
    gates[0]!.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await tick()

    const second = queue.enqueue('p1', { x: 5 })
    await tick()

    expect(sent.length).toBe(2)
    expect(sent[1]).toEqual({ key: 'p1', changes: { x: 5 } })

    gates[1]!.resolve({ id: 'p1', x: 5 })
    await second
  })

  it('settle discards queued changes and waits for the in-flight request', async () => {
    const { queue, sent, gates } = gatedQueue()

    const first = queue.enqueue('p1', { x: 1 })
    await tick()
    const second = queue.enqueue('p1', { x: 2 })

    let settled = false
    const done = queue.settle('p1').then(() => {
      settled = true
    })

    // Superseded by whatever the caller does next (a delete), so its waiter
    // resolves rather than hanging or rolling back.
    await second
    await tick()

    expect(settled).toBe(false)
    expect(sent.length).toBe(1)

    gates[0]!.resolve({ id: 'p1', x: 1 })
    await done
    // The in-flight batch settles normally — settle discards what is queued,
    // it does not cancel what already went out.
    await first

    expect(settled).toBe(true)
    expect(sent.length).toBe(1)
  })

  it('settle resolves immediately for a key with no work', async () => {
    const { queue, sent } = gatedQueue()

    await queue.settle('p1')

    expect(sent.length).toBe(0)
  })
})
