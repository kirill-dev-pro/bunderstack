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

export function createConfiguredResponder(
  options: ConfiguredResponderOptions = {},
): AgentResponder {
  if (options.provider === 'iqdoc') {
    return createIQDocResponder(options.iqdoc)
  }
  return createAIResponder(options.openai)
}
