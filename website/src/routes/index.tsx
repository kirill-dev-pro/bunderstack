import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import '@shikijs/twoslash/style-rich.css'

import snippets from '@/lib/code-snippets.gen.json'

const GITHUB = 'https://github.com/kirill-dev-pro/bunderstack'

const CAPABILITIES = [
  {
    group: 'data',
    items: [
      ['Drizzle schema', 'Your tables remain the source of truth.'],
      ['Generated CRUD', 'Access, filters, pagination, idempotency.'],
      ['SQLite + Postgres', 'Choose one adapter; keep the same app model.'],
    ],
  },
  {
    group: 'application',
    items: [
      ['oRPC procedures', 'Public, protected, HTTP, and webhook.'],
      ['Better Auth', 'Sessions and providers on the same database.'],
      [
        'Standard Schema',
        'Valibot, Zod, ArkType, or your preferred validator.',
      ],
    ],
  },
  {
    group: 'runtime',
    items: [
      ['Realtime Publisher', 'Typed changes, resume, heartbeat, backoff.'],
      ['Background jobs', 'Durable queue and cron from one process model.'],
      ['Files + email', 'Local or S3 storage; console, Resend, or SMTP.'],
    ],
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

const COMPARISON = [
  ['Application shape', 'library in your app', 'service beside your app'],
  ['Where it is configured', 'one file in your repository', 'dashboard and console'],
  ['API contract', 'inferred from that file', 'SDK or generated client'],
  ['Local development', 'bun run dev', 'containers or a cloud project'],
  [
    'Schema ownership',
    'Drizzle in your repository',
    'remote dashboard or service',
  ],
  [
    'Escape hatch',
    'raw database and facilities',
    'platform-specific extension',
  ],
  [
    'Realtime recovery',
    'Publisher resume + refetch',
    'channel-specific behavior',
  ],
]

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Bunderstack — your whole backend as a single file' },
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
  label = 'Copy',
}: {
  code: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      className="blueprint-copy"
      onClick={() => {
        void navigator.clipboard.writeText(code)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1_600)
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}

function TypeTrace({
  value,
  type,
  live = false,
}: {
  value: string
  type: string
  live?: boolean
}) {
  return (
    <div className={`type-trace ${live ? 'type-trace--live' : ''}`}>
      <span className="type-trace__value">{value}</span>
      <span aria-hidden className="type-trace__line" />
      <code>{type}</code>
    </div>
  )
}

function CodePanel({
  title,
  snippet,
  trace,
}: {
  title: string
  snippet: { html: string; code: string }
  trace?: { value: string; type: string; live?: boolean }
}) {
  return (
    <div className="blueprint-code">
      <div className="blueprint-code__header">
        <span>
          <i /> {title}
        </span>
        <CopyButton code={snippet.code} />
      </div>
      <div
        className="blueprint-code__source"
        dangerouslySetInnerHTML={{ __html: snippet.html }}
      />
      {trace ? <TypeTrace {...trace} /> : null}
    </div>
  )
}

function SectionHeading({
  signal,
  title,
  children,
}: {
  signal: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="section-heading">
      <div className="section-heading__signal">{signal}</div>
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  )
}

function SystemTrace() {
  const nodes = [
    ['schema', 'Drizzle tables'],
    ['procedure', 'oRPC graph'],
    ['client', 'inferred calls'],
    ['live', 'Publisher events'],
  ]

  return (
    <div className="system-trace" aria-label="Bunderstack type flow">
      <div className="system-trace__rail" aria-hidden />
      {nodes.map(([key, label], index) => (
        <div className="system-trace__node" key={key}>
          <span className="system-trace__coordinate">0{index + 1}</span>
          <span
            className={`system-trace__dot ${key === 'live' ? 'is-live' : ''}`}
          />
          <strong>{key}</strong>
          <small>{label}</small>
        </div>
      ))}
    </div>
  )
}

function Landing() {
  return (
    <main className="blueprint-site">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .system-trace__rail::after { animation: trace-scan 4.8s ease-in-out infinite; }
          .system-trace__dot.is-live { animation: live-pulse 2.4s ease-out infinite; }
        }
      `}</style>

      <nav className="blueprint-nav" aria-label="Main navigation">
        <Link className="blueprint-brand" to="/">
          <span aria-hidden>⌁</span>
          bunderstack
          <small>beta</small>
        </Link>
        <div className="blueprint-nav__links">
          <Link to="/docs/$" params={{ _splat: '' }}>
            Docs
          </Link>
          <a href="#examples">Examples</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
        </div>
      </nav>

      <header className="blueprint-hero">
        <div className="blueprint-hero__copy">
          <p className="blueprint-kicker">
            <span>Backend / Bun</span>
            <span>Declaration / TypeScript</span>
          </p>
          <h1>Your whole backend as a single file declaration.</h1>
          <p className="blueprint-hero__lede">
            Database, auth, CRUD, storage, jobs, email, and realtime are keys on
            one object. <code>bun run dev</code> starts all of it with nothing
            to configure. Small enough to fit in your agent&rsquo;s context, and
            in your head.
          </p>
          <div className="blueprint-actions">
            <Link
              className="blueprint-button blueprint-button--primary"
              to="/docs/$"
              params={{ _splat: 'getting-started' }}
            >
              Build the first procedure
            </Link>
            <div className="install-command">
              <code>bun add bunderstack</code>
              <CopyButton code="bun add bunderstack" label="Copy command" />
            </div>
          </div>
        </div>
        <div className="blueprint-hero__diagram">
          <div className="diagram-label">system/type-flow.ts</div>
          <SystemTrace />
          <div className="diagram-note">
            <span>no codegen</span>
            <span>one error contract</span>
            <span>Standard Schema</span>
          </div>
        </div>
      </header>

      <section className="blueprint-section blueprint-section--story">
        <SectionHeading
          signal="A / Declare"
          title="One object is the backend"
        >
          Every facility is a key, not a service to stand up. Turning on file
          uploads is a <code>storage</code> key. Turning on realtime is{' '}
          <code>realtime: true</code>. There is no wiring between them to write,
          and no second place where any of it is configured.
        </SectionHeading>
        <div className="story-grid story-grid--server">
          <CodePanel
            title="src/bunderstack.ts"
            snippet={snippets.declaration}
            trace={{
              value: 'app',
              type: 'the database, API, auth, and jobs behind one handle',
            }}
          />
          <aside className="story-aside">
            <span className="story-aside__mark">A.1</span>
            <h3>Read it top to bottom and you know the system</h3>
            <p>
              Nothing is hidden in a dashboard, a YAML file, or a provider
              console. What the file says is what runs, which is why the whole
              backend stays reviewable in one sitting.
            </p>
            <Link to="/docs/$" params={{ _splat: 'configuration' }}>
              Configuration model →
            </Link>
          </aside>
        </div>
      </section>

      <section className="blueprint-section blueprint-section--story">
        <SectionHeading
          signal="B / Run"
          title="bun run dev starts all of it"
        >
          No docker-compose, no local Postgres, no S3 emulator, no separate
          queue worker, no auth service to point at. One command, one process,
          and the same declaration decides what production runs.
        </SectionHeading>
        <div className="story-grid story-grid--server">
          <div className="reliability-stack">
            {[
              ['database', 'SQLite on disk, or Postgres when you name one'],
              ['migrate', 'Schema pushed in dev; committed migrations on boot'],
              ['auth', 'Sessions and providers on that same database'],
              ['storage', 'Local disk in dev, S3 in production, same API'],
              ['jobs', 'Queue and cron, no broker to install'],
              ['deploy', 'A container that needs no attached services'],
            ].map(([verb, text]) => (
              <div className="reliability-step" key={verb}>
                <span>{verb}</span>
                <p>{text}</p>
              </div>
            ))}
            <Link to="/docs/$" params={{ _splat: 'getting-started' }}>
              Getting started →
            </Link>
          </div>
          <aside className="story-aside story-aside--accent">
            <span className="story-aside__mark">B.1</span>
            <h3>The gap between dev and prod is a config value</h3>
            <p>
              Storage moves from disk to S3, the database from SQLite to
              Postgres, email from your console to a real sender. The
              application code that uses them does not change.
            </p>
          </aside>
        </div>
      </section>

      <section className="blueprint-section">
        <SectionHeading
          signal="C / Context"
          title="Small enough for an agent to read all of it"
        >
          A coding agent is most useful when it can see the whole system before
          it changes anything. That is a size problem, and most backends fail it
          — the answer is spread across services, dashboards, and infrastructure
          the agent never gets to look at.
        </SectionHeading>
        <div className="story-grid story-grid--server">
          <div className="reliability-stack">
            {[
              ['bunderstack.ts', '136 lines — every facility, declared'],
              ['api.ts', '173 lines — the procedures CRUD does not cover'],
              ['schema.ts', '72 lines — the tables'],
              ['access.ts', '35 lines — who may read and write what'],
              ['env.ts', '23 lines — the variables, checked at boot'],
            ].map(([verb, text]) => (
              <div className="reliability-step" key={verb}>
                <span>{verb}</span>
                <p>{text}</p>
              </div>
            ))}
            <a
              href={`${GITHUB}/tree/main/examples/todo`}
              target="_blank"
              rel="noreferrer"
            >
              Read the whole example ↗
            </a>
          </div>
          <aside className="story-aside story-aside--accent">
            <span className="story-aside__mark">C.1</span>
            <h3>439 lines is a working product</h3>
            <p>
              That is the complete backend of the todo example — accounts,
              generated CRUD with access rules, file uploads with resizing, a
              cron job, transactional email, and a live stream. It fits in a
              model&rsquo;s context with room left for the work you asked it to
              do, and the same property is why a new person is productive on it
              in an afternoon.
            </p>
            <Link to="/docs/$" params={{ _splat: 'templates-and-skills' }}>
              Templates and agent skills →
            </Link>
          </aside>
        </div>
      </section>

      <section className="blueprint-section blueprint-section--story">
        <SectionHeading
          signal="D / Infer"
          title="The client already knows what you declared"
        >
          Import <code>type App</code> and stop. Tables, procedures, inputs,
          outputs, errors, and TanStack Query option factories are all inferred
          from the declaration, so there is no generation step to run and no
          second copy of the contract to keep honest.
        </SectionHeading>
        <div className="story-grid story-grid--client">
          <aside className="story-aside story-aside--accent">
            <span className="story-aside__mark">D.1</span>
            <h3>Rename a column, and the call sites fail</h3>
            <p>
              The contract has one source. Nothing drifts quietly between the
              database, the API, and the client, because there is no second
              place for it to drift to.
            </p>
            <Link to="/docs/$" params={{ _splat: 'query-client' }}>
              Query client →
            </Link>
          </aside>
          <CodePanel
            title="src/api-client.ts"
            snippet={snippets.client}
            trace={{
              value: 'result',
              type: '{ boardId: string; total: number; requestedBy: string }',
            }}
          />
        </div>
      </section>

      <section className="blueprint-section blueprint-section--live">
        <SectionHeading
          signal="E / Live"
          title="Realtime you did not have to build"
        >
          <code>realtime: true</code> is the whole opt-in. Writes reach query
          caches and live collections as typed changes, and the parts that are
          tedious to get right — resume, dead-stream detection, backoff — are
          library behavior rather than loops copied into every application.
        </SectionHeading>
        <div className="story-grid story-grid--server">
          <CodePanel
            title="src/realtime.ts"
            snippet={snippets.realtime}
            trace={{
              value: 'connection',
              type: 'RealtimeSync — one lifecycle per client',
              live: true,
            }}
          />
          <div className="reliability-stack">
            {[
              ['publish', 'Canonical rows from CRUD and custom writes'],
              ['resume', 'Retained event IDs recover short disconnects'],
              ['verify', 'One refetch closes an expired replay window'],
              [
                'settle',
                'Mutation reconciliation avoids a follow-up list call',
              ],
            ].map(([verb, text]) => (
              <div className="reliability-step" key={verb}>
                <span>{verb}</span>
                <p>{text}</p>
              </div>
            ))}
            <Link to="/docs/$" params={{ _splat: 'sync-collections' }}>
              Sync and reliability →
            </Link>
          </div>
        </div>
      </section>

      <section className="blueprint-section">
        <SectionHeading
          signal="F / System"
          title="Included, not integrated by you"
        >
          Each of these is useful alone. Together they remove the adapters,
          wrappers, duplicate validation, and lifecycle code that normally fill
          the space between them — the code nobody wants to own.
        </SectionHeading>
        <div className="capability-map">
          {CAPABILITIES.map((column) => (
            <div className="capability-column" key={column.group}>
              <div className="capability-column__title">{column.group}</div>
              {column.items.map(([title, description]) => (
                <article key={title}>
                  <span aria-hidden>+</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section id="examples" className="blueprint-section">
        <SectionHeading
          signal="G / Proof"
          title="Examples that exercise the system"
        >
          The examples are application-sized tests of the mental model, not
          isolated feature demos.
        </SectionHeading>
        <div className="example-grid">
          {EXAMPLES.map((example, index) => (
            <a
              className="example-card"
              href={`${GITHUB}/tree/main/examples/${example.dir}`}
              key={example.dir}
              target="_blank"
              rel="noreferrer"
            >
              <span className="example-card__index">G.{index + 1}</span>
              <h3>{example.label}</h3>
              <code>examples/{example.dir}</code>
              <p>{example.description}</p>
              <span className="example-card__arrow">Open source ↗</span>
            </a>
          ))}
        </div>
      </section>

      <section className="blueprint-section">
        <SectionHeading
          signal="H / Shape"
          title="A library, not another control plane"
        >
          You get the leverage of an integrated backend without handing over the
          parts you need to read, diff, and deploy yourself.
        </SectionHeading>
        <div
          className="comparison-table"
          role="table"
          aria-label="Backend shape comparison"
        >
          <div className="comparison-row comparison-row--header" role="row">
            <span role="columnheader">Decision</span>
            <strong role="columnheader">Bunderstack</strong>
            <span role="columnheader">Hosted backend</span>
          </div>
          {COMPARISON.map(([label, ours, theirs]) => (
            <div className="comparison-row" role="row" key={label}>
              <span role="cell">{label}</span>
              <strong role="cell">{ours}</strong>
              <span role="cell">{theirs}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="blueprint-cta">
        <div>
          <span className="blueprint-kicker">Ready / 0.18 beta</span>
          <h2>Declare it once. Run it with one command.</h2>
        </div>
        <div className="blueprint-cta__actions">
          <Link
            className="blueprint-button blueprint-button--primary"
            to="/docs/$"
            params={{ _splat: 'getting-started' }}
          >
            Read the five-minute guide
          </Link>
          <a
            className="blueprint-button"
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
          >
            Browse GitHub ↗
          </a>
        </div>
      </section>

      <footer className="blueprint-footer">
        <span>MIT licensed · built for Bun and TypeScript</span>
        <span>Drizzle · Better Auth · oRPC · Valibot</span>
      </footer>
    </main>
  )
}
