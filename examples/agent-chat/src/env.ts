import { type } from 'arktype'

export const envSchema = {
  server: {
    AI_PROVIDER: type("'openai' | 'iqdoc' | undefined").pipe(
      (v) => v ?? 'openai',
    ),
    AI_API_KEY: type('string | undefined'),
    AI_BASE_URL: type('string | undefined').pipe(
      (v) => v ?? 'https://inference.hetzner.com/api/v1',
    ),
    AI_MODEL: type('string | undefined').pipe((v) => v ?? 'Qwen3.8-27B'),
    OPENAI_API_KEY: type('string | undefined'),
    OPENAI_MODEL: type('string | undefined'),
    IQDOC_API_KEY: type('string | undefined'),
    IQDOC_BASE_URL: type('string | undefined'),
    IQDOC_MODEL: type('string | undefined').pipe(
      (v) => v ?? 'assistant_auto',
    ),
  },
  client: {
    PUBLIC_APP_NAME: type('string | undefined').pipe((v) => v ?? 'Agent Desk'),
  },
}
