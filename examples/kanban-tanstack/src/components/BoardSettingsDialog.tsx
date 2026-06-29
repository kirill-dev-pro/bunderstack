import { useEffect, useRef } from 'react'

import type { InferSelect } from 'bunderstack-query'

import type * as schema from '~/schema'

import { ActivityList } from '~/components/ActivityList'
import { UserAvatar } from '~/components/UserAvatar'

type Board = InferSelect<typeof schema.boards>
type List = InferSelect<typeof schema.lists>
type User = InferSelect<typeof schema.user>

type Member = {
  userId: User['id']
  user?: { name?: string }
}

type BoardSettingsDialogProps = {
  open: boolean
  onClose: () => void
  boardId: Board['id']
  boardTitle: string
  userNames: Record<string, string>
  members: Member[]
  listNames: Record<List['id'], string>
}

export function BoardSettingsDialog({
  open,
  onClose,
  boardId,
  boardTitle,
  userNames,
  members,
  listNames,
}: BoardSettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open) {
      if (!el.open) el.showModal()
    } else if (el.open) {
      el.close()
    }
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className="board-settings-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      <div className="board-settings-dialog-inner">
        <header className="card-dialog-header">
          <div>
            <h2>Board settings</h2>
            <p className="board-settings-subtitle">{boardTitle}</p>
          </div>
          <button type="button" className="outline" onClick={onClose}>
            Close
          </button>
        </header>

        <section className="card-dialog-section">
          <label>Members</label>
          <ul className="board-settings-members">
            {members.map((m) => (
              <li key={m.userId}>
                <UserAvatar
                  name={m.user?.name ?? userNames[m.userId] ?? '?'}
                  size={28}
                />
                <span>{m.user?.name ?? userNames[m.userId] ?? m.userId}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="card-dialog-section">
          <label>Activity</label>
          <ActivityList
            boardId={boardId}
            userNames={userNames}
            listNames={listNames}
            limit={100}
            enabled={open}
          />
        </section>
      </div>
    </dialog>
  )
}
