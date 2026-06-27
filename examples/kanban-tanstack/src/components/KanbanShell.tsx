import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'

import { OrgSwitcher } from '~/components/OrgSwitcher'
import { UserAvatar } from '~/components/UserAvatar'

type KanbanShellProps = {
  user: {
    id: string
    email: string
    name: string
    image?: string | null
  }
  children: ReactNode
  boardTitle?: string
}

export function KanbanShell({ user, children, boardTitle }: KanbanShellProps) {
  return (
    <div className="kanban-layout">
      <header className="kanban-header">
        <div className="kanban-header-inner">
          <Link to="/" className="kanban-brand">
            <span className="kanban-brand-mark">K</span>
            Kanban
          </Link>

          {boardTitle ? (
            <nav className="kanban-breadcrumb" aria-label="Breadcrumb">
              <Link to="/">Boards</Link>
              <span aria-hidden>/</span>
              <span>{boardTitle}</span>
            </nav>
          ) : null}

          <div className="kanban-header-actions">
            <OrgSwitcher />
            <Link to="/org/settings" className="kanban-workspace-link">
              Workspace
            </Link>
            <UserAvatar name={user.name} image={user.image} size={32} />
            <Link to="/logout">Log out</Link>
          </div>
        </div>
      </header>
      <main className="kanban-main">{children}</main>
    </div>
  )
}
