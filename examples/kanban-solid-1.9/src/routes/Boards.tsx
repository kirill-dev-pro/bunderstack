import { A } from '@solidjs/router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/solid-query'
import { createSignal, For, onMount } from 'solid-js'

import { authClient } from '../lib/auth-client.ts'
import { api } from '../lib/query.ts'
import { getRealtime } from '../lib/realtime.ts'
import { closeRealtime } from '../lib/realtime.ts'

export function Boards() {
  const qc = useQueryClient()
  const [title, setTitle] = createSignal('')

  onMount(async () => {
    const orgs = await authClient.organization.list()
    const first = orgs.data?.[0]
    if (first)
      await authClient.organization.setActive({ organizationId: first.id })
    await getRealtime().subscribe(['boards'])
    qc.invalidateQueries({ queryKey: api.boards.key({ type: 'query' }) })
  })

  const boards = useQuery(() =>
    api.boards.list.queryOptions({ input: { limit: 50 } }),
  )

  const create = useMutation(() => ({
    mutationFn: () => api.boards.create.call({ title: title() }),
    onSuccess: () => {
      setTitle('')
      qc.invalidateQueries({ queryKey: api.boards.key({ type: 'query' }) })
    },
  }))

  return (
    <main class="ot-container" style="max-width: 40rem; margin: 2rem auto">
      <header style="display:flex; justify-content:space-between; align-items:center">
        <h1>Boards</h1>
        <button
          onClick={() =>
            authClient.signOut().then(() => {
              closeRealtime()
              window.location.href = '/login'
            })
          }
        >
          Sign out
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create.mutate()
        }}
        style="display:flex; gap:.5rem"
      >
        <input
          placeholder="New board title"
          value={title()}
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
        <button type="submit" disabled={!title()}>
          Create
        </button>
      </form>
      <ul>
        <For each={boards.data?.items ?? []}>
          {(b) => (
            <li>
              <A href={`/boards/${b.id}`}>{b.title}</A>
            </li>
          )}
        </For>
      </ul>
    </main>
  )
}
