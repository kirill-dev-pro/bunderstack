import { createRootRoute, Outlet } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => (
    <html lang="en">
      <body>
        <main style={{ fontFamily: 'monospace', padding: '2rem' }}>
          <h1>Bunderstack × TanStack Start</h1>
          <Outlet />
        </main>
      </body>
    </html>
  ),
})
