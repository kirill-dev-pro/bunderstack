export type AgentTask = { id: string; title: string; done: boolean }

export type ApprovalRequired = {
  status: 'approval_required'
  requestId: string
}

export interface AgentTools {
  listTasks(): Promise<AgentTask[]>
  createTask(input: { title: string }): Promise<AgentTask>
  completeTask(input: { taskId: string }): Promise<AgentTask>
  scheduleReminder(input: { title: string; dueAt: Date }): Promise<{
    id: string
    title: string
    dueAt: Date
  }>
  deleteTask(input: { taskId: string }): Promise<AgentTask | ApprovalRequired>
  remember(input: { key: string; value: string }): Promise<{
    key: string
    value: unknown
  }>
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
  tools: AgentTools
}

export type AgentResponder = (
  input: AgentResponderInput,
) => Promise<{ text: string }>
