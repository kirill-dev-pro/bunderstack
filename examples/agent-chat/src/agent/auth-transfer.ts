import { eq } from 'drizzle-orm'

import {
  agentCommitments,
  agentInbox,
  agentMemory,
  agentMessages,
  agentRequests,
  agentRunSteps,
  agentRuns,
  agentThreads,
  agentToolCalls,
  agentToolGrants,
  tasks,
} from '../schema'

export async function transferAnonymousAgentData(
  db: any,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  if (fromUserId === toUserId) return

  await db.transaction(async (tx: any) => {
    const destinationThread = await tx
      .select({ id: agentThreads.id })
      .from(agentThreads)
      .where(eq(agentThreads.userId, toUserId))
      .get()
    if (destinationThread) {
      throw new Error('The permanent account already has an agent')
    }

    await tx
      .update(agentMessages)
      .set({ userId: toUserId })
      .where(eq(agentMessages.userId, fromUserId))
    await tx
      .update(agentRuns)
      .set({ userId: toUserId })
      .where(eq(agentRuns.userId, fromUserId))
    await tx
      .update(agentRunSteps)
      .set({ userId: toUserId })
      .where(eq(agentRunSteps.userId, fromUserId))
    await tx
      .update(agentToolCalls)
      .set({ userId: toUserId })
      .where(eq(agentToolCalls.userId, fromUserId))
    await tx
      .update(agentCommitments)
      .set({ userId: toUserId })
      .where(eq(agentCommitments.userId, fromUserId))
    await tx
      .update(tasks)
      .set({ userId: toUserId })
      .where(eq(tasks.userId, fromUserId))
    await tx
      .update(agentMemory)
      .set({ userId: toUserId })
      .where(eq(agentMemory.userId, fromUserId))
    await tx
      .update(agentInbox)
      .set({ userId: toUserId })
      .where(eq(agentInbox.userId, fromUserId))
    await tx
      .update(agentRequests)
      .set({ userId: toUserId })
      .where(eq(agentRequests.userId, fromUserId))
    await tx
      .update(agentToolGrants)
      .set({ userId: toUserId })
      .where(eq(agentToolGrants.userId, fromUserId))
    await tx
      .update(agentThreads)
      .set({ userId: toUserId })
      .where(eq(agentThreads.userId, fromUserId))
  })
}
