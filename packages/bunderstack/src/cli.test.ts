import { test, expect } from 'bun:test'

import { runCli } from './cli'

test('blueprint CLI reports generated and current artifacts', async () => {
  const output: string[] = []
  const errors: string[] = []
  const generate = async (options: { check?: boolean }) => ({
    path: '/tmp/bunderstack.blueprint.yaml',
    blueprint: {} as never,
    source: '',
    changed: !options.check,
  })
  expect(
    await runCli(['blueprint'], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) }, generate as never),
  ).toBe(0)
  expect(output).toEqual(['Generated bunderstack.blueprint.yaml'])
  output.length = 0
  expect(
    await runCli(['blueprint', '--check'], { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) }, generate as never),
  ).toBe(0)
  expect(output).toEqual(['bunderstack.blueprint.yaml is current'])
  expect(errors).toEqual([])
})

test('blueprint CLI rejects invalid syntax', async () => {
  const errors: string[] = []
  expect(await runCli(['blueprint', '--entry'], { stdout: () => {}, stderr: (line) => errors.push(line) })).toBe(2)
  expect(errors[0]).toContain('missing value for --entry')
})
