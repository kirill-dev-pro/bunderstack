import { describe, expect, test } from 'bun:test'

import { allowTool, evaluateToolPermission } from './policy'

const requiredTool = {
  id: 'deleteTask',
  version: 1,
  approval: { mode: 'required', remember: true } as const,
}

const base = {
  tool: requiredTool,
  args: { taskId: 'task_one', nested: { channel: 'email' } },
  userId: 'user_alice',
  threadId: 'athread_alice',
  grants: [],
  capabilities: [],
  now: new Date('2026-08-26T10:00:00.000Z'),
}

describe('tool policy', () => {
  test('allows tools whose declaration does not require approval', () => {
    expect(
      evaluateToolPermission({
        ...base,
        tool: {
          id: 'listTasks',
          version: 1,
          approval: { mode: 'none' },
        },
      }),
    ).toEqual({ decision: 'allow', authorizedBy: 'policy' })
  })

  test('requires approval without a matching grant or capability', () => {
    expect(evaluateToolPermission(base)).toEqual({
      decision: 'approval_required',
    })
  })

  test('accepts only an active unexpired grant for the same agent and tool version', () => {
    const matching = {
      id: 'agrant_one',
      userId: base.userId,
      threadId: base.threadId,
      tool: requiredTool.id,
      toolVersion: requiredTool.version,
      status: 'active' as const,
      expiresAt: new Date('2026-08-27T10:00:00.000Z'),
    }
    expect(
      evaluateToolPermission({ ...base, grants: [matching] }),
    ).toEqual({
      decision: 'allow',
      authorizedBy: 'grant',
      grantId: matching.id,
    })

    for (const changed of [
      { ...matching, status: 'revoked' as const },
      { ...matching, status: 'expired' as const },
      { ...matching, expiresAt: new Date('2026-08-26T09:59:59.000Z') },
      { ...matching, userId: 'user_bob' },
      { ...matching, threadId: 'athread_bob' },
      { ...matching, toolVersion: 2 },
    ]) {
      expect(
        evaluateToolPermission({ ...base, grants: [changed] }).decision,
      ).toBe('approval_required')
    }
  })

  test('an exact event capability cannot be widened by changing nested arguments', () => {
    const capability = allowTool(requiredTool, base.args)
    expect(
      evaluateToolPermission({ ...base, capabilities: [capability] }),
    ).toEqual({ decision: 'allow', authorizedBy: 'capability' })

    for (const args of [
      { ...base.args, taskId: 'task_two' },
      { ...base.args, nested: { channel: 'social' } },
      { ...base.args, nested: { ...base.args.nested, extra: true } },
    ]) {
      expect(
        evaluateToolPermission({
          ...base,
          args,
          capabilities: [capability],
        }).decision,
      ).toBe('approval_required')
    }
  })
})
