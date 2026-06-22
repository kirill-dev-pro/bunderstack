import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/posts/')({
  component: () => <div className="text-gray-400 text-sm">Select a post or create one above.</div>,
})
