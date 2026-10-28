import { expect, test } from 'bun:test'

import { BUNDERSTACK_VERSION } from './version'

test('the version constant matches package.json', async () => {
  const pkg = (await Bun.file(
    new URL('../package.json', import.meta.url),
  ).json()) as {
    version: string
  }
  expect(BUNDERSTACK_VERSION).toBe(pkg.version)
})
