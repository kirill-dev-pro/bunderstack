import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { api } from '~/api-client'
import { authClient } from '~/utils/auth-client'

export function OrgSwitcher() {
  const qc = useQueryClient()
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([])
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    void (async () => {
      const res = await authClient.organization.list()
      const list = res.data ?? []
      setOrgs(list.map((o) => ({ id: o.id, name: o.name })))
      const active = await authClient.organization.getFullOrganization()
      if (active.data?.id) {
        setActiveId(active.data.id)
      } else if (list[0]) {
        await authClient.organization.setActive({ organizationId: list[0].id })
        setActiveId(list[0].id)
        void qc.invalidateQueries()
      }
    })()
  }, [qc])

  if (orgs.length <= 1) {
    return orgs[0] ? <span className="org-switcher">{orgs[0].name}</span> : null
  }

  return (
    <label className="org-switcher">
      <span className="sr-only">Organization</span>
      <select
        value={activeId}
        onChange={async (e) => {
          const id = e.target.value
          await authClient.organization.setActive({ organizationId: id })
          setActiveId(id)
          void qc.invalidateQueries()
        }}
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </label>
  )
}
