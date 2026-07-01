import { TanStackDevtools } from '@tanstack/react-devtools'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'

// No TanStack Query devtools panel here — this app has no QueryClientProvider
// (TanStack DB collections don't use React Query's cache/hooks), so
// ReactQueryDevtoolsPanel would throw via useQueryClient() with nothing to
// connect to. No equivalent TanStack DB devtools package exists yet.
export function AppDevtools() {
  return (
    <TanStackDevtools
      config={{
        position: 'bottom-right',
        hideUntilHover: true,
      }}
      plugins={[
        {
          name: 'TanStack Router',
          render: <TanStackRouterDevtoolsPanel />,
        },
      ]}
    />
  )
}
