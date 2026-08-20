import { clientOnly } from '@solidjs/web'
import { QueryClientProvider } from '@tanstack/solid-query'

import { queryClient } from './api'
import './app.css'

// The list fetches from `/api`, which needs a browser origin, so it never runs
// on the server. `clientOnly` is Solid's primitive for exactly that: the
// server renders the shell, the browser mounts the component.
const TodoList = clientOnly(() => import('./TodoList'))

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <main class="app">
        <h1>Todo</h1>
        <p class="sub">
          Solid 2 · Bunderstack auto-CRUD · TanStack Solid Query
        </p>
        <TodoList />
      </main>
    </QueryClientProvider>
  )
}
