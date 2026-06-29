import { test, expect } from 'bun:test'

import { shouldProvision } from './provision'

test('shouldProvision auto skips production', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  expect(shouldProvision('auto')).toBe(false)
  process.env.NODE_ENV = prev
})

test('shouldProvision auto runs in development', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  expect(shouldProvision('auto')).toBe(true)
  process.env.NODE_ENV = prev
})

test('shouldProvision force overrides mode', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  expect(shouldProvision('auto', true)).toBe(true)
  process.env.NODE_ENV = prev
})

test('shouldProvision explicit false', () => {
  expect(shouldProvision(false)).toBe(false)
})

test('shouldProvision explicit true', () => {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  expect(shouldProvision(true)).toBe(true)
  process.env.NODE_ENV = prev
})
