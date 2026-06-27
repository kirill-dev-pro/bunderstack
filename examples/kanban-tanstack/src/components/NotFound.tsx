import { Link } from '@tanstack/react-router'

export function NotFound({ children }: { children?: React.ReactNode }) {
  return (
    <div className="not-found">
      <div>
        {children ?? <p>The page you are looking for does not exist.</p>}
      </div>
      <p className="not-found-actions">
        <button type="button" onClick={() => window.history.back()}>
          Go back
        </button>
        <Link to="/">Boards</Link>
      </p>
    </div>
  )
}
