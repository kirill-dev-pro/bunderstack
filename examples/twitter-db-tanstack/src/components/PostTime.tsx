import * as React from 'react'

function formatRelative(date: Date) {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  return date.toISOString().slice(0, 10)
}

export function PostTime({ value }: { value: Date | string }) {
  const iso = new Date(value).toISOString()
  const [label, setLabel] = React.useState(() => iso.slice(0, 10))

  React.useEffect(() => {
    setLabel(formatRelative(new Date(value)))
  }, [value])

  return (
    <time
      dateTime={iso}
      className="text-muted-foreground text-sm"
      suppressHydrationWarning
    >
      {label}
    </time>
  )
}
