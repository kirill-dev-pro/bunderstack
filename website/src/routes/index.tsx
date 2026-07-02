import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

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

const SERVER_CODE = [
  { c: '// the whole backend' },
  { t: "import { createBunderstack } from 'bunderstack'" },
  { t: "import * as schema from './schema'" },
  { t: '' },
  { t: 'export const app = createBunderstack({' },
  { t: '  schema,' },
  { t: "  access: { posts: { ownerColumn: 'userId' } }," },
  { t: "  storage: { local: './uploads', buckets: { images: {} } }," },
  { t: '  realtime: true,' },
  { t: '})' },
  { t: '' },
  { t: 'export type App = typeof app' },
]

const CLIENT_CODE = [
  { c: '// nothing to configure' },
  { t: "import { createClient } from 'bunderstack-query'" },
  { t: "import type { App } from './bunderstack'" },
  { t: '' },
  { t: 'const api = createClient<App>({ queryClient })' },
  { t: '' },
  { t: 'api.posts.list({ limit: 20 })', c: '// typed rows' },
  { t: 'api.posts.create({ title })', c: '// owner from session' },
  { t: 'api.files.images.upload(file)', c: '// bucket inferred' },
]

const FEATURES = [
  {
    name: 'crud',
    text: 'GET/POST/PATCH/DELETE for every table in your Drizzle schema, mounted at /api. No route files.',
  },
  {
    name: 'access',
    text: 'public / authenticated / owner rules per operation, plus row scoping — enforced server-side.',
  },
  {
    name: 'auth',
    text: 'BetterAuth wired to your database. Sign-up, sessions, OAuth — /api/auth/* just exists.',
  },
  {
    name: 'files',
    text: 'Uploads into local or S3 buckets, with sharp image transforms via query params.',
  },
  {
    name: 'realtime',
    text: 'Broadcast-on-write over SSE. Collections on the client stay live without extra wiring.',
  },
  {
    name: 'inference',
    text: 'Clients derive tables and buckets from typeof app. Add a table, the client type-checks it.',
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

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-8 flex items-baseline gap-3 font-mono text-sm text-[#5c6b80]">
      <span className="text-[#4a90d9]">#</span>
      <span>{children}</span>
      <span
        aria-hidden
        className="flex-1 border-b border-dotted border-[#c9d6e6]"
      />
    </div>
  )
}

function CodePane({
  title,
  lines,
}: {
  title: string
  lines: { t?: string; c?: string }[]
}) {
  return (
    <div className="min-w-0 flex-1 rounded-lg border border-[#dde5ef] bg-white/80 shadow-[0_18px_40px_-24px_rgba(74,124,180,0.35)] backdrop-blur">
      <div className="flex items-center gap-2 border-b border-dotted border-[#dde5ef] px-4 py-2.5 font-mono text-xs text-[#5c6b80]">
        <span aria-hidden className="text-[#b9cade]">
          ┌─
        </span>
        {title}
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-[#1c2430]">
        {lines.map((line, i) => (
          <div key={i}>
            {line.t}
            {line.c ? (
              <span className="text-[#8296ad]">
                {line.t ? '  ' : ''}
                {line.c}
              </span>
            ) : null}
            {!line.t && !line.c ? ' ' : ''}
          </div>
        ))}
      </pre>
    </div>
  )
}

function Landing() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#fbfcfe] text-[#1c2430]">
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .cloud-blob-a { animation: cloud-drift-a 46s ease-in-out infinite alternate; }
          .cloud-blob-b { animation: cloud-drift-b 58s ease-in-out infinite alternate; }
          .ascii-cloud { animation: cloud-bob 9s ease-in-out infinite alternate; }
        }
        @keyframes cloud-drift-a { from { transform: translate(0, 0); } to { transform: translate(9rem, 2.5rem); } }
        @keyframes cloud-drift-b { from { transform: translate(0, 0); } to { transform: translate(-11rem, -2rem); } }
        @keyframes cloud-bob { from { transform: translateY(0); } to { transform: translateY(10px); } }
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
        <header className="pt-10 pb-20 text-center sm:pt-14">
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

        {/* declare once */}
        <section className="pb-20">
          <SectionLabel>
            declare once — everything else is inferred
          </SectionLabel>
          <div className="flex flex-col gap-5 lg:flex-row">
            <CodePane title="bunderstack.ts" lines={SERVER_CODE} />
            <div
              aria-hidden
              className="hidden items-center font-mono text-xl text-[#9fb6cf] lg:flex"
            >
              →
            </div>
            <CodePane title="api-client.ts" lines={CLIENT_CODE} />
          </div>
          <p className="mt-5 text-center font-mono text-xs text-[#8296ad]">
            no table lists, no generated code, no OpenAPI step — the app type
            carries it all
          </p>
        </section>

        {/* batteries */}
        <section className="pb-20">
          <SectionLabel>batteries included</SectionLabel>
          <div className="grid gap-px overflow-hidden rounded-lg border border-dotted border-[#c9d6e6] bg-[#c9d6e6]/40 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.name} className="bg-[#fbfcfe]/95 p-5">
                <div className="font-mono text-sm text-[#4a90d9]">
                  --{f.name}
                </div>
                <p className="mt-2 text-sm leading-6 text-[#5c6b80]">
                  {f.text}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* examples */}
        <section id="examples" className="pb-20">
          <SectionLabel>examples — real apps in the repo</SectionLabel>
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
