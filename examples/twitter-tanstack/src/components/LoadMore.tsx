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
  if (!hasMore) return null

  return (
    <div className="load-more">
      <button type="button" onClick={onLoadMore} disabled={loading}>
        {loading ? 'Loading…' : label}
      </button>
    </div>
  )
}
