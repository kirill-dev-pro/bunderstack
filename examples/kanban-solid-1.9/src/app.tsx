import { Router, Route, Navigate } from '@solidjs/router'
import { QueryClientProvider } from '@tanstack/solid-query'
import { Show } from 'solid-js'

import { authClient } from './lib/auth-client.ts'
import { queryClient } from './lib/query.ts'
import { Board } from './routes/Board.tsx'
import { Boards } from './routes/Boards.tsx'
import { Login } from './routes/Login.tsx'

function Protected(props: { children: any }) {
  const session = authClient.useSession()
  return (
    <Show
      when={!session().isPending}
      fallback={<p class="ot-container">Loading…</p>}
    >
      <Show when={session().data} fallback={<Navigate href="/login" />}>
        {props.children}
      </Show>
    </Show>
  )
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Route path="/login" component={Login} />
        <Route
          path="/"
          component={() => (
            <Protected>
              <Boards />
            </Protected>
          )}
        />
        <Route
          path="/boards/:id"
          component={() => (
            <Protected>
              <Board />
            </Protected>
          )}
        />
      </Router>
    </QueryClientProvider>
  )
}
