import { isDeepStrictEqual } from 'node:util'

import type { ToolApprovalPolicy } from './declaration'

export interface ToolPolicyTarget {
  id: string
  version: number
  approval: ToolApprovalPolicy
}

export interface ToolGrant {
  id: string
  userId: string
  threadId: string
  tool: string
  toolVersion: number
  status: 'active' | 'revoked' | 'expired'
  expiresAt: Date | null
}

export interface ToolCapability {
  tool: string
  toolVersion: number
  args: unknown
}

export type ToolPermissionDecision =
  | { decision: 'allow'; authorizedBy: 'policy' | 'capability' }
  | { decision: 'allow'; authorizedBy: 'grant'; grantId: string }
  | { decision: 'approval_required' }
  | { decision: 'deny'; reason: string }

export function allowTool(
  tool: Pick<ToolPolicyTarget, 'id' | 'version'>,
  args: unknown,
): ToolCapability {
  return { tool: tool.id, toolVersion: tool.version, args }
}

export function evaluateToolPermission(input: {
  tool: ToolPolicyTarget
  args: unknown
  userId: string
  threadId: string
  grants: ToolGrant[]
  capabilities: ToolCapability[]
  now?: Date
}): ToolPermissionDecision {
  if (input.tool.approval.mode === 'none') {
    return { decision: 'allow', authorizedBy: 'policy' }
  }

  const now = input.now ?? new Date()
  const grant = input.grants.find(
    (candidate) =>
      candidate.status === 'active' &&
      candidate.userId === input.userId &&
      candidate.threadId === input.threadId &&
      candidate.tool === input.tool.id &&
      candidate.toolVersion === input.tool.version &&
      (!candidate.expiresAt || candidate.expiresAt > now),
  )
  if (grant) {
    return {
      decision: 'allow',
      authorizedBy: 'grant',
      grantId: grant.id,
    }
  }

  const capability = input.capabilities.some(
    (candidate) =>
      candidate.tool === input.tool.id &&
      candidate.toolVersion === input.tool.version &&
      isDeepStrictEqual(candidate.args, input.args),
  )
  if (capability) {
    return { decision: 'allow', authorizedBy: 'capability' }
  }

  return { decision: 'approval_required' }
}
