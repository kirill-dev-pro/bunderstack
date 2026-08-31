import {
  createAIResponder,
  type AIResponderOptions,
} from './model'
import {
  createIQDocResponder,
  type IQDocResponderOptions,
} from './iqdoc'
import type { AgentResponder } from './types'

export type AgentProvider = 'openai' | 'iqdoc'

export interface ConfiguredResponderOptions {
  provider?: AgentProvider
  openai?: AIResponderOptions
  iqdoc?: IQDocResponderOptions
}

export interface AgentProviderEnv {
  AI_PROVIDER?: AgentProvider
  AI_API_KEY?: string
  AI_BASE_URL?: string
  AI_MODEL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  IQDOC_API_KEY?: string
  IQDOC_BASE_URL?: string
  IQDOC_MODEL?: string
}

export function responderOptionsFromEnv(
  env: AgentProviderEnv,
): ConfiguredResponderOptions {
  const openAIKey = nonEmpty(env.OPENAI_API_KEY)
  return {
    provider: env.AI_PROVIDER ?? 'openai',
    openai: {
      apiKey: openAIKey ?? env.AI_API_KEY,
      baseURL: openAIKey ? undefined : env.AI_BASE_URL,
      model: openAIKey
        ? (env.OPENAI_MODEL ?? 'gpt-5-mini')
        : env.AI_MODEL,
    },
    iqdoc: {
      apiKey: env.IQDOC_API_KEY,
      baseURL: env.IQDOC_BASE_URL,
      model: env.IQDOC_MODEL ?? 'assistant_auto',
    },
  }
}

export function createConfiguredResponder(
  options: ConfiguredResponderOptions = {},
): AgentResponder {
  if (options.provider === 'iqdoc') {
    return createIQDocResponder(options.iqdoc)
  }
  return createAIResponder(options.openai)
}

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}
