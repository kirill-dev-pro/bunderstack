import { fileIdFromUrl, thumbnailUrl } from '~/components/ImageUpload'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'

type ImageLightboxProps = {
  imageUrl: string
  alt?: string
}

export function ImageLightbox({
  imageUrl,
  alt = 'Attachment',
}: ImageLightboxProps) {
  const fileId = fileIdFromUrl(imageUrl)
  const fullSrc = fileId ? thumbnailUrl(fileId) : imageUrl
  const thumbSrc = fileId
    ? thumbnailUrl(fileId, { w: 480, h: 480, format: 'webp' })
    : imageUrl

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="relative z-10 block max-h-80 overflow-hidden rounded-lg border"
          onClick={(e) => e.stopPropagation()}
          aria-label="View full image"
        >
          <img src={thumbSrc} alt={alt} loading="lazy" className="block" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <DialogTitle className="sr-only">Image</DialogTitle>
        <img
          src={fullSrc}
          alt={alt}
          className="max-h-[80vh] w-full object-contain"
        />
      </DialogContent>
    </Dialog>
  )
}

export function PostImagePreview({
  imageUrl,
  alt,
}: {
  imageUrl: string
  alt?: string
}) {
  return <ImageLightbox imageUrl={imageUrl} alt={alt} />
}
