import { and, eq } from 'drizzle-orm'

import type { AgentRuntimeContext } from './runtime'

import { agentMemory } from '../schema'

export interface MemorySource {
  type: 'user' | 'system' | 'derived'
  trusted: boolean
  id?: string
}

export async function remember(
  ctx: AgentRuntimeContext,
  input: {
    userId: string
    kind: 'preference' | 'fact' | 'summary'
    key: string
    value: unknown
    source: MemorySource
  },
) {
  if (!input.source.trusted) throw new Error('Trusted source required')
  const key = input.key.trim()
  if (!key) throw new Error('Memory key is required')
  const now = new Date()
  const [row] = await ctx.db
    .insert(agentMemory)
    .values({
      userId: input.userId,
      kind: input.kind,
      key,
      value: input.value,
      sourceType: input.source.type,
      sourceId: input.source.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [agentMemory.userId, agentMemory.key],
      set: {
        kind: input.kind,
        value: input.value,
        sourceType: input.source.type,
        sourceId: input.source.id ?? null,
        updatedAt: now,
      },
    })
    .returning()
  await ctx.realtime.publish(agentMemory, 'update', row)
  return row!
}

export async function updateMemory(
  ctx: AgentRuntimeContext,
  input: { id: string; userId: string; value: unknown },
) {
  const [row] = await ctx.db
    .update(agentMemory)
    .set({
      value: input.value,
      sourceType: 'user',
      sourceId: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentMemory.id, input.id), eq(agentMemory.userId, input.userId)),
    )
    .returning()
  if (!row) return null
  await ctx.realtime.publish(agentMemory, 'update', row)
  return row
}

export async function deleteMemory(
  ctx: AgentRuntimeContext,
  input: { id: string; userId: string },
): Promise<boolean> {
  const [row] = await ctx.db
    .delete(agentMemory)
    .where(
      and(eq(agentMemory.id, input.id), eq(agentMemory.userId, input.userId)),
    )
    .returning()
  if (!row) return false
  await ctx.realtime.publish(agentMemory, 'delete', row)
  return true
}
