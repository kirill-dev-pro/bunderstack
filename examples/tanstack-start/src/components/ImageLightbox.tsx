import * as React from 'react'
import { thumbnailUrl } from '~/components/ImageUpload'
import { closeDialog, showDialog } from '~/utils/oat'
import { fileIdFromUrl } from '~/components/ImageUpload'

type ImageLightboxProps = {
  imageUrl: string
  alt?: string
}

export function ImageLightbox({ imageUrl, alt = 'Attachment' }: ImageLightboxProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const fileId = fileIdFromUrl(imageUrl)
  const fullSrc = fileId ? `/api/files/${fileId}` : imageUrl
  const thumbSrc = fileId ? thumbnailUrl(fileId, { w: 480, h: 480, format: 'webp' }) : imageUrl

  return (
    <>
      <button
        type="button"
        className="post-image-thumb"
        onClick={() => showDialog(dialogRef.current)}
        aria-label="View full image"
      >
        <img src={thumbSrc} alt={alt} loading="lazy" />
      </button>

      <dialog ref={dialogRef} closedby="any">
        <form method="dialog">
          <header>
            <h3>Image</h3>
          </header>
          <div className="lightbox-body">
            <img src={fullSrc} alt={alt} className="lightbox-image" />
          </div>
          <footer>
            <button type="button" className="outline" onClick={() => closeDialog(dialogRef.current)}>
              Close
            </button>
          </footer>
        </form>
      </dialog>
    </>
  )
}

export function PostImagePreview({ imageUrl, alt }: { imageUrl: string; alt?: string }) {
  return <ImageLightbox imageUrl={imageUrl} alt={alt} />
}
