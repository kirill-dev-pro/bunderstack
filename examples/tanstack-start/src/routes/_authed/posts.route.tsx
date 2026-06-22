import { Link, Outlet, createFileRoute, useRouter } from '@tanstack/react-router'
import * as React from 'react'
import { createPost, fetchPosts } from '~/utils/posts'
import { useServerFn } from '@tanstack/react-start'
import { useMutation } from '~/hooks/useMutation'

export const Route = createFileRoute('/_authed/posts')({
  loader: () => fetchPosts(),
  component: PostsComponent,
})

function PostsComponent() {
  const posts = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')

  const createMutation = useMutation({
    fn: useServerFn(createPost),
    onSuccess: async () => {
      setTitle('')
      setBody('')
      await router.invalidate()
    },
  })

  return (
    <div className="p-2 flex gap-4">
      {/* Post list */}
      <div className="w-48 shrink-0">
        <div className="font-semibold text-xs uppercase text-gray-400 mb-2">Posts</div>
        {posts.length === 0 ? (
          <p className="text-xs text-gray-400">No posts yet.</p>
        ) : (
          <ul className="space-y-1">
            {posts.map((post) => (
              <li key={post.id}>
                <Link
                  to="/posts/$postId"
                  params={{ postId: String(post.id) }}
                  className="block py-1 text-blue-700 dark:text-blue-400 hover:underline text-sm truncate"
                  activeProps={{ className: 'font-bold text-black dark:text-white' }}
                >
                  {post.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex-1 flex flex-col gap-4">
        {/* Create post form — showcases Bunderstack CRUD */}
        <form
          className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!title.trim()) return
            createMutation.mutate({ data: { title, body, userId: user!.id } })
          }}
        >
          <div className="text-xs font-semibold uppercase text-gray-400 mb-1">New post via Bunderstack CRUD</div>
          <input
            className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-transparent"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-transparent"
            placeholder="Body (optional)"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button
            type="submit"
            disabled={createMutation.status === 'pending' || !title.trim()}
            className="bg-cyan-600 text-white px-3 py-1 rounded text-sm font-semibold disabled:opacity-50"
          >
            {createMutation.status === 'pending' ? 'Creating…' : 'Create post'}
          </button>
        </form>

        <Outlet />
      </div>
    </div>
  )
}
