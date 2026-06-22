import { ErrorComponent, createFileRoute, useRouter } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { NotFound } from '~/components/NotFound'
import { deletePost, fetchPost } from '~/utils/posts'
import { useMutation } from '~/hooks/useMutation'

export const Route = createFileRoute('/_authed/posts/$postId')({
  loader: ({ params: { postId } }) => fetchPost({ data: Number(postId) }),
  errorComponent: PostErrorComponent,
  notFoundComponent: () => <NotFound>Post not found</NotFound>,
  component: PostComponent,
})

export function PostErrorComponent({ error }: ErrorComponentProps) {
  return <ErrorComponent error={error} />
}

function PostComponent() {
  const post = Route.useLoaderData()
  const router = useRouter()

  const deleteMutation = useMutation({
    fn: useServerFn(deletePost),
    onSuccess: async () => {
      await router.invalidate()
      router.navigate({ to: '/posts' })
    },
  })

  return (
    <div className="space-y-3">
      <h4 className="text-xl font-bold">{post.title}</h4>
      {post.body && <p className="text-sm text-gray-600 dark:text-gray-400">{post.body}</p>}
      <p className="text-xs text-gray-400">
        Created {new Date(post.createdAt).toLocaleString()}
      </p>
      <button
        onClick={() => deleteMutation.mutate({ data: post.id })}
        disabled={deleteMutation.status === 'pending'}
        className="text-red-500 text-xs hover:underline disabled:opacity-50"
      >
        {deleteMutation.status === 'pending' ? 'Deleting…' : 'Delete post'}
      </button>
    </div>
  )
}
