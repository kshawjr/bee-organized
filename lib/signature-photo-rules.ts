// lib/signature-photo-rules.ts
//
// The limits on an email-signature headshot, shared by the browser (before
// upload, lib/signature-photo.js) and the server (POST /api/signature/photo)
// so the two can't disagree. The bucket enforces the same limits again
// (migrations/email_signatures.sql).

export const SIGNATURE_PHOTO_MAX_BYTES = 1024 * 1024 // 1 MB — the browser sends ~20–60 KB
export const SIGNATURE_PHOTO_TYPES = ['image/jpeg', 'image/png'] as const
// Stored at 2× the 80px display size so it stays sharp on high-density screens.
export const SIGNATURE_PHOTO_STORED_PX = 160

export const HEIC_MESSAGE =
  'That photo is in Apple’s HEIC format, which this browser can’t read. On an iPhone, pick it from Photos in Safari (it converts automatically), or save it as a JPEG first and upload that.'

export function isHeic(type: string | null | undefined, name?: string | null): boolean {
  return /hei[cf]/i.test(String(type ?? '')) || /\.hei[cf]$/i.test(String(name ?? ''))
}

// Server-side check of what the browser declares. null = fine.
export function signaturePhotoProblem(type: string, size: number): string | null {
  if (isHeic(type)) return HEIC_MESSAGE
  if (!(SIGNATURE_PHOTO_TYPES as readonly string[]).includes(type)) {
    return 'The photo must be a JPEG or PNG.'
  }
  if (!Number.isFinite(size) || size <= 0) return 'The photo looks empty.'
  if (size > SIGNATURE_PHOTO_MAX_BYTES) return 'That photo is over 1 MB even after shrinking. Try a different picture.'
  return null
}
