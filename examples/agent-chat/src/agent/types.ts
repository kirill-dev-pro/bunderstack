import type { ModelMessage } from 'ai'

import type { CommitmentExecutionSpec, CommitmentSchedule } from '../schema'

export type AgentTask = { id: string; title: string; done: boolean }

export type ApprovalRequired = {
  status: 'approval_required'
  requestId: string
}

export interface AgentTools {
  listTasks(): Promise<AgentTask[]>
  createTask(input: { title: string }): Promise<AgentTask>
  completeTask(input: { taskId: string }): Promise<AgentTask>
  createCommitment(input: {
    title: string
    dueAt?: string
    schedule?: CommitmentSchedule
    execution: CommitmentExecutionSpec
    dependsOn?: string[]
  }): Promise<unknown>
  listCommitments(input?: { status?: string }): Promise<unknown[]>
  cancelCommitment(input: { commitmentId: string }): Promise<unknown>
  pauseCommitment(input: { commitmentId: string }): Promise<unknown>
  resumeCommitment(input: { commitmentId: string }): Promise<unknown>
  retryCommitment(input: { commitmentId: string }): Promise<unknown>
  deleteTask(input: { taskId: string }): Promise<AgentTask | ApprovalRequired>
  remember(input: { key: string; value: string }): Promise<{
    key: string
    value: unknown
  }>
}

export interface AgentResponderStream {
  signal: AbortSignal
  writeTextDelta(delta: string): Promise<void>
  writeStatus(title: string): Promise<void>
}

export function createNoopAgentStream(): AgentResponderStream {
  return {
    signal: new AbortController().signal,
    writeTextDelta: async () => {},
    writeStatus: async () => {},
  }
}

export interface AgentResponderInput {
  reason: string
  now: Date
  instructions: string
  trigger: {
    type: 'user' | 'system'
    trusted: boolean
    reason: string
  }
  currentExecution: {
    trigger: 'user_message' | 'system_event' | 'commitment'
    runId: string
    commitmentId?: string
    objective: string
    executionSpec?: CommitmentExecutionSpec
  }
  latestMessage: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  tasks: AgentTask[]
  memory: Array<{
    id: string
    kind: 'preference' | 'fact' | 'summary'
    key: string
    value: unknown
    sourceType: 'user' | 'system' | 'derived'
  }>
  inbox: Array<{
    type: string
    delivery: 'immediate' | 'next_turn'
    aggregate: 'latest' | 'collect' | 'count'
    payload: unknown
  }>
  activeCommitments: Array<{
    id: string
    title: string
    status: string
    dueAt: Date
    executionSpec: CommitmentExecutionSpec | null
  }>
  checkpoint?: AgentCheckpoint
  approvalResponse?: {
    approvalId: string
    approved: boolean
    reason?: string
  }
  stream: AgentResponderStream
  toolApprovalRequired(toolId: string, args: unknown): Promise<boolean>
  tools: AgentTools
}

export interface AgentCheckpoint {
  messages: ModelMessage[]
  toolSequence?: number
  executionKey?: string
}

export type AgentResponderResult =
  | {
      status: 'completed'
      text: string
      checkpoint: AgentCheckpoint
    }
  | { status: 'blocked'; reason: string; checkpoint: AgentCheckpoint }
  | { status: 'failed'; error: string; checkpoint: AgentCheckpoint }
  | {
      status: 'waiting_for_approval'
      request: {
        approvalId: string
        toolCallId: string
        tool: string
        args: Record<string, unknown>
      }
      checkpoint: AgentCheckpoint
    }

export type AgentResponder = (
  input: AgentResponderInput,
) => Promise<AgentResponderResult>
