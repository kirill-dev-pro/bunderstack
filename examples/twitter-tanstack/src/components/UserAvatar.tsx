import { thumbnailUrl } from '~/components/ImageUpload'

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

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className={`border-gray-200 dark:border-gray-700 shrink-0 rounded-full border object-cover ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <div
      className={`bg-cyan-100 dark:bg-cyan-900 text-cyan-800 dark:text-cyan-200 font-semibold flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.35 }}
      aria-hidden
    >
      {initials}
    </div>
  )
}
