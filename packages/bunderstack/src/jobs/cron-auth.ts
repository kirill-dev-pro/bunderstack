import { createHmac, timingSafeEqual } from 'node:crypto'

function canonical(taskId: string, slot: number): string {
  return `${taskId}\n${slot}`
}

export function signScheduleRequest(
  secret: string,
  taskId: string,
  slot: number,
): string {
  const digest = createHmac('sha256', secret)
    .update(canonical(taskId, slot))
    .digest('hex')
  return `sha256=${digest}`
}

export function verifyScheduleRequest(
  secret: string,
  taskId: string,
  slot: number,
  signature: string,
): boolean {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false
  const expected = Buffer.from(signScheduleRequest(secret, taskId, slot))
  const received = Buffer.from(signature)
  return timingSafeEqual(expected, received)
}
