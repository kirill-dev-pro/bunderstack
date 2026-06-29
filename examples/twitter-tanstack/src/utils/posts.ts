import type { InferSelect } from 'bunderstack-query'

import type { likes, posts, retweets } from '~/schema'

export type Post = InferSelect<typeof posts>
export type Like = InferSelect<typeof likes>
export type Retweet = InferSelect<typeof retweets>

export function countReplies(postId: Post['id'], all: Post[]) {
  return all.filter((p) => p.replyToId === postId).length
}

export function handleFromEmail(email: string) {
  return email.split('@')[0] ?? email
}
