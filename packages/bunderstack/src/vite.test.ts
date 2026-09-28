import { afterEach, expect, test } from 'bun:test'

import { bunderstack } from './vite'

const saved = process.env.BUNDERSTACK_DEV_API_URL
afterEach(() => {
  if (saved === undefined) delete process.env.BUNDERSTACK_DEV_API_URL
  else process.env.BUNDERSTACK_DEV_API_URL = saved
})

test('builds the SPA into dist/client', () => {
  delete process.env.BUNDERSTACK_DEV_API_URL
  const config = bunderstack().config()
  expect(config.build.outDir).toBe('dist/client')
  expect(config.server).toBeUndefined()
})

test('proxies /api to the dev Worker and keeps the browser origin', () => {
  process.env.BUNDERSTACK_DEV_API_URL = 'http://127.0.0.1:9876'
  const config = bunderstack().config()
  expect(config.server?.proxy).toEqual({
    '/api': { target: 'http://127.0.0.1:9876', changeOrigin: false },
  })
})

test('proxies a custom API prefix', () => {
  process.env.BUNDERSTACK_DEV_API_URL = 'http://127.0.0.1:9876'
  const config = bunderstack({ apiPrefix: '/backend' }).config()
  expect(Object.keys(config.server?.proxy ?? {})).toEqual(['/backend'])
})
