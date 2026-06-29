import { useRef } from 'react'

import { fileIdFromUrl, thumbnailUrl } from '~/lib/files'

type AttachmentLightboxProps = {
  fileUrl: string
  fileName?: string | null
  alt?: string
}

export function AttachmentLightbox({
  fileUrl,
  fileName,
  alt = 'Attachment',
}: AttachmentLightboxProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fileId = fileIdFromUrl(fileUrl)
  const fullSrc = fileId ? thumbnailUrl(fileId) : fileUrl
  const thumbSrc = fileId
    ? thumbnailUrl(fileId, { w: 480, h: 320, format: 'webp' })
    : fileUrl

  return (
    <>
      <button
        type="button"
        className="attachment-thumb-btn"
        onClick={() => dialogRef.current?.showModal()}
        aria-label={`View ${fileName ?? 'attachment'}`}
      >
        <img src={thumbSrc} alt={alt} loading="lazy" />
      </button>

      <dialog
        ref={dialogRef}
        className="attachment-lightbox"
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current.close()
        }}
      >
        <div className="attachment-lightbox-inner">
          <button
            type="button"
            className="outline attachment-lightbox-close"
            onClick={() => dialogRef.current?.close()}
          >
            Close
          </button>
          <img src={fullSrc} alt={alt} className="attachment-lightbox-image" />
        </div>
      </dialog>
    </>
  )
}
