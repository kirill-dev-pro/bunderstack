import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

export function baseOptions(): BaseLayoutProps {
  return {
    themeSwitch: {
      mode: 'full',
    },
    nav: {
      title: (
        <span className="flex items-center gap-2 font-bold tracking-tight">
          <img
            src="/logo-192.webp"
            alt="bunderstack"
            className="w-5 h-5 rounded object-contain"
            width={20}
            height={20}
          />
          bunderstack
          <span className="text-muted-foreground text-xs font-normal">
            / docs
          </span>
        </span>
      ),
    },
    links: [
      { text: 'Start', url: '/docs/getting-started' },
      { text: 'API procedures', url: '/docs/api-procedures' },
      { text: 'GitHub', url: 'https://github.com/kirill-dev-pro/bunderstack' },
    ],
  }
}
