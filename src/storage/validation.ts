export interface UploadRules {
  allowedMimeTypes?: string[]
  maxSizeBytes?: number
}

export class UploadValidationError extends Error {
  constructor(
    public readonly reason: 'mime' | 'size',
    message: string,
  ) {
    super(message)
    this.name = 'UploadValidationError'
  }
}

export function validateUpload(file: File, rules: UploadRules): void {
  if (rules.allowedMimeTypes && !rules.allowedMimeTypes.includes(file.type)) {
    throw new UploadValidationError(
      'mime',
      `File type "${file.type}" is not allowed. Allowed: ${rules.allowedMimeTypes.join(', ')}`,
    )
  }
  if (rules.maxSizeBytes !== undefined && file.size > rules.maxSizeBytes) {
    throw new UploadValidationError(
      'size',
      `File size ${file.size} bytes exceeds limit of ${rules.maxSizeBytes} bytes`,
    )
  }
}
