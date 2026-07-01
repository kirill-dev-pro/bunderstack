import { thumbnailUrl } from '~/components/ImageUpload'
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar'

type UserAvatarProps = {
  name: string
  image?: string | null
  size?: number
  className?: string
}

export function UserAvatar({
  name,
  image,
  size = 40,
  className = '',
}: UserAvatarProps) {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  let src: string | null = null
  if (image) {
    if (image.startsWith('http://') || image.startsWith('https://')) {
      src = image
    } else if (image.startsWith('/api/files/')) {
      const fileId = image.replace('/api/files/', '').split('?')[0]!
      src = thumbnailUrl(fileId, { w: size * 2, h: size * 2, format: 'webp' })
    } else {
      src = image
    }
  }

  return (
    <Avatar
      className={`border-border border ${className}`}
      style={{ width: size, height: size }}
    >
      {src ? <AvatarImage src={src} alt={name} /> : null}
      <AvatarFallback
        className="bg-cyan-100 font-semibold text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200"
        style={{ fontSize: size * 0.35 }}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  )
}
