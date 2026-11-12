import * as React from 'react'

import { Button } from '~/components/ui/button'
import { authClient } from '~/lib/auth-client'

type Provider = { id: string; label: string }

/**
 * Google, GitHub and other providers the host connects for this app. On
 * Bunderhost they are switched on in the project's Auth settings, with no
 * OAuth client of your own; anywhere else the list is empty and nothing shows.
 */
export function ManagedSignIn({ callbackURL }: { callbackURL: string }) {
  const [providers, setProviders] = React.useState<Provider[]>([])

  React.useEffect(() => {
    authClient.managed
      .providers()
      .then((discovery) =>
        setProviders(discovery.state === 'ready' ? discovery.providers : []),
      )
      .catch(() => setProviders([]))
  }, [])

  if (providers.length === 0) return null
  return (
    <div className="mb-4 flex flex-col gap-2">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="secondary"
          className="h-10 w-full font-medium"
          onClick={() =>
            void authClient.signIn.managed({
              provider: provider.id,
              callbackURL,
            })
          }
        >
          Continue with {provider.label}
        </Button>
      ))}
      <p className="text-center text-xs text-[#17211B]/50">or with email</p>
    </div>
  )
}
