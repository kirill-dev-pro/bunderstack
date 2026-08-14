import { Link } from '@tanstack/react-router'

export function NotFound({ children }: { children?: React.ReactNode }) {
  return (
    <div className="space-y-2 p-2">
      <div className="text-gray-600 dark:text-gray-400">
        {children ?? <p>The page you are looking for does not exist.</p>}
      </div>
      <p className="gap-2 flex flex-wrap items-center">
        <button
          onClick={() => window.history.back()}
          className="bg-emerald-500 text-white px-2 py-1 rounded-sm font-black text-sm uppercase"
        >
          Go back
        </button>
        <Link
          to="/"
          search={{ tab: 'for-you' }}
          className="bg-cyan-600 text-white px-2 py-1 rounded-sm font-black text-sm uppercase"
        >
          Start Over
        </Link>
      </p>
    </div>
  )
}
