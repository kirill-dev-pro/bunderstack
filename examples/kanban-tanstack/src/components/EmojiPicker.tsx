export const COMMON_EMOJIS = [
  '👍',
  '❤️',
  '🎉',
  '😂',
  '🚀',
  '👀',
  '✅',
  '🔥',
  '💯',
  '🙌',
  '😮',
  '😢',
] as const

type EmojiPickerProps = {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  return (
    <div className="emoji-picker" role="listbox" aria-label="Pick a reaction">
      {COMMON_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="emoji-picker-btn"
          role="option"
          onClick={() => {
            onSelect(emoji)
            onClose()
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}
