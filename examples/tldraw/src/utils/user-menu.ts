type MenuUser = {
  name?: string | null
  email: string
}

export function getUserLabel(user: MenuUser) {
  return user.name?.trim() || user.email
}

export function getUserInitials(user: MenuUser) {
  const label = getUserLabel(user)
  const parts = label.split(/\s+/).filter(Boolean)
  const source = parts.length > 1 ? parts.slice(0, 2) : [label]

  return source
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}
