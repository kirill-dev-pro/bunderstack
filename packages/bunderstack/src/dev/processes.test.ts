import { expect, test } from 'bun:test'

import { ProcessGroup, prefixLines } from './processes'

test('prefixLines keeps a partial line for the next chunk', () => {
  const first = prefixLines('one\ntw', '')
  expect(first).toEqual({ lines: ['one'], pending: 'tw' })
  const second = prefixLines('o\n', first.pending)
  expect(second).toEqual({ lines: ['two'], pending: '' })
})

test('children log with a prefix, and exited names the first to end', async () => {
  const lines: string[] = []
  const group = new ProcessGroup((line) => lines.push(line))
  group.start({
    name: 'quick',
    cmd: [process.execPath, '-e', 'console.log("hello")'],
    cwd: import.meta.dir,
  })
  group.start({
    name: 'slow',
    cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
    cwd: import.meta.dir,
  })
  const exited = await group.exited
  expect(exited).toEqual({ name: 'quick', code: 0 })
  await group.stop()
  expect(lines.some((line) => /\[quick\]\s+hello/.test(line))).toBe(true)
})

test('stop ends running children', async () => {
  const group = new ProcessGroup(() => {})
  group.start({
    name: 'sleeper',
    cmd: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
    cwd: import.meta.dir,
  })
  const started = Date.now()
  await group.stop()
  expect(Date.now() - started).toBeLessThan(3_000)
})
