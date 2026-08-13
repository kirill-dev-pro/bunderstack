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
  ['API contract', 'one inferred procedure graph', 'SDK or generated client'],
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
      { title: 'Bunderstack — one typed backend graph for Bun' },
      {
        name: 'description',
        content:
          'Schema, application procedures, clients, and realtime in one type-safe backend graph for Bun.',
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
            <span>Backend system / Bun</span>
            <span>Contract / TypeScript</span>
          </p>
          <h1>One graph. Every boundary typed.</h1>
          <p className="blueprint-hero__lede">
            Start with a Drizzle schema. Add application behavior as oRPC
            procedures. The HTTP API, client, and realtime stream stay one
            coherent system.
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
          title="Behavior belongs in the graph"
        >
          Public pages, authenticated actions, HTTP routes, and webhooks use the
          same procedure primitive. Output types come from the handler unless a
          runtime output schema has a real job to do.
        </SectionHeading>
        <div className="story-grid story-grid--server">
          <CodePanel
            title="src/bunderstack.ts"
            snippet={snippets.procedure}
            trace={{
              value: 'context.user',
              type: 'AccessUser — narrowed by o.protected',
            }}
          />
          <aside className="story-aside">
            <span className="story-aside__mark">A.1</span>
            <h3>Validation where trust changes</h3>
            <p>
              Inputs accept Standard Schema. Handler returns remain inferred.
              Add output validation for external contracts or transformations,
              not as repeated ceremony.
            </p>
            <Link to="/docs/$" params={{ _splat: 'api-procedures' }}>
              API procedure model →
            </Link>
          </aside>
        </div>
      </section>

      <section className="blueprint-section blueprint-section--story">
        <SectionHeading
          signal="B / Infer"
          title="The useful types arrive at the call site"
        >
          Import only <code>type App</code>. The client knows generated tables,
          custom procedures, inputs, outputs, errors, and TanStack Query option
          factories without a generation step.
        </SectionHeading>
        <div className="story-grid story-grid--client">
          <aside className="story-aside story-aside--accent">
            <span className="story-aside__mark">B.1</span>
            <h3>Inspect the boundary, not every token</h3>
            <p>
              The result is the important fact here. Its compact type trace
              stays visible; library internals stay out of the way.
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
          signal="C / Live"
          title="Realtime is transport, not application glue"
        >
          oRPC Publisher carries the same typed writes to query caches and live
          collections. Resume, heartbeat, and exponential reconnect are library
          behavior, not loops copied into every application.
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
          signal="D / System"
          title="Batteries that share one context"
        >
          Each facility is useful alone. Together they remove the adapters,
          wrappers, duplicate validation, and lifecycle code that usually sit
          between them.
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
          signal="E / Proof"
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
              <span className="example-card__index">E.{index + 1}</span>
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
          signal="F / Shape"
          title="A library, not another control plane"
        >
          Bunderstack keeps the leverage of an integrated backend while your
          application still owns its schema, process, and infrastructure.
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
          <span className="blueprint-kicker">Ready / 0.17 beta</span>
          <h2>Start with a schema. Keep one graph.</h2>
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
