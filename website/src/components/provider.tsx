'use client'

import { RootProvider } from 'fumadocs-ui/provider/tanstack'

import { searchApiUrl } from '@/lib/paths'

export function Provider({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider
      theme={{
        defaultTheme: 'system',
        enableSystem: true,
        attribute: 'class',
      }}
      search={{
        options: {
          type: 'static',
          api: searchApiUrl,
        },
      }}
    >
      {children}
    </RootProvider>
  )
}
