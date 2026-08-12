import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: 'bunderstack / docs' },
    links: [
      { text: 'Start', url: '/docs/getting-started' },
      { text: 'API procedures', url: '/docs/api-procedures' },
      { text: 'GitHub', url: 'https://github.com/kirill-dev-pro/bunderstack' },
    ],
  }
}
