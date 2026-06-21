import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: () => (
    <div>
      <p>REST API available at <code>/api/*</code></p>
      <ul>
        <li><code>GET  /api/health</code></li>
        <li><code>GET  /api/posts</code></li>
        <li><code>POST /api/posts</code></li>
      </ul>
    </div>
  ),
})
