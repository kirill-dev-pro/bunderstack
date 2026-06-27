import type { InferSelect } from 'bunderstack-query'

import { useQuery } from '@tanstack/react-query'

import type * as schema from '~/schema'

import { api } from '~/api-client'

type Activity = InferSelect<typeof schema.activity>

type ActivityContext = {
  cardScope: boolean
  userNames: Record<string, string>
  listNames?: Record<string, string>
}

function listLabel(
  data: Activity['data'],
  listNames?: Record<string, string>,
): string | null {
  if (!data || typeof data !== 'object' || !('listId' in data)) return null
  const listId = (data as { listId?: string }).listId
  if (!listId) return null
  return listNames?.[listId] ?? null
}

export function formatActivity(item: Activity, ctx: ActivityContext): string {
  const actor = item.actorId
    ? (ctx.userNames[item.actorId] ?? 'Someone')
    : 'Someone'
  const list = listLabel(item.data, ctx.listNames)

  if (item.type === 'moved') {
    if (ctx.cardScope) {
      return list
        ? `${actor} moved this card to ${list}`
        : `${actor} moved this card`
    }
    return list ? `${actor} moved a card to ${list}` : `${actor} moved a card`
  }

  if (item.type === 'commented') {
    return ctx.cardScope ? `${actor} commented` : `${actor} commented on a card`
  }

  if (item.type === 'assigned') {
    const assigneeId =
      item.data && typeof item.data === 'object' && 'assigneeId' in item.data
        ? (item.data as { assigneeId?: string | null }).assigneeId
        : null
    if (!assigneeId) return `${actor} unassigned this card`
    const name = ctx.userNames[assigneeId] ?? 'someone'
    return `${actor} assigned this card to ${name}`
  }

  if (item.type === 'updated') {
    return `${actor} updated the description`
  }

  return `${actor} updated the board`
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function relativeTime(date: Date | string | null | undefined) {
  const d = toDate(date)
  if (!d) return ''
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

type ActivityListProps = {
  boardId?: string
  cardId?: string
  userNames: Record<string, string>
  listNames?: Record<string, string>
  limit?: number
  emptyLabel?: string
  enabled?: boolean
}

export function ActivityList({
  boardId,
  cardId,
  userNames,
  listNames,
  limit = 30,
  emptyLabel = 'No activity yet.',
  enabled = true,
}: ActivityListProps) {
  const params: Record<string, string | number> = {
    limit,
    sort: 'createdAt',
    order: 'desc',
  }
  if (boardId) params.boardId = boardId
  if (cardId) params.cardId = cardId

  const { data, isLoading } = useQuery({
    ...api.activity.listQuery(params),
    enabled: enabled && !!(boardId || cardId),
  })

  if (isLoading) {
    return (
      <div>
        <div
          className="skeleton"
          style={{ height: '3rem', marginBottom: '0.5rem' }}
        />
        <div
          className="skeleton"
          style={{ height: '3rem', marginBottom: '0.5rem' }}
        />
        <div className="skeleton" style={{ height: '3rem' }} />
      </div>
    )
  }

  const items = data?.items ?? []
  if (!items.length) {
    return (
      <p style={{ fontSize: '0.8rem', color: 'var(--oat-muted)' }}>
        {emptyLabel}
      </p>
    )
  }

  const cardScope = !!cardId

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {items.map((item) => (
        <li key={item.id} className="activity-item">
          <div>
            <div>
              {formatActivity(item, { cardScope, userNames, listNames })}
            </div>
            <time dateTime={toDate(item.createdAt)?.toISOString()}>
              {relativeTime(item.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ul>
  )
}
