import type { InferSelect } from 'bunderstack-query'

import type { posts } from '~/schema'

export type Post = InferSelect<typeof posts>

export function isTopLevel(post: Post) {
  return post.replyToId == null
}

export function countReplies(postId: number, all: Post[]) {
  return all.filter((p) => p.replyToId === postId).length
}

/** All descendants of a root post, chronological. */
export function getThreadReplies(rootId: number, all: Post[]) {
  const byParent = new Map<number, Post[]>()
  for (const post of all) {
    if (post.replyToId == null) continue
    const list = byParent.get(post.replyToId) ?? []
    list.push(post)
    byParent.set(post.replyToId, list)
  }

  const out: Post[] = []
  const queue = [...(byParent.get(rootId) ?? [])]
  while (queue.length) {
    const post = queue.shift()!
    out.push(post)
    queue.push(...(byParent.get(post.id) ?? []))
  }

  return out.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
}

export function handleFromEmail(email: string) {
  return email.split('@')[0] ?? email
}
