import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ApprovalPanel } from './ApprovalPanel'

test('approval panel exposes exact pending choices and active grant revocation', () => {
  const html = renderToStaticMarkup(
    <ApprovalPanel
      requests={[
        {
          id: 'arequest_one',
          tool: 'deleteTask',
          toolVersion: 1,
          args: { taskId: 'task_one' },
          prompt: 'Allow deleteTask?',
        },
      ]}
      grants={[
        {
          id: 'agrant_one',
          tool: 'deleteTask',
          toolVersion: 1,
          grantedAt: new Date('2026-08-26T10:00:00.000Z'),
          lastUsedAt: null,
        },
      ]}
      pending={false}
      onResolve={() => {}}
      onRevoke={() => {}}
    />,
  )

  expect(html).toContain('deleteTask')
  expect(html).toContain('task_one')
  expect(html).toContain('Allow now')
  expect(html).toContain('Always allow')
  expect(html).toContain('Reject')
  expect(html).toContain('Revoke')
})
