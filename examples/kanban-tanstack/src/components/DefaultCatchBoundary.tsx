import type { ErrorComponentProps } from '@tanstack/react-router'

import {
  ErrorComponent,
  Link,
  useLocation,
  useRouter,
} from '@tanstack/react-router'

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  const router = useRouter()
  const isRoot = useLocation({ select: (l) => l.pathname === '/' })

  console.error(error)

  return (
    <div className="error-boundary">
      <ErrorComponent error={error} />
      <div className="error-boundary-actions">
        <button type="button" onClick={() => router.invalidate()}>
          Try again
        </button>
        {isRoot ? (
          <Link to="/">Home</Link>
        ) : (
          <button type="button" onClick={() => window.history.back()}>
            Go back
          </button>
        )}
      </div>
    </div>
  )
}
