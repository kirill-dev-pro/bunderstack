import { type } from 'arktype'

export const envSchema = {
  server: {
    AI_API_KEY: type('string'),
    AI_BASE_URL: type('string | undefined').pipe(
      (v) => v ?? 'https://inference.hetzner.com/api/v1',
    ),
    AI_MODEL: type('string | undefined').pipe((v) => v ?? 'Qwen3.8-27B'),
    OPENAI_API_KEY: type('string | undefined'),
    OPENAI_MODEL: type('string | undefined'),
  },
  client: {
    PUBLIC_APP_NAME: type('string | undefined').pipe((v) => v ?? 'Agent Desk'),
  },
}
