import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertHostedBlueprintFile } from './hosted-contract'

test('a missing hosted blueprint file fails with its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-hosted-'))
  try {
    const path = join(dir, 'missing.yaml')
    await expect(assertHostedBlueprintFile({} as never, path)).rejects.toThrow(
      `hosted blueprint does not exist: ${path}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an existing hosted blueprint file is read and parsed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-hosted-'))
  try {
    const path = join(dir, 'broken.yaml')
    await writeFile(path, 'not: [a blueprint')
    // Reaching the parser proves the file was read; the content is invalid.
    await expect(
      assertHostedBlueprintFile({} as never, path),
    ).rejects.not.toThrow('hosted blueprint does not exist')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
