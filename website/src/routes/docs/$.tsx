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

// The JSON is produced by fumadocs-core's own serializePageTree (see the
// generator script), so this assertion restores the type the JSON import
// can't carry.
const manifest = manifestJson as unknown as {
  pageTree: SerializedPageTree
  paths: Record<string, string>
}

const paths = manifest.paths

export const Route = createFileRoute('/docs/$')({
  component: Page,
  loader: async ({ params }) => {
    const slug = params._splat ?? ''
    const path = paths[slug]
    if (!path) throw notFound()
    await clientLoader.preload(path)
    return { path, pageTree: manifest.pageTree }
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
