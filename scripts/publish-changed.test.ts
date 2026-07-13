import { test, expect, describe } from 'bun:test'

import { shouldPublish, rewriteWorkspaceDeps } from './publish-changed'

describe('shouldPublish', () => {
  test('publishes when local is ahead of registry', () => {
    expect(shouldPublish('0.2.0', '0.1.0')).toBe(true)
    expect(shouldPublish('0.1.1', '0.1.0')).toBe(true)
    expect(shouldPublish('1.0.0', '0.9.9')).toBe(true)
  })

  test('skips when versions are equal', () => {
    expect(shouldPublish('0.1.0', '0.1.0')).toBe(false)
  })

  test('skips when registry is ahead of local', () => {
    expect(shouldPublish('0.1.0', '0.2.0')).toBe(false)
  })
})

describe('rewriteWorkspaceDeps', () => {
  test('rewrites workspace:* to caret version of the sibling', () => {
    const pkg = {
      name: 'bunderstack-sync',
      version: '0.1.0',
      dependencies: {
        bunderstack: 'workspace:*',
        'bunderstack-query': 'workspace:*',
        superjson: '^2.2.0',
      },
    }
    const rewritten = rewriteWorkspaceDeps(pkg, {
      bunderstack: '0.3.0',
      'bunderstack-query': '0.2.1',
    })
    expect(rewritten.dependencies).toEqual({
      bunderstack: '^0.3.0',
      'bunderstack-query': '^0.2.1',
      superjson: '^2.2.0',
    })
  })

  test('preserves workspace range operators ~ and ^', () => {
    const pkg = {
      name: 'x',
      version: '1.0.0',
      dependencies: { bunderstack: 'workspace:~' },
      devDependencies: { 'bunderstack-query': 'workspace:^' },
    }
    const rewritten = rewriteWorkspaceDeps(pkg, {
      bunderstack: '0.3.0',
      'bunderstack-query': '0.2.1',
    })
    expect(rewritten.dependencies?.bunderstack).toBe('~0.3.0')
    expect(rewritten.devDependencies?.['bunderstack-query']).toBe('^0.2.1')
  })

  test('does not mutate the input object', () => {
    const pkg = {
      name: 'x',
      version: '1.0.0',
      dependencies: { bunderstack: 'workspace:*' },
    }
    rewriteWorkspaceDeps(pkg, { bunderstack: '0.3.0' })
    expect(pkg.dependencies.bunderstack).toBe('workspace:*')
  })

  test('throws when a workspace dep has no known local version', () => {
    const pkg = {
      name: 'x',
      version: '1.0.0',
      dependencies: { unknown: 'workspace:*' },
    }
    expect(() => rewriteWorkspaceDeps(pkg, {})).toThrow(/unknown/)
  })

  test('leaves packages without workspace deps untouched', () => {
    const pkg = {
      name: 'bunderstack',
      version: '0.1.0',
      dependencies: { hono: '^4.0.0' },
      peerDependencies: { typescript: '^5' },
    }
    const rewritten = rewriteWorkspaceDeps(pkg, {})
    expect(rewritten).toEqual(pkg)
  })
})
