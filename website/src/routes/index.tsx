import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import '@fontsource-variable/ubuntu-sans'
import '@fontsource-variable/tektur'
import '@shikijs/twoslash/style-rich.css'

import snippets from '@/lib/code-snippets.gen.json'
import { ThemeToggle } from '@/components/theme-toggle'

const GITHUB = 'https://github.com/kirill-dev-pro/bunderstack'

interface ConceptBlock {
  id: string
  title: string
  library: string
  docPath: string
  color: string
  colorRgb: string
  code: string
  description: string
}

const CONCEPTS: ConceptBlock[] = [
  {
    id: 'database',
    title: 'Database & Schema',
    library: 'Drizzle ORM · LibSQL / Postgres',
    docPath: 'configuration',
    color: '#3b82f6',
    colorRgb: '59, 130, 246',
    code: `schema: { posts },
database: { adapter: libsql() }`,
    description:
      'Zero-boilerplate database with automatic schema migrations, typed relations, and type-safe query building.',
  },
  {
    id: 'auth',
    title: 'Authentication',
    library: 'Better Auth',
    docPath: 'auth',
    color: '#10b981',
    colorRgb: '16, 185, 129',
    code: `auth: {
  secret: process.env.AUTH_SECRET!
}`,
    description:
      'Sessions, credentials, OAuth providers, and user management stored directly on your application database.',
  },
  {
    id: 'crud',
    title: 'Access & CRUD',
    library: 'Drizzle ORM · oRPC',
    docPath: 'crud',
    color: '#8b5cf6',
    colorRgb: '139, 92, 246',
    code: `access: {
  posts: { ownerColumn: 'userId' }
}`,
    description:
      'Declarative row-level security and auto-generated type-safe CRUD operations with cursor pagination.',
  },
  {
    id: 'api',
    title: 'Typed API & Procedures',
    library: 'oRPC · Standard Schema',
    docPath: 'api-procedures',
    color: '#ec4899',
    colorRgb: '236, 72, 153',
    code: `api: (o) => ({
  stats: o.protected.handler(async ({ context }) => ({
    total: 12,
    requestedBy: context.user.id,
  })),
})`,
    description:
      'End-to-end typed RPC endpoints, OpenAPI generation, input validation with Valibot or Zod, and procedure middleware.',
  },
  {
    id: 'storage',
    title: 'S3 Storage & Transforms',
    library: 'Bun.s3 / S3 · Bun.Image',
    docPath: 'storage',
    color: '#f59e0b',
    colorRgb: '245, 158, 11',
    code: `storage: {
  local: true,
  buckets: { images: { transforms: true } }
}`,
    description:
      'Local dev storage or S3 buckets with signed URLs, direct file uploads, and on-the-fly image transformations.',
  },
  {
    id: 'email',
    title: 'Transactional Email',
    library: 'Nodemailer · Resend / SMTP',
    docPath: 'email',
    color: '#06b6d4',
    colorRgb: '6, 182, 212',
    code: `email: {
  from: 'hello@example.com'
}`,
    description:
      'Type-safe transactional emailing with dev console logging in development and Resend or SMTP in production.',
  },
  {
    id: 'realtime',
    title: 'Realtime Sync',
    library: 'SSE · Redis · WebSockets',
    docPath: 'sync-collections',
    color: '#14b8a6',
    colorRgb: '20, 184, 166',
    code: `realtime: true`,
    description:
      'Live database change broadcasts with automatic reconnection, heartbeat, and query cache patching.',
  },
  {
    id: 'jobs',
    title: 'Background Jobs & Cron',
    library: 'Durable Scheduler · Queue',
    docPath: 'background-jobs',
    color: '#e11d48',
    colorRgb: '225, 29, 72',
    code: `jobs: (j) =>
  j.define({
    digest: j.cron({
      schedule: '0 9 * * *',
      handler: async (_run, ctx) => {
        await ctx.email.send({ ... })
      },
    }),
  })`,
    description:
      'Durable background queues with exponential backoff retries and cron scheduling unified into one process.',
  },
]

const EXAMPLES = [
  {
    dir: 'todo',
    label: 'Everything, kept small',
    description:
      'Custom procedures, generated CRUD, auth, storage, jobs, and realtime in one readable app.',
  },
  {
    dir: 'tldraw',
    label: 'Collaborative canvas',
    description:
      'Live cursors and shared drawings with typed presence and resilient reconnect behavior.',
  },
  {
    dir: 'kanban-tanstack',
    label: 'Realtime product UI',
    description:
      'TanStack Start, Query, and generated API procedures across boards, cards, and comments.',
  },
  {
    dir: 'twitter-db-tanstack',
    label: 'Growing live collections',
    description:
      'A feed built on scoped TanStack DB collections, cursor windows, and typed updates.',
  },
]

const CLIENT_POINTS = [
  'Rename a column and the call sites fail, at compile time.',
  'No codegen step, and no second copy of the contract.',
  'One error contract from the handler to the query cache.',
]

const FRONTEND_POINTS = [
  'Auto-generated query and mutation options for TanStack Query.',
  'authClient.useSession() for reactive user session state.',
  'syncRealtime automatically patches the query cache on live changes.',
  'Direct file uploads and on-the-fly transformed image URLs.',
]

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Bunderstack — your whole backend as a single file declaration' },
      {
        name: 'description',
        content:
          'Declare schema, auth, storage, jobs, email, and realtime in one file. `bun run dev` starts all of it with no setup. Small enough to fit in your agent context and in your head.',
      },
    ],
  }),
  component: Landing,
})

function CopyButton({
  code,
  label = 'copy',
}: {
  code: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="landing-copy"
      aria-label="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(code)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_600)
      }}
    >
      {copied ? 'copied ✓' : label}
    </button>
  )
}

/** Click/tap pins a type popup open (hover still works with a mouse). */
function usePinnablePopups() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      const hover = target.closest?.('.twoslash-hover')
      document.querySelectorAll('.twoslash-pinned').forEach((el) => {
        if (el !== hover) el.classList.remove('twoslash-pinned')
      })
      if (hover && !target.closest('.twoslash-popup-container')) {
        hover.classList.toggle('twoslash-pinned')
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
}

function CodePanel({
  file,
  snippet,
}: {
  file: string
  snippet: { html: string; code: string }
}) {
  return (
    <div className="landing-code">
      {/* Generated at build time by scripts/gen-code-snippets.ts (shiki + twoslash) */}
      <div
        className="landing-code__source"
        dangerouslySetInnerHTML={{ __html: snippet.html }}
      />
      <div className="landing-code__caption">
        <code>{file}</code>
        <CopyButton code={snippet.code} />
      </div>
    </div>
  )
}

function ConceptHexGrid() {
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = e.currentTarget
    const cards = container.getElementsByClassName('landing-hex-card')
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i] as HTMLElement
      const rect = card.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      card.style.setProperty('--mouse-x', `${x}px`)
      card.style.setProperty('--mouse-y', `${y}px`)
    }
  }

  return (
    <div className="landing-hex-grid" onMouseMove={handleMouseMove}>
      {CONCEPTS.map((concept) => (
        <article
          key={concept.id}
          className="landing-hex-card"
          style={
            {
              '--card-accent': concept.color,
              '--card-accent-rgb': concept.colorRgb,
            } as React.CSSProperties
          }
        >
          <div className="landing-hex-card__glow" />
          <div className="landing-hex-card__inner">
            <header className="landing-hex-card__header">
              <div className="landing-hex-card__title-row">
                <span
                  className="landing-hex-card__dot"
                  style={{ backgroundColor: concept.color }}
                  aria-hidden="true"
                />
                <h3 className="landing-hex-card__title">{concept.title}</h3>
              </div>
              <span className="landing-hex-card__lib">{concept.library}</span>
            </header>

            {snippets.concepts?.[concept.id] ? (
              <div
                className="landing-hex-card__code"
                dangerouslySetInnerHTML={{
                  __html: snippets.concepts[concept.id],
                }}
              />
            ) : (
              <pre className="landing-hex-card__code">
                <code>{concept.code}</code>
              </pre>
            )}

            <div className="landing-hex-card__footer">
              <p className="landing-hex-card__desc">{concept.description}</p>
              <Link
                to="/docs/$"
                params={{ _splat: concept.docPath }}
                className="landing-hex-card__link"
              >
                Docs <span>→</span>
              </Link>
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}

function Landing() {
  usePinnablePopups()
  const [mobileTab, setMobileTab] = useState<'backend' | 'frontend'>('backend')

  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Main navigation">
        <Link className="landing-brand" to="/">
          <span aria-hidden>⌁</span>
          bunderstack
          <small>beta</small>
        </Link>
        <div className="landing-nav__links">
          <Link to="/docs/$" params={{ _splat: '' }}>
            Docs
          </Link>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <ThemeToggle />
        </div>
      </nav>

      <header className="landing-hero">
        <div aria-hidden className="landing-hero__glow" />
        <h1>
          Your whole backend as a <em>single file</em>.
        </h1>
        <p className="landing-hero__lede">
          Database, auth, CRUD, storage, jobs, email, and realtime are keys on
          one object, and <code>bun run dev</code> starts all of it.
        </p>
        <div className="landing-hero__actions">
          <div className="landing-install">
            <code>bun add bunderstack</code>
            <CopyButton code="bun add bunderstack" />
          </div>
          <Link
            className="landing-button landing-button--primary"
            to="/docs/$"
            params={{ _splat: 'getting-started' }}
          >
            Read the docs
          </Link>
        </div>
      </header>

      <div className="landing-showcase">
        <div className="landing-showcase__nav">
          <div className="landing-showcase__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mobileTab === 'backend'}
              className={`landing-showcase__tab ${mobileTab === 'backend' ? 'landing-showcase__tab--active' : ''}`}
              onClick={() => setMobileTab('backend')}
            >
              Backend
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mobileTab === 'frontend'}
              className={`landing-showcase__tab ${mobileTab === 'frontend' ? 'landing-showcase__tab--active' : ''}`}
              onClick={() => setMobileTab('frontend')}
            >
              Frontend
            </button>
          </div>
        </div>

        <div
          className={`landing-showcase__column ${mobileTab !== 'backend' ? 'landing-showcase__column--hidden-mobile' : ''}`}
        >
          <section className="landing-section landing-section--inline">
            <h2>One object is the backend</h2>
            <p className="landing-lede">
              Every facility is a key, not a service to stand up. Read the file
              top to bottom and you know the system.
            </p>
            <CodePanel
              file="src/bunderstack.ts"
              snippet={snippets.declaration}
            />
          </section>

          <section className="landing-section landing-section--inline">
            <h2>Types reach the client</h2>
            <p className="landing-lede">
              Import <code>type App</code> and stop. Tables, procedures, inputs,
              outputs, and errors are inferred from the declaration.
            </p>
            <CodePanel file="src/api-client.ts" snippet={snippets.client} />
            <ul className="landing-points">
              {CLIENT_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </section>
        </div>

        <div
          className={`landing-showcase__column ${mobileTab !== 'frontend' ? 'landing-showcase__column--hidden-mobile' : ''}`}
        >
          <section className="landing-section landing-section--inline">
            <h2>Use it on frontend</h2>
            <p className="landing-lede">
              Queries, mutations, realtime subscriptions, and storage helpers
              in your React components with full inference.
            </p>
            <CodePanel file="src/Feed.tsx" snippet={snippets.frontend} />
            <ul className="landing-points">
              {FRONTEND_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <section className="landing-section">
        <h2>Included, not integrated by you</h2>
        <p className="landing-lede">
          Each of these is useful alone. Together they remove the adapters and
          lifecycle code that normally fill the space between them.
        </p>
        <ConceptHexGrid />
      </section>

      <section id="examples" className="landing-section">
        <h2>Examples</h2>
        <p className="landing-lede">
          Application-sized tests of the mental model, not isolated feature
          demos.
        </p>
        <div className="landing-grid landing-grid--examples">
          {EXAMPLES.map((example) => (
            <a
              className="landing-card landing-card--link"
              href={`${GITHUB}/tree/main/examples/${example.dir}`}
              key={example.dir}
              target="_blank"
              rel="noreferrer"
            >
              <span className="landing-card__group">{example.label}</span>
              <h3>
                <code>examples/{example.dir}</code>
              </h3>
              <p>{example.description}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="landing-cta">
        <h2>
          Declare it once. Run it with <em>one command</em>.
        </h2>
        <div className="landing-cta__actions">
          <Link
            className="landing-button landing-button--primary"
            to="/docs/$"
            params={{ _splat: 'getting-started' }}
          >
            Read the docs
          </Link>
          <a
            className="landing-button"
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </section>

      <footer className="landing-footer">
        MIT licensed · Bun · Drizzle · Better Auth · oRPC
      </footer>
    </main>
  )
}
