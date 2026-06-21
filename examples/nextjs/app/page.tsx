export default function Home() {
  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem' }}>
      <h1>Bunderstack × Next.js</h1>
      <p>REST API available at <code>/api/*</code></p>
      <ul>
        <li><code>GET  /api/health</code></li>
        <li><code>GET  /api/posts</code></li>
        <li><code>POST /api/posts</code></li>
        <li><code>POST /api/auth/sign-up/email</code></li>
        <li><code>POST /api/files</code></li>
      </ul>
    </main>
  )
}
