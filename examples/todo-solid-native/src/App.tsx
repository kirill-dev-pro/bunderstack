import { clientOnly } from '@solidjs/web'

import './app.css'

// The list fetches from `/api`, which needs a browser origin, so it never
// runs on the server — `clientOnly` mounts it in the browser only. There is
// no query provider here: nothing to provide.
const TodoList = clientOnly(() => import('./TodoList'))

export default function App() {
  return (
    <main class="app">
      <h1>Todo</h1>
      <p class="sub">Solid 2 · Bunderstack · native promises &amp; iterators</p>
      <TodoList />
    </main>
  )
}
