import type { InferSelect } from 'bunderstack-query'

import type { posts } from '~/schema'

export type Post = InferSelect<typeof posts>

export function countReplies(postId: number, all: Post[]) {
  return all.filter((p) => p.replyToId === postId).length
}

export function handleFromEmail(email: string) {
  return email.split('@')[0] ?? email
}
