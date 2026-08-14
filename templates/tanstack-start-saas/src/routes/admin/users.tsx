import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

export const Route = createFileRoute('/admin/users')({
  component: AdminUsersPage,
})

function AdminUsersPage() {
  const { adminAuth } = Route.useRouteContext()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight text-[#FFFDF7]">
          User Management & Roles
        </h1>
        <p className="mt-1 text-sm text-[#FFFDF7]/70">
          Manage system users and RBAC access permissions
        </p>
      </div>

      <Card className="border-[#FFFDF7]/15 bg-[#0F1713] text-[#FFFDF7]">
        <CardHeader>
          <CardTitle className="text-lg font-bold text-[#FFFDF7]">
            Active User Directory
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-sm">
              <thead>
                <tr className="border-b border-[#FFFDF7]/15 text-xs text-[#FFFDF7]/60 uppercase">
                  <th className="pb-3">User</th>
                  <th className="pb-3">Email</th>
                  <th className="pb-3">Role</th>
                  <th className="pb-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#FFFDF7]/10">
                <tr>
                  <td className="py-3 font-sans font-medium">
                    {adminAuth.user.name || 'Admin User'}
                  </td>
                  <td className="py-3 text-[#FFFDF7]/70">
                    {adminAuth.user.email}
                  </td>
                  <td className="py-3">
                    <Badge
                      variant="accent"
                      className="font-mono text-xs uppercase"
                    >
                      {adminAuth.user.role || 'admin'}
                    </Badge>
                  </td>
                  <td className="py-3 text-[#DCEBDD]">ACTIVE</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
