import * as React from 'react'

type LoadMoreProps = {
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  label?: string
}

export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  label = 'Load more',
}: LoadMoreProps) {
  const sentinelRef = React.useRef<HTMLDivElement>(null)
  // Read the latest loading/onLoadMore from a ref so the observer doesn't
  // need to be torn down and recreated on every render (onLoadMore is
  // typically a fresh arrow function each render at the call site).
  const latest = React.useRef({ loading, onLoadMore })
  latest.current = { loading, onLoadMore }

  React.useEffect(() => {
    if (!hasMore) return
    const node = sentinelRef.current
    if (!node) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !latest.current.loading) {
          latest.current.onLoadMore()
        }
      },
      // Fire while the sentinel is still ~400px below the viewport so the
      // next page is ready before the user actually scrolls into it.
      { rootMargin: '400px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore])

  if (!hasMore) return null

  return (
    <div className="load-more" ref={sentinelRef}>
      <button type="button" onClick={onLoadMore} disabled={loading}>
        {loading ? 'Loading…' : label}
      </button>
    </div>
  )
}
