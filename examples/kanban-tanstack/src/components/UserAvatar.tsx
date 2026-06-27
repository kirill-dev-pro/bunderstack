type UserAvatarProps = {
  name: string
  image?: string | null
  size?: number
  className?: string
}

export function UserAvatar({
  name,
  image,
  size = 32,
  className = '',
}: UserAvatarProps) {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  if (image) {
    return (
      <img
        src={image}
        alt={name}
        width={size}
        height={size}
        className={`user-avatar user-avatar-img ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <div
      className={`user-avatar ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden
      title={name}
    >
      {initials}
    </div>
  )
}
