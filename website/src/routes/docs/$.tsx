import { createFileRoute, notFound } from '@tanstack/react-router'
import browserCollections from 'collections/browser'
import {
  useFumadocsLoader,
  type SerializedPageTree,
} from 'fumadocs-core/source/client'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page'
import { Suspense, useMemo } from 'react'

import { useMDXComponents } from '@/components/mdx'
// Build-time page tree + slug→file map (scripts/gen-docs-manifest.ts). Keeping
// the loader pure means navigation never calls a server function — required
// for static hosting (GitHub Pages), where /_serverFn/* RPCs would 404.
import manifestJson from '@/lib/docs-manifest.gen.json'
import { baseOptions } from '@/lib/layout.shared'
import { OG_IMAGE, SITE_NAME, SITE_URL } from '@/lib/site'

// The JSON is produced by fumadocs-core's own serializePageTree (see the
// generator script), so this assertion restores the type the JSON import
// can't carry.
const manifest = manifestJson as unknown as {
  pageTree: SerializedPageTree
  paths: Record<string, string>
  pagesMeta?: Record<string, { title: string; description: string }>
}

const paths = manifest.paths
const pagesMeta = manifest.pagesMeta ?? {}

/**
 * TechArticle + breadcrumbs per docs page. Search engines use the breadcrumb
 * trail in the result snippet, and the article node ties each page back to the
 * site-wide entities declared in __root.tsx.
 */
function docsStructuredData(
  slug: string,
  pageMeta: { title: string; description: string },
  canonicalUrl: string,
) {
  const trail = [
    { name: 'Home', item: `${SITE_URL}/` },
    { name: 'Docs', item: `${SITE_URL}/docs` },
    ...(slug ? [{ name: pageMeta.title, item: canonicalUrl }] : []),
  ]

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${canonicalUrl}#article`,
        headline: pageMeta.title,
        description: pageMeta.description,
        url: canonicalUrl,
        inLanguage: 'en',
        image: OG_IMAGE.url,
        isPartOf: { '@id': `${SITE_URL}/#website` },
        about: { '@id': `${SITE_URL}/#software` },
        publisher: { '@id': `${SITE_URL}/#organization` },
        proficiencyLevel: 'Beginner',
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonicalUrl}#breadcrumb`,
        itemListElement: trail.map((entry, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: entry.name,
          item: entry.item,
        })),
      },
    ],
  }
}

export const Route = createFileRoute('/docs/$')({
  component: Page,
  loader: async ({ params }) => {
    const slug = params._splat ?? ''
    const path = paths[slug]
    if (!path) throw notFound()
    await clientLoader.preload(path)
    const pageMeta = pagesMeta[slug] ?? {
      title: 'Documentation',
      description: 'bunderstack documentation',
    }
    return { path, pageTree: manifest.pageTree, pageMeta }
  },
  head: ({ loaderData, params }) => {
    const slug = params?._splat ?? ''
    const pageMeta =
      loaderData?.pageMeta ??
      pagesMeta[slug] ?? {
        title: 'Documentation',
        description: 'bunderstack documentation',
      }
    const pageTitle = `${pageMeta.title} — ${SITE_NAME}`
    const canonicalUrl = slug
      ? `${SITE_URL}/docs/${slug}`
      : `${SITE_URL}/docs`

    return {
      meta: [
        { title: pageTitle },
        { name: 'description', content: pageMeta.description },
        { property: 'og:title', content: pageTitle },
        { property: 'og:description', content: pageMeta.description },
        { property: 'og:url', content: canonicalUrl },
        { property: 'og:type', content: 'article' },
        { property: 'article:section', content: 'Documentation' },
        { name: 'twitter:title', content: pageTitle },
        { name: 'twitter:description', content: pageMeta.description },
      ],
      links: [{ rel: 'canonical', href: canonicalUrl }],
      scripts: [
        {
          type: 'application/ld+json',
          children: JSON.stringify(docsStructuredData(slug, pageMeta, canonicalUrl)),
        },
      ],
    }
  },
})

const clientLoader = browserCollections.docs.createClientLoader({
  component({ toc, frontmatter, default: MDX }, _props: undefined) {
    return (
      <DocsPage toc={toc}>
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    )
  },
})

function Page() {
  const serialized = Route.useLoaderData()
  // Fumadocs deserializes page names into React elements in place. Clone the
  // input so TanStack Router can still serialize its original loader data
  // after SSR rendering during prerender.
  const deserializationCopy = useMemo(
    () => structuredClone(serialized),
    [serialized],
  )
  const data = useFumadocsLoader(deserializationCopy)

  return (
    <DocsLayout {...baseOptions()} tree={data.pageTree}>
      <Suspense>{clientLoader.useContent(data.path)}</Suspense>
    </DocsLayout>
  )
}
