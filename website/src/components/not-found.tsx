import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div style={{ padding: '4rem 2rem', textAlign: 'center' }}>
      {/* React 19 hoists these into <head>; a soft 404 must never be indexed. */}
      <title>Page not found — bunderstack</title>
      <meta name="robots" content="noindex, follow" />
      <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '1rem' }}>
        404
      </h1>
      <p style={{ color: '#737373', marginBottom: '1.5rem' }}>
        Page not found.
      </p>
      <Link to="/" style={{ color: '#6366f1', textDecoration: 'none' }}>
        Go home
      </Link>
    </div>
  )
}
