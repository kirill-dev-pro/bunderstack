export type AgentTask = { id: string; title: string; done: boolean }

export interface AgentTools {
  listTasks(): Promise<AgentTask[]>
  createTask(input: { title: string }): Promise<AgentTask>
  completeTask(input: { taskId: string }): Promise<AgentTask>
  scheduleReminder(input: { title: string; dueAt: Date }): Promise<{
    id: string
    title: string
    dueAt: Date
  }>
}

export interface AgentResponderInput {
  reason: string
  now: Date
  latestMessage: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  tasks: AgentTask[]
  tools: AgentTools
}

export type AgentResponder = (
  input: AgentResponderInput,
) => Promise<{ text: string }>
