import {
  ClientOnly,
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { Provider } from '@/components/provider'
import appCss from '@/styles/app.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#050608' },
      {
        name: 'description',
        content:
          'Your whole backend as a single file declaration. Database, auth, CRUD, storage, jobs, email, and realtime are keys on one object.',
      },
      {
        name: 'keywords',
        content:
          'bun, backend framework, typescript, drizzle orm, better auth, orpc, rest api, s3, realtime, background jobs, sqlite, libsql, postgres, standard schema',
      },
      { name: 'author', content: 'bunderstack' },
      {
        name: 'robots',
        content:
          'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
      },
      // Open Graph
      { property: 'og:site_name', content: 'bunderstack' },
      { property: 'og:type', content: 'website' },
      { property: 'og:locale', content: 'en_US' },
      {
        property: 'og:title',
        content:
          'bunderstack — Your whole backend as a single file declaration.',
      },
      {
        property: 'og:description',
        content:
          'Database, auth, CRUD, storage, jobs, email, and realtime are keys on one object, and bun run dev starts all of it.',
      },
      { property: 'og:image', content: 'https://bunderstack.dev/og.webp' },
      { property: 'og:image:type', content: 'image/webp' },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: 'bunderstack webpage preview' },
      // Twitter Card
      { name: 'twitter:card', content: 'summary_large_image' },
      {
        name: 'twitter:title',
        content:
          'bunderstack — Your whole backend as a single file declaration.',
      },
      {
        name: 'twitter:description',
        content:
          'Database, auth, CRUD, storage, jobs, email, and realtime are keys on one object, and bun run dev starts all of it.',
      },
      { name: 'twitter:image', content: 'https://bunderstack.dev/og.webp' },
    ],
    links: [
      { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/favicon-32x32.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '16x16',
        href: '/favicon-16x16.png',
      },
      {
        rel: 'apple-touch-icon',
        sizes: '180x180',
        href: '/apple-touch-icon.png',
      },
      {
        rel: 'alternate',
        type: 'text/plain',
        href: '/llms.txt',
        title: 'LLM Documentation',
      },
      { rel: 'sitemap', type: 'application/xml', href: '/sitemap.xml' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  component: RootComponent,
})

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': 'https://bunderstack.dev/#website',
      url: 'https://bunderstack.dev',
      name: 'bunderstack',
      description:
        'Your whole backend as a single file declaration. Batteries-included backend framework for Bun.',
      publisher: {
        '@type': 'Organization',
        name: 'bunderstack',
        url: 'https://bunderstack.dev',
        logo: {
          '@type': 'ImageObject',
          url: 'https://bunderstack.dev/logo-1024.webp',
        },
      },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': 'https://bunderstack.dev/#software',
      name: 'bunderstack',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      offers: {
        '@type': 'Offer',
        price: '0',
        priceCurrency: 'USD',
      },
      description:
        'Batteries-included backend framework for Bun: Drizzle + BetterAuth + oRPC + S3 + Jobs + Realtime in a single file declaration.',
      url: 'https://bunderstack.dev',
      license: 'https://opensource.org/licenses/MIT',
    },
  ],
}

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData),
          }}
        />
      </head>
      <body className="flex min-h-screen flex-col">
        <Provider>{children}</Provider>
        <Scripts />
        <ClientOnly>
          <TanStackRouterDevtools />
        </ClientOnly>
      </body>
    </html>
  )
}
