export interface QueuedMessageState {
  clientMessageId: string
  content: string
  mode: 'after-current' | 'interrupt'
}

const activeStatuses = new Set([
  'queued',
  'running',
  'waiting_for_approval',
  'cancelling',
])

export function queueAction(
  message: QueuedMessageState,
  runStatus?: string,
):
  | { type: 'wait' }
  | { type: 'stop' }
  | { type: 'send'; message: QueuedMessageState } {
  if (!runStatus || !activeStatuses.has(runStatus)) {
    return { type: 'send', message }
  }
  if (message.mode === 'interrupt' && runStatus !== 'cancelling') {
    return { type: 'stop' }
  }
  return { type: 'wait' }
}
