import { createFileRoute, notFound } from '@tanstack/react-router'
import browserCollections from 'collections/browser'
import { useFumadocsLoader } from 'fumadocs-core/source/client'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page'
import { Suspense } from 'react'

import { useMDXComponents } from '@/components/mdx'
import { baseOptions } from '@/lib/layout.shared'
// Build-time page tree + slug→file map (scripts/gen-docs-manifest.ts). Keeping
// the loader pure means navigation never calls a server function — required
// for static hosting (GitHub Pages), where /_serverFn/* RPCs would 404.
import manifest from '@/lib/docs-manifest.gen.json'

const paths = manifest.paths as Record<string, string>

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
  const data = useFumadocsLoader(Route.useLoaderData())

  return (
    <DocsLayout {...baseOptions()} tree={data.pageTree}>
      <Suspense>{clientLoader.useContent(data.path)}</Suspense>
    </DocsLayout>
  )
}
