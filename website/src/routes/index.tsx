import { createFileRoute, Link } from '@tanstack/react-router'

const INSTALL_CODE = `bun add bunderstack`

const QUICKSTART_CODE = `// bunderstack.ts
import { createBunderstackAsync } from 'bunderstack'
import * as schema from './schema'

export const app = await createBunderstackAsync({
  schema,
  auth: { emailPassword: true },
  access: {
    posts: { ownerColumn: 'userId', list: 'public', create: 'authenticated' },
  },
})
// GET    /api/posts          → list (public)
// POST   /api/posts          → create (authenticated, owner set from session)
// PATCH  /api/posts/:id      → update (owner only)
// DELETE /api/posts/:id      → delete (owner only)
// POST   /api/auth/sign-up/email`

const STANDALONE_CODE = `// server.ts
import { app } from './bunderstack'
Bun.serve({ port: 3001, fetch: app.handler })`

const NEXTJS_CODE = `// app/api/[...bunderstack]/route.ts
import { getApp } from '@/bunderstack'
export async function GET(req: Request) {
  return (await getApp()).handler(req)
}
export const POST = GET
export const PATCH = GET
export const DELETE = GET`

const TANSTACK_CODE = `// src/routes/api/$.tsx
import { createFileRoute } from '@tanstack/react-router'
import { app } from '~/bunderstack'

const handle = ({ request }: { request: Request }) => app.handler(request)

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: { GET: handle, POST: handle, PATCH: handle, DELETE: handle },
  },
})`

const QUERY_CLIENT_CODE = `// api-client.ts — type-only import, zero bundle cost
import { createBunderstackQueryClient } from 'bunderstack-query'
import { QueryClient } from '@tanstack/react-query'
import type * as schema from './schema'

export const queryClient = new QueryClient()
export const api = createBunderstackQueryClient<typeof schema>().withTables({
  queryClient,
  tables: ['posts', 'user', 'likes'] as const,
})

// In a component:
const { data } = useQuery(api.posts.listQuery({ limit: 20, offset: 0 }))
// data: { items: Post[], limit: number, offset: number }
const create = useMutation(api.posts.createMutation())`

const features = [
  {
    title: 'Auto CRUD',
    desc: 'REST routes generated from your Drizzle schema. Paginate, owner-filter, full-text search.',
  },
  {
    title: 'Auth built-in',
    desc: 'BetterAuth under the hood. Email/password, OAuth, sessions — wired to your DB, zero config.',
  },
  {
    title: 'File storage',
    desc: 'Local filesystem or S3-compatible. Upload API, MIME validation, size limits.',
  },
  {
    title: 'Image transforms',
    desc: 'On-the-fly resize and convert via sharp. ?w=200&h=200&format=webp. Cached after first generate.',
  },
  {
    title: 'Access control',
    desc: 'Per-table, per-operation rules: public, authenticated, owner, or a custom function. All server-enforced.',
  },
  {
    title: 'Query client',
    desc: 'bunderstack-query: typed TanStack Query hooks from your schema. Type-only import, zero client bundle cost.',
  },
]

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <div
      style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '4rem 2rem',
        background: '#0a0a0a',
        color: '#e5e5e5',
        minHeight: '100vh',
        fontFamily: "'Geist Mono', 'JetBrains Mono', monospace",
      }}
    >
      <nav
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: '6rem',
          fontSize: '0.875rem',
        }}
      >
        <span
          style={{
            fontWeight: 700,
            letterSpacing: '-0.02em',
            fontSize: '1rem',
          }}
        >
          bunderstack
        </span>
        <div style={{ display: 'flex', gap: '2rem' }}>
          <Link to="/docs" style={{ color: '#a3a3a3', textDecoration: 'none' }}>
            Docs
          </Link>
          <a
            href="https://github.com/bunderstack/bunderstack"
            style={{ color: '#a3a3a3', textDecoration: 'none' }}
          >
            GitHub
          </a>
        </div>
      </nav>

      <header style={{ marginBottom: '5rem' }}>
        <p
          style={{
            color: '#a3a3a3',
            fontSize: '0.75rem',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginBottom: '1rem',
          }}
        >
          Bun · Drizzle · BetterAuth · Hono
        </p>
        <h1
          style={{
            fontSize: 'clamp(2rem, 5vw, 3.5rem)',
            fontWeight: 800,
            lineHeight: 1.1,
            letterSpacing: '-0.03em',
            marginBottom: '1.5rem',
          }}
        >
          The backend you assemble
          <br />
          <span style={{ color: '#6366f1' }}>every project.</span> Prebuilt.
        </h1>
        <p
          style={{
            color: '#a3a3a3',
            fontSize: '1.125rem',
            maxWidth: '600px',
            lineHeight: 1.6,
            marginBottom: '2.5rem',
          }}
        >
          Give Bunderstack a Drizzle schema. Get auth, CRUD routes, file
          storage, and image thumbnails — wired together and typed end to end.
          Mounts in TanStack Start, Next.js, or standalone Bun via a single
          <code
            style={{
              background: '#1a1a1a',
              padding: '0 0.3em',
              borderRadius: '3px',
            }}
          >
            Request → Response
          </code>{' '}
          handler.
        </p>
        <pre
          style={{
            background: '#111',
            border: '1px solid #222',
            borderRadius: '8px',
            padding: '1rem 1.25rem',
            fontSize: '0.875rem',
            marginBottom: '2rem',
            display: 'inline-block',
          }}
        >
          <code style={{ color: '#a3a3a3' }}>$ </code>
          <code>{INSTALL_CODE}</code>
        </pre>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <Link
            to="/docs/getting-started"
            style={{
              background: '#6366f1',
              color: '#fff',
              padding: '0.625rem 1.5rem',
              borderRadius: '6px',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: '0.875rem',
            }}
          >
            Get Started →
          </Link>
          <Link
            to="/docs"
            style={{
              background: '#1a1a1a',
              color: '#e5e5e5',
              padding: '0.625rem 1.5rem',
              borderRadius: '6px',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: '0.875rem',
              border: '1px solid #333',
            }}
          >
            Documentation
          </Link>
        </div>
      </header>

      <section style={{ marginBottom: '5rem' }}>
        <h2
          style={{
            fontSize: '0.75rem',
            fontWeight: 700,
            marginBottom: '1rem',
            color: '#a3a3a3',
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}
        >
          Quick start
        </h2>
        <pre
          style={{
            background: '#111',
            border: '1px solid #222',
            borderRadius: '8px',
            padding: '1.5rem',
            fontSize: '0.8125rem',
            lineHeight: 1.7,
            overflowX: 'auto',
          }}
        >
          <code>{QUICKSTART_CODE}</code>
        </pre>
      </section>

      <section style={{ marginBottom: '5rem' }}>
        <h2
          style={{
            fontSize: '0.75rem',
            fontWeight: 700,
            marginBottom: '2rem',
            color: '#a3a3a3',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          What you get
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '1px',
            background: '#222',
            border: '1px solid #222',
            borderRadius: '8px',
            overflow: 'hidden',
          }}
        >
          {features.map((f) => (
            <div
              key={f.title}
              style={{ background: '#0a0a0a', padding: '1.5rem' }}
            >
              <h3
                style={{
                  fontWeight: 700,
                  marginBottom: '0.5rem',
                  fontSize: '0.9375rem',
                }}
              >
                {f.title}
              </h3>
              <p
                style={{
                  color: '#737373',
                  fontSize: '0.8125rem',
                  lineHeight: 1.6,
                }}
              >
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: '5rem' }}>
        <h2
          style={{
            fontSize: '0.75rem',
            fontWeight: 700,
            marginBottom: '2rem',
            color: '#a3a3a3',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          One handler, every framework
        </h2>
        <div style={{ display: 'grid', gap: '1rem' }}>
          {[
            { label: 'Standalone Bun', code: STANDALONE_CODE },
            { label: 'Next.js App Router', code: NEXTJS_CODE },
            { label: 'TanStack Start', code: TANSTACK_CODE },
          ].map(({ label, code }) => (
            <div
              key={label}
              style={{
                border: '1px solid #222',
                borderRadius: '8px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  background: '#111',
                  padding: '0.5rem 1rem',
                  fontSize: '0.75rem',
                  color: '#737373',
                  borderBottom: '1px solid #222',
                }}
              >
                {label}
              </div>
              <pre
                style={{
                  background: '#0d0d0d',
                  padding: '1.25rem',
                  fontSize: '0.8125rem',
                  lineHeight: 1.7,
                  overflowX: 'auto',
                  margin: 0,
                }}
              >
                <code>{code}</code>
              </pre>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginBottom: '5rem' }}>
        <h2
          style={{
            fontSize: '0.75rem',
            fontWeight: 700,
            marginBottom: '1rem',
            color: '#a3a3a3',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          Type-safe query client
        </h2>
        <p
          style={{
            color: '#737373',
            fontSize: '0.875rem',
            lineHeight: 1.6,
            marginBottom: '1rem',
          }}
        >
          <code
            style={{
              background: '#1a1a1a',
              padding: '0 0.3em',
              borderRadius: '3px',
            }}
          >
            bunderstack-query
          </code>{' '}
          generates typed TanStack Query hooks for every route. Import your schema as a type — nothing gets bundled on the client.
        </p>
        <pre
          style={{
            background: '#111',
            border: '1px solid #222',
            borderRadius: '8px',
            padding: '1.5rem',
            fontSize: '0.8125rem',
            lineHeight: 1.7,
            overflowX: 'auto',
            marginBottom: '1rem',
          }}
        >
          <code>{QUERY_CLIENT_CODE}</code>
        </pre>
        <Link
          to="/docs/query-client"
          style={{ color: '#6366f1', fontSize: '0.875rem', textDecoration: 'none' }}
        >
          Query client docs →
        </Link>
      </section>

      <section
        style={{
          marginBottom: '5rem',
          border: '1px solid #222',
          borderRadius: '8px',
          padding: '2rem',
        }}
      >
        <h2
          style={{
            fontSize: '0.75rem',
            fontWeight: 700,
            marginBottom: '1.5rem',
            color: '#a3a3a3',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}
        >
          You never hit a wall
        </h2>
        {[
          {
            level: 'Level 0',
            desc: 'createBunderstack({ schema }) — working backend, zero ceremony',
          },
          {
            level: 'Level 1',
            desc: 'Pass config: auth providers, storage target, access rules',
          },
          {
            level: 'Level 2',
            desc: 'Reach into app.db, app.auth, app.storage, app.router',
          },
          {
            level: 'Level 3',
            desc: 'Bypass Bunderstack for a route; write plain Hono + Drizzle',
          },
        ].map(({ level, desc }) => (
          <div
            key={level}
            style={{
              display: 'flex',
              gap: '1.5rem',
              alignItems: 'flex-start',
              marginBottom: '1rem',
            }}
          >
            <span
              style={{
                color: '#6366f1',
                fontWeight: 700,
                fontSize: '0.8125rem',
                minWidth: '60px',
                paddingTop: '0.1rem',
              }}
            >
              {level}
            </span>
            <span
              style={{
                color: '#a3a3a3',
                fontSize: '0.875rem',
                lineHeight: 1.5,
              }}
            >
              {desc}
            </span>
          </div>
        ))}
      </section>

      <footer
        style={{
          borderTop: '1px solid #222',
          paddingTop: '2rem',
          color: '#525252',
          fontSize: '0.75rem',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span>© 2026 Bunderstack</span>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          <Link to="/docs" style={{ color: '#525252', textDecoration: 'none' }}>
            Docs
          </Link>
          <a
            href="https://github.com/bunderstack/bunderstack"
            style={{ color: '#525252', textDecoration: 'none' }}
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  )
}
