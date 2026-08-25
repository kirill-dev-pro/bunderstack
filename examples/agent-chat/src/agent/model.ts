import { createOpenAI } from '@ai-sdk/openai'
import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'

import type { AgentResponder } from './types'

export function createDemoResponder(): AgentResponder {
  return async (input) => {
    const message = input.latestMessage.trim()

    if (
      input.reason === 'commitment.fired' &&
      message.startsWith('Reminder due: ')
    ) {
      return { text: `⏰ ${message.slice('Reminder due: '.length)}` }
    }

    const add = message.match(/^add\s+(.+)$/i)
    if (add) {
      const title = add[1]!.trim()
      await input.tools.createTask({ title })
      return { text: `Added “${title}”.` }
    }

    if (/^(list|show)(\s+my)?\s+tasks?$/i.test(message)) {
      const items = await input.tools.listTasks()
      if (items.length === 0) return { text: 'Your task list is empty.' }
      return {
        text: items
          .map((item) => `${item.done ? '✓' : '○'} ${item.title}`)
          .join('\n'),
      }
    }

    const complete = message.match(/^(complete|finish)\s+(.+)$/i)
    if (complete) {
      const query = complete[2]!.trim().toLocaleLowerCase()
      const match = input.tasks.find(
        (task) => !task.done && task.title.toLocaleLowerCase().includes(query),
      )
      if (!match)
        return {
          text: `I couldn’t find an open task matching “${complete[2]!.trim()}”.`,
        }
      await input.tools.completeTask({ taskId: match.id })
      return { text: `Completed “${match.title}”.` }
    }

    const reminder = message.match(
      /^remind me in\s+(\d+)\s+minutes?\s+to\s+(.+)$/i,
    )
    if (reminder) {
      const minutes = Number(reminder[1])
      const title = reminder[2]!.trim()
      const dueAt = new Date(input.now.getTime() + minutes * 60_000)
      await input.tools.scheduleReminder({ title, dueAt })
      return { text: `I’ll remind you to “${title}” in ${minutes} minutes.` }
    }

    return {
      text: [
        'This local demo understands:',
        '• Add book flights',
        '• List tasks',
        '• Complete book flights',
        '• Remind me in 15 minutes to check the oven',
      ].join('\n'),
    }
  }
}

export interface AIResponderOptions {
  apiKey?: string
  baseURL?: string
  model?: string
}

export function createAIResponder(options: AIResponderOptions = {}): AgentResponder {
  if (!options.apiKey?.trim()) {
    return createDemoResponder()
  }

  const provider = createOpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  })
  const model = provider.chat(options.model ?? 'Qwen3.8-27B')

  return async (input) => {
    const result = await generateText({
      model,
      system: [
        'You are a concise personal task agent.',
        `Current time is ${input.now.toISOString()}.`,
        'Use tools for every read or mutation; never claim an effect you did not perform.',
        'A system message beginning with "[System]: Reminder due:" means notify the user now.',
      ].join('\n'),
      messages: input.messages.map((message) => ({
        role: message.role === 'system' ? ('user' as const) : message.role,
        content:
          message.role === 'system'
            ? `[System]: ${message.content}`
            : message.content,
      })),
      tools: {
        list_tasks: tool({
          description: 'List tasks owned by the current user.',
          inputSchema: z.object({}),
          execute: () => input.tools.listTasks(),
        }),
        create_task: tool({
          description: 'Create a task for the current user.',
          inputSchema: z.object({ title: z.string().min(1) }),
          execute: ({ title }) => input.tools.createTask({ title }),
        }),
        complete_task: tool({
          description: 'Complete one of the current user’s tasks by id.',
          inputSchema: z.object({ taskId: z.string() }),
          execute: ({ taskId }) => input.tools.completeTask({ taskId }),
        }),
        schedule_reminder: tool({
          description: 'Schedule a future reminder for the current user.',
          inputSchema: z.object({
            title: z.string().min(1),
            dueAt: z.string().datetime(),
          }),
          execute: ({ title, dueAt }) =>
            input.tools.scheduleReminder({ title, dueAt: new Date(dueAt) }),
        }),
      },
      maxRetries: 3,
      stopWhen: stepCountIs(6),
    })

    return { text: result.text || 'Done.' }
  }
}

export const createOpenAIResponder = createAIResponder
