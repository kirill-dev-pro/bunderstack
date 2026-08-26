import { createOpenAI } from '@ai-sdk/openai'
import { dynamicTool, generateText, stepCountIs } from 'ai'

import { agentDefinition } from './definition'
import type { AgentResponder, AgentResponderInput, AgentTools } from './types'

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

    const remove = message.match(/^(delete|remove)\s+(.+)$/i)
    if (remove) {
      const query = remove[2]!.trim().toLocaleLowerCase()
      const match = input.tasks.find((task) =>
        task.title.toLocaleLowerCase().includes(query),
      )
      if (!match) {
        return {
          text: `I couldn’t find a task matching “${remove[2]!.trim()}”.`,
        }
      }
      const result = await input.tools.deleteTask({ taskId: match.id })
      if ('status' in result && result.status === 'approval_required') {
        return { text: `Please approve deleting “${match.title}”.` }
      }
      return { text: `Deleted “${match.title}”.` }
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
        '• Delete book flights',
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

export function createModelTools(input: AgentResponderInput) {
  return Object.fromEntries(
    Object.values(agentDefinition.tools).map((definition) => {
      const execute = input.tools[
        definition.id as keyof AgentTools
      ] as (args: unknown) => Promise<unknown>
      return [
        definition.id,
        dynamicTool({
          description: definition.description,
          inputSchema: definition.inputSchema,
          execute: (args) => execute(args),
        }),
      ]
    }),
  )
}

export function createAIResponder(
  options: AIResponderOptions = {},
): AgentResponder {
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
        agentDefinition.instructions({ now: input.now }),
        'A system message beginning with "[System]: Reminder due:" means notify the user now.',
      ].join('\n'),
      messages: input.messages.map((message) => ({
        role: message.role === 'system' ? ('user' as const) : message.role,
        content:
          message.role === 'system'
            ? `[System]: ${message.content}`
            : message.content,
      })),
      tools: createModelTools(input),
      maxRetries: 3,
      stopWhen: stepCountIs(6),
    })

    return { text: result.text || 'Done.' }
  }
}

export const createOpenAIResponder = createAIResponder
