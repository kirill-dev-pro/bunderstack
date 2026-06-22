import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: { title: 'Bunderstack' },
    links: [
      { text: 'Documentation', url: '/docs' },
      { text: 'GitHub', url: 'https://github.com/bunderstack/bunderstack' },
    ],
  }
}
