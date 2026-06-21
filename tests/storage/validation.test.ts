import { test, expect } from 'bun:test'
import { validateUpload, UploadValidationError } from '../../src/storage/validation'

function makeFile(type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], 'test.bin', { type })
}

test('passes when file meets all rules', () => {
  expect(() =>
    validateUpload(makeFile('image/jpeg', 1024), {
      allowedMimeTypes: ['image/jpeg'],
      maxSizeBytes: 5 * 1024 * 1024,
    })
  ).not.toThrow()
})

test('throws mime error for disallowed type', () => {
  expect(() =>
    validateUpload(makeFile('application/pdf', 100), { allowedMimeTypes: ['image/jpeg'] })
  ).toThrow(UploadValidationError)

  try {
    validateUpload(makeFile('application/pdf', 100), { allowedMimeTypes: ['image/jpeg'] })
  } catch (e) {
    expect(e).toBeInstanceOf(UploadValidationError)
    if (e instanceof UploadValidationError) expect(e.reason).toBe('mime')
  }
})

test('throws size error when file exceeds limit', () => {
  try {
    validateUpload(makeFile('image/jpeg', 6 * 1024 * 1024), {
      allowedMimeTypes: ['image/jpeg'],
      maxSizeBytes: 5 * 1024 * 1024,
    })
  } catch (e) {
    expect(e).toBeInstanceOf(UploadValidationError)
    if (e instanceof UploadValidationError) expect(e.reason).toBe('size')
  }
})

test('no rules = always passes', () => {
  expect(() => validateUpload(makeFile('video/mp4', 100 * 1024 * 1024), {})).not.toThrow()
})
