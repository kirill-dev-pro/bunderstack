import type { z } from 'zod'

import type { AgentRuntimeContext } from './runtime'

export type ToolApprovalPolicy =
  | { mode: 'none' }
  | { mode: 'required'; remember: boolean }

export interface ToolExecutionContext {
  runtime: AgentRuntimeContext
  userId: string
  threadId: string
  runId: string
  trigger: { type: 'user' | 'system'; trusted: boolean; sourceId?: string }
}

export interface ToolDefinition<
  TId extends string = string,
  TInput = unknown,
  TOutput = unknown,
> {
  id: TId
  version: number
  description: string
  inputSchema: z.ZodType<TInput>
  approval: ToolApprovalPolicy
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>
}

export interface AgentEventDefinition {
  delivery: 'immediate' | 'next_turn' | 'silent'
  aggregate: 'latest' | 'collect' | 'count'
}

export interface AgentDefinition<
  TTools extends Record<string, ToolDefinition> = Record<
    string,
    ToolDefinition
  >,
> {
  instructions: (input: { now: Date }) => string
  tools: TTools
  events: Record<string, AgentEventDefinition>
  context: {
    conversation: { recent: number }
    inbox: { maxItems: number }
    memory: { maxItems: number }
  }
}

export function defineTool<
  const TId extends string,
  TInput,
  TOutput,
>(
  config: ToolDefinition<TId, TInput, TOutput>,
): ToolDefinition<TId, TInput, TOutput> {
  return config
}

export function defineAgent<
  const TTools extends Record<string, ToolDefinition<any, any, any>>,
>(config: AgentDefinition<TTools>): AgentDefinition<TTools> {
  return config
}
