import type { UserConfig } from 'vite'

export const viteResolve: UserConfig['resolve'] = {
  dedupe: ['@tanstack/db'],
  tsconfigPaths: true,
}
