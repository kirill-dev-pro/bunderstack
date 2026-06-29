import type { InferSelect } from 'bunderstack-query'

import type * as schema from '~/schema'

import { api } from '~/api-client'
import { useToastMutation } from '~/hooks/useToastMutation'
import { fileIdFromUrl, isImageMime } from '~/lib/files'

import { AttachmentLightbox } from './AttachmentLightbox'

type Attachment = InferSelect<typeof schema.attachments>

type AttachmentGalleryProps = {
  attachments: Attachment[]
  currentUserId: string
  onDelete?: () => void
  compact?: boolean
}

export function AttachmentGallery({
  attachments,
  currentUserId,
  onDelete,
  compact = false,
}: AttachmentGalleryProps) {
  const deleteAttachment = useToastMutation({
    ...api.attachments.deleteMutation({ onSuccess: onDelete }),
    successMessage: 'Attachment removed',
  })

  if (attachments.length === 0) return null

  return (
    <div
      className={`attachment-gallery${compact ? ' attachment-gallery--compact' : ''}`}
    >
      {attachments.map((att) => {
        const fileId = fileIdFromUrl(att.fileUrl)
        const isImage = isImageMime(att.mimeType)

        return (
          <div key={att.id} className="attachment-item">
            {isImage && fileId ? (
              <AttachmentLightbox
                fileUrl={att.fileUrl}
                fileName={att.fileName}
              />
            ) : (
              <a
                href={att.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="attachment-file-chip"
              >
                <span aria-hidden>📎</span>
                {att.fileName ?? 'File'}
              </a>
            )}
            {att.uploaderId === currentUserId ? (
              <button
                type="button"
                className="attachment-delete"
                aria-label="Remove attachment"
                onClick={() => deleteAttachment.mutate(att.id)}
                disabled={deleteAttachment.isPending}
              >
                ×
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
