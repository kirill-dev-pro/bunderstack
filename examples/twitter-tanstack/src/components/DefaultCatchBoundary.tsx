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
    <div className="min-w-0 p-4 gap-6 flex flex-1 flex-col items-center justify-center">
      <ErrorComponent error={error} />
      <div className="gap-2 flex flex-wrap items-center">
        <button
          onClick={() => router.invalidate()}
          className="px-2 py-1 bg-gray-600 dark:bg-gray-700 rounded-sm text-white font-extrabold uppercase"
        >
          Try Again
        </button>
        {isRoot ? (
          <Link
            to="/"
            search={{ tab: 'for-you' }}
            className="px-2 py-1 bg-gray-600 dark:bg-gray-700 rounded-sm text-white font-extrabold uppercase"
          >
            Home
          </Link>
        ) : (
          <Link
            to="/"
            search={{ tab: 'for-you' }}
            className="px-2 py-1 bg-gray-600 dark:bg-gray-700 rounded-sm text-white font-extrabold uppercase"
            onClick={(e) => {
              e.preventDefault()
              window.history.back()
            }}
          >
            Go Back
          </Link>
        )}
      </div>
    </div>
  )
}
