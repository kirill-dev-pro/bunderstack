import type { InferSelect } from 'bunderstack-query'

import { useMemo, useState } from 'react'

import type * as schema from '~/schema'

import { api } from '~/api-client'
import { useToastMutation } from '~/hooks/useToastMutation'

import { EmojiPicker } from './EmojiPicker'

type Reaction = InferSelect<typeof schema.reactions>

export type ReactionTarget = {
  targetType: 'card' | 'comment'
  targetId: string
}

type ReactionBarProps = {
  target: ReactionTarget
  reactions: Reaction[]
  currentUserId: Reaction['userId']
  compact?: boolean
  onReact?: (emoji: string) => void
}

export function groupReactions(
  reactions: Reaction[],
  target: ReactionTarget,
  currentUserId?: Reaction['userId'] | null,
) {
  const filtered = reactions.filter(
    (r) => r.targetType === target.targetType && r.targetId === target.targetId,
  )
  const groups = new Map<
    string,
    { emoji: string; count: number; mine: boolean; myReactionId?: string }
  >()
  for (const r of filtered) {
    const existing = groups.get(r.emoji)
    if (existing) {
      existing.count++
      if (currentUserId && r.userId === currentUserId) {
        existing.mine = true
        existing.myReactionId = r.id
      }
    } else {
      groups.set(r.emoji, {
        emoji: r.emoji,
        count: 1,
        mine: currentUserId ? r.userId === currentUserId : false,
        myReactionId:
          currentUserId && r.userId === currentUserId ? r.id : undefined,
      })
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

export function ReactionBar({
  target,
  reactions,
  currentUserId,
  compact = false,
  onReact,
}: ReactionBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const groups = useMemo(
    () => groupReactions(reactions, target, currentUserId),
    [reactions, target, currentUserId],
  )

  const createReaction = useToastMutation(api.reactions.createMutation())
  const deleteReaction = useToastMutation(api.reactions.deleteMutation())

  function toggle(emoji: string, mine: boolean, myReactionId?: string) {
    if (mine && myReactionId) {
      deleteReaction.mutate(myReactionId)
    } else {
      createReaction.mutate(
        {
          targetType: target.targetType,
          targetId: target.targetId,
          emoji,
          userId: currentUserId,
        },
        { onSuccess: () => onReact?.(emoji) },
      )
    }
  }

  return (
    <div className={`reaction-bar${compact ? ' reaction-bar--compact' : ''}`}>
      {groups.map((g) => (
        <button
          key={g.emoji}
          type="button"
          className={`reaction-pill${g.mine ? ' reaction-pill--mine' : ''}`}
          onClick={() => toggle(g.emoji, g.mine, g.myReactionId)}
          disabled={createReaction.isPending || deleteReaction.isPending}
        >
          <span>{g.emoji}</span>
          <span className="reaction-count">{g.count}</span>
        </button>
      ))}
      <div className="reaction-picker-wrap">
        <button
          type="button"
          className="reaction-add-btn"
          aria-label="Add reaction"
          onClick={() => setPickerOpen((v) => !v)}
        >
          +
        </button>
        {pickerOpen ? (
          <EmojiPicker
            onSelect={(emoji) => toggle(emoji, false)}
            onClose={() => setPickerOpen(false)}
          />
        ) : null}
      </div>
    </div>
  )
}

export function reactionSummary(
  reactions: Reaction[],
  target: ReactionTarget,
  maxEmojis = 2,
) {
  const groups = groupReactions(reactions, target)
  const top = groups.slice(0, maxEmojis)
  const total = groups.reduce((sum, g) => sum + g.count, 0)
  return { top, total }
}
