import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import '@shikijs/twoslash/style-rich.css'
import snippets from '@/lib/code-snippets.gen.json'

const GITHUB = 'https://github.com/kirill-dev-pro/bunderstack'

/* Signature mark: a cumulus drawn in glyphs — the sky and the terminal in
 * one object. Kept as a line array so no character needs escaping. */
const ASCII_CLOUD = [
  '                _  _',
  "             (  '   ) _",
  "          (            ' )  _",
  "       ('       (        )  ' )",
  '      (     (      )   (      )',
  "       '~~-(_____)-~(_____)-~~'",
].join('\n')

const CLIENT_TABS = [
  {
    key: 'query' as const,
    file: 'api-client.ts',
    label: 'bunderstack-query',
    note: 'typed fetch + TanStack Query options',
  },
  {
    key: 'sync' as const,
    file: 'collections.ts',
    label: 'bunderstack-sync',
    note: 'live TanStack DB collections',
  },
]

const BATTERIES = [
  {
    key: 'crud' as const,
    name: 'Auto CRUD',
    file: 'server.ts',
    text: 'Every table in your Drizzle schema gets REST routes at /api — list with pagination and search, create, update, delete. No route files.',
  },
  {
    key: 'access' as const,
    name: 'Access rules',
    file: 'access.ts',
    text: 'public, authenticated, or owner — per table, per operation. Row scoping and column guards are enforced server-side, never in the client.',
  },
  {
    key: 'auth' as const,
    name: 'Auth',
    file: 'session.ts',
    text: 'BetterAuth wired to your database. Sign-up, sessions, OAuth providers — /api/auth/* is mounted before you think about it.',
  },
  {
    key: 'files' as const,
    name: 'File storage',
    file: 'upload.ts',
    text: 'Uploads into local or S3 buckets with size and MIME rules, plus sharp image transforms straight from URL params.',
  },
  {
    key: 'realtime' as const,
    name: 'Realtime',
    file: 'live.ts',
    text: 'Broadcast-on-write over SSE. Client collections apply every event live — including filtered views and scoped windows.',
  },
  {
    key: 'inference' as const,
    name: 'Type inference',
    file: 'inference.ts',
    text: 'Clients derive tables and buckets from typeof app. Add a table server-side and the client type-checks it instantly — and what is not exposed simply does not exist.',
  },
]

const EXAMPLES = [
  {
    dir: 'twitter-db-tanstack',
    desc: 'Twitter-style feed on TanStack DB collections — growing-window pagination, live via SSE.',
    cmd: 'bun run dev:twitter-db-tanstack',
  },
  {
    dir: 'tldraw',
    desc: 'Collaborative whiteboard. Canvases and shapes are synced collections; images are bucket uploads.',
    cmd: 'bun run dev:tldraw',
  },
  {
    dir: 'kanban-tanstack',
    desc: 'Realtime kanban on TanStack Start — boards, lists, cards, comments.',
    cmd: 'bun run dev:kanban-tanstack',
  },
  {
    dir: 'kanban-solid-1.9',
    desc: 'The same kanban in Solid 1.9, driven by bunderstack-query and SSE.',
    cmd: 'bun run dev:kanban',
  },
  {
    dir: 'twitter-tanstack',
    desc: 'The Twitter demo on plain TanStack Query — no sync layer, just typed query options.',
    cmd: 'bun run dev:twitter-tanstack',
  },
]

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'Bunderstack — batteries-included backend for Bun' },
      {
        name: 'description',
        content:
          'Point Bunderstack at a Drizzle schema and get CRUD, auth, file storage, and realtime — with clients inferred from your server types.',
      },
    ],
  }),
  component: Landing,
})

function CopyInstall() {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText('bun add bunderstack')
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
      className="group inline-flex items-center gap-3 rounded-md border border-dashed border-[#b9cade] bg-white/70 px-4 py-2.5 font-mono text-sm text-[#1c2430] shadow-[0_1px_0_#e3ecf6] backdrop-blur transition-colors hover:border-[#4a90d9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a90d9]"
      aria-label="Copy install command"
    >
      <span className="select-none text-[#4a90d9]">$</span>
      <span>bun add bunderstack</span>
      <span className="w-8 text-left text-xs text-[#5c6b80] transition-colors group-hover:text-[#4a90d9]">
        {copied ? 'ok ✓' : 'copy'}
      </span>
    </button>
  )
}

function SectionTitle({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string
  title: string
  sub?: string
}) {
  return (
    <div className="mb-10">
      <div className="font-mono text-xs tracking-[0.22em] text-[#4a90d9] uppercase">
        {eyebrow}
      </div>
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[#1c2430] sm:text-4xl">
        {title}
      </h2>
      {sub ? (
        <p className="mt-3 max-w-2xl text-base leading-7 text-[#5c6b80]">
          {sub}
        </p>
      ) : null}
    </div>
  )
}

function CodeCard({
  title,
  html,
  header,
}: {
  title?: string
  html: string
  header?: React.ReactNode
}) {
  return (
    // NOTE: no backdrop-blur here — backdrop-filter creates a stacking
    // context that would trap the twoslash hover popups under sibling cards.
    <div className="snippet min-w-0 flex-1 rounded-lg border border-[#dde5ef] bg-white/95 shadow-[0_18px_40px_-24px_rgba(74,124,180,0.35)]">
      {header ?? (
        <div className="flex items-center gap-2 border-b border-dotted border-[#dde5ef] px-4 py-2.5 font-mono text-xs text-[#5c6b80]">
          {title}
        </div>
      )}
      {/* Generated at build time by scripts/gen-code-snippets.ts (shiki + twoslash) */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function DeclareOnce() {
  const [tab, setTab] = useState<(typeof CLIENT_TABS)[number]['key']>('query')
  const active = CLIENT_TABS.find((t) => t.key === tab)!

  return (
    <section className="pb-24">
      <SectionTitle
        eyebrow="the idea"
        title="Declare once"
        sub="Schema, access rules, storage — one server file. Every client is inferred from its type: no table lists, no codegen, no OpenAPI step. Hover the code — the types are real."
      />
      <div className="flex flex-col gap-5 lg:flex-row">
        <CodeCard title="bunderstack.ts" html={snippets.server} />
        <div
          aria-hidden
          className="hidden items-center font-mono text-xl text-[#9fb6cf] lg:flex"
        >
          →
        </div>
        <CodeCard
          html={snippets[tab]}
          header={
            <div className="flex items-center justify-between border-b border-dotted border-[#dde5ef] px-2 py-1.5">
              <div className="flex gap-1" role="tablist" aria-label="Client package">
                {CLIENT_TABS.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={`rounded px-2.5 py-1 font-mono text-xs whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a90d9] ${
                      tab === t.key
                        ? 'bg-[#eaf2fb] text-[#3b7dc4]'
                        : 'text-[#5c6b80] hover:text-[#3b7dc4]'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <span className="hidden px-2 font-mono text-[11px] text-[#9fb6cf] sm:inline">
                {active.note}
              </span>
            </div>
          }
        />
      </div>
    </section>
  )
}

function Batteries() {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const active = BATTERIES[index]!

  useEffect(() => {
    if (paused) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % BATTERIES.length),
      6500,
    )
    return () => clearInterval(timer)
  }, [paused])

  return (
    <section className="pb-24">
      <SectionTitle
        eyebrow="what you get"
        title="Batteries included"
        sub="Everything a backend needs, from one config object."
      />
      <div
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        <div
          className="mb-5 flex flex-wrap gap-1.5"
          role="tablist"
          aria-label="Features"
        >
          {BATTERIES.map((b, i) => (
            <button
              key={b.key}
              role="tab"
              aria-selected={i === index}
              onClick={() => setIndex(i)}
              className={`rounded-md border px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a90d9] ${
                i === index
                  ? 'border-[#4a90d9] bg-[#eaf2fb] text-[#3b7dc4]'
                  : 'border-[#dde5ef] bg-white/60 text-[#5c6b80] hover:border-[#b9cade] hover:text-[#3b7dc4]'
              }`}
            >
              {b.name}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className="lg:w-[19rem] lg:shrink-0 lg:pt-2">
            <h3 className="text-xl font-semibold text-[#1c2430]">
              {active.name}
            </h3>
            <p className="mt-2 text-sm leading-7 text-[#5c6b80]">
              {active.text}
            </p>
            <div
              aria-hidden
              className="mt-5 flex gap-1.5"
            >
              {BATTERIES.map((b, i) => (
                <span
                  key={b.key}
                  className={`h-1 rounded-full transition-all ${
                    i === index ? 'w-6 bg-[#4a90d9]' : 'w-2 bg-[#c9d6e6]'
                  }`}
                />
              ))}
            </div>
          </div>
          <CodeCard title={active.file} html={snippets[active.key]} />
        </div>
      </div>
    </section>
  )
}

function Landing() {
  return (
    <main className="relative min-h-screen overflow-x-clip bg-[#fbfcfe] text-[#1c2430]">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .cloud-blob-a { animation: cloud-drift-a 46s ease-in-out infinite alternate; }
          .cloud-blob-b { animation: cloud-drift-b 58s ease-in-out infinite alternate; }
          .ascii-cloud { animation: cloud-bob 9s ease-in-out infinite alternate; }
        }
        @keyframes cloud-drift-a { from { transform: translate(0, 0); } to { transform: translate(9rem, 2.5rem); } }
        @keyframes cloud-drift-b { from { transform: translate(0, 0); } to { transform: translate(-11rem, -2rem); } }
        @keyframes cloud-bob { from { transform: translateY(0); } to { transform: translateY(10px); } }

        /* shiki + twoslash, tuned to the page palette */
        /* Mobile-first: wrap long lines instead of scrolling — snippets never
           show scrollbars anywhere. */
        .snippet pre.shiki {
          margin: 0;
          padding: 1rem 1.25rem;
          background: transparent !important;
          font-size: 12px;
          line-height: 1.6;
          overflow: hidden;
          white-space: pre-wrap;
          word-break: break-word;
        }
        /* Desktop with a mouse: lines fit, keep them unwrapped and let hover
           popups overflow the pane freely (no scroll container to clip them). */
        @media (hover: hover) and (min-width: 1024px) {
          .snippet pre.shiki {
            font-size: 13px;
            overflow: visible;
            white-space: pre;
            word-break: normal;
          }
        }
        /* Popups escape the pane; lift the hovered card above its siblings
           so they never hide under a neighboring block. */
        .snippet { position: relative; }
        .snippet:hover { z-index: 50; }
        /* Touch devices get no hover — don't let tap-triggered popups add
           scrollbars there. */
        @media (hover: none) {
          .snippet .twoslash .twoslash-popup-container { display: none; }
        }
        .snippet .twoslash-hover { border-bottom: 1px dotted #b9cade; }
        .snippet {
          --twoslash-border-color: #dde5ef;
          --twoslash-popup-bg: #ffffff;
          --twoslash-popup-shadow: 0 14px 34px -18px rgba(60, 100, 150, 0.45);
          --twoslash-docs-color: #5c6b80;
          --twoslash-underline-color: #4a90d9;
          --twoslash-error-color: #c25454;
          --twoslash-cursor-color: #4a90d9;
        }
        .snippet .twoslash .twoslash-popup-container {
          z-index: 40;
          max-width: min(32rem, 82vw);
          border-radius: 8px;
        }
        .snippet .twoslash .twoslash-popup-code {
          display: block;
          max-height: 18rem;
          overflow-y: auto;
          overflow-x: hidden;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 12px;
        }
        .snippet .twoslash .twoslash-popup-docs {
          font-size: 12px;
          line-height: 1.5;
        }
      `}</style>

      {/* sky */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="cloud-blob-a absolute -top-24 left-[8%] h-96 w-[42rem] rounded-full bg-[#dbeafe] opacity-70 blur-3xl" />
        <div className="cloud-blob-b absolute top-40 right-[-10%] h-80 w-[36rem] rounded-full bg-[#ede9fe] opacity-60 blur-3xl" />
        <div className="cloud-blob-a absolute top-[36rem] left-[-8%] h-72 w-[30rem] rounded-full bg-[#e0f2fe] opacity-60 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage: 'radial-gradient(#c9d6e6 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
      </div>

      <div className="relative mx-auto max-w-5xl px-5 sm:px-8">
        {/* nav */}
        <nav className="flex items-center justify-between py-6 font-mono text-sm">
          <span className="text-[#1c2430]">
            <span className="text-[#5c6b80]">~/</span>bunderstack
          </span>
          <div className="flex items-center gap-6 text-[#5c6b80]">
            <Link
              to="/docs/$"
              params={{ _splat: '' }}
              className="transition-colors hover:text-[#4a90d9]"
            >
              docs
            </Link>
            <a
              href="#examples"
              className="transition-colors hover:text-[#4a90d9]"
            >
              examples
            </a>
            <a
              href={GITHUB}
              className="transition-colors hover:text-[#4a90d9]"
              target="_blank"
              rel="noreferrer"
            >
              github ↗
            </a>
          </div>
        </nav>

        {/* hero */}
        <header className="pt-10 pb-24 text-center sm:pt-14">
          <pre
            aria-hidden
            className="ascii-cloud mx-auto mb-2 inline-block text-left font-mono text-[11px] leading-[1.15] text-[#9fb6cf] select-none sm:text-[13px]"
          >
            {ASCII_CLOUD}
          </pre>
          <h1 className="font-mono text-4xl font-semibold tracking-tight sm:text-5xl">
            bunderstack
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-[#5c6b80] sm:text-lg">
            A batteries-included backend framework for{' '}
            <span className="font-mono text-[#1c2430]">Bun</span>. Point it at
            a Drizzle schema — CRUD, auth, files, and realtime fall out. The
            client is inferred from your server&apos;s types.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4">
            <CopyInstall />
            <div className="flex items-center gap-5 font-mono text-sm">
              <Link
                to="/docs/$"
                params={{ _splat: 'getting-started' }}
                className="rounded-md bg-[#4a90d9] px-4 py-2 text-white shadow-[0_10px_24px_-12px_rgba(74,144,217,0.8)] transition-colors hover:bg-[#3b7dc4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a90d9]"
              >
                read the docs →
              </Link>
              <a
                href="#examples"
                className="text-[#5c6b80] underline decoration-dotted underline-offset-4 transition-colors hover:text-[#4a90d9]"
              >
                browse examples
              </a>
            </div>
          </div>
        </header>

        <DeclareOnce />
        <Batteries />

        {/* examples */}
        <section id="examples" className="pb-24">
          <SectionTitle
            eyebrow="in the repo"
            title="Examples"
            sub="Real apps, each one a directory you can run."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            {EXAMPLES.map((ex) => (
              <a
                key={ex.dir}
                href={`${GITHUB}/tree/main/examples/${ex.dir}`}
                target="_blank"
                rel="noreferrer"
                className="group rounded-lg border border-[#dde5ef] bg-white/80 p-5 shadow-[0_14px_30px_-24px_rgba(74,124,180,0.4)] backdrop-blur transition-all hover:-translate-y-0.5 hover:border-[#4a90d9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4a90d9]"
              >
                <div className="flex items-baseline justify-between font-mono text-sm">
                  <span className="text-[#1c2430]">
                    examples/
                    <span className="font-semibold">{ex.dir}</span>
                  </span>
                  <span className="text-[#9fb6cf] transition-colors group-hover:text-[#4a90d9]">
                    ↗
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-[#5c6b80]">
                  {ex.desc}
                </p>
                <div className="mt-3 font-mono text-xs text-[#8296ad]">
                  <span className="text-[#4a90d9]">$</span> {ex.cmd}
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* footer */}
        <footer className="flex flex-col items-center gap-2 border-t border-dotted border-[#c9d6e6] py-10 font-mono text-xs text-[#8296ad] sm:flex-row sm:justify-between">
          <span>
            <span className="text-[#4a90d9]">#</span> MIT — built on bun ·
            drizzle · better-auth · hono
          </span>
          <a
            href={GITHUB}
            className="transition-colors hover:text-[#4a90d9]"
            target="_blank"
            rel="noreferrer"
          >
            github.com/kirill-dev-pro/bunderstack
          </a>
        </footer>
      </div>
    </main>
  )
}
