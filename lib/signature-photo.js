// lib/signature-photo.js
// ─────────────────────────────────────────────────────────────
// The browser half of an email-signature headshot upload.
//
// An owner will pick a 4 MB phone photo. It never leaves the browser at that
// size: we centre-crop it SQUARE (the layout's photo is square) and shrink it
// to 160×160 JPEG — 2× the 80px it shows at, ~20–60 KB — before upload.
// Small, fast to load, and nothing a spam filter frowns at.
//
//   1. shrink  — decode, crop, resize on a canvas (EXIF rotation honoured)
//   2. sign    — POST /api/signature/photo → one-shot upload token + path
//   3. put     — supabase-js uploadToSignedUrl straight to the bucket
//   4. save    — PATCH /api/signature { signature_photo_path }
//
// Both server calls carry { locationId, targetUserId } — WHOSE signature the
// card is showing. The server re-derives the target and refuses a mismatch,
// so a photo can only ever land on the person the card named.
//
// HEIC (iPhone's own format) can't be decoded by most browsers; Safari on an
// iPhone converts it to JPEG as it hands the file over, so the refusal below
// only fires where it would otherwise fail — with a message that says what to
// do instead of a vague error.
// ─────────────────────────────────────────────────────────────
import { createClient } from '@/lib/supabase'
import { SIGNATURE_PHOTO_BUCKET } from '@/lib/email-signature'
import { HEIC_MESSAGE, SIGNATURE_PHOTO_STORED_PX, isHeic } from '@/lib/signature-photo-rules'

async function decode(file) {
  if (typeof window !== 'undefined' && typeof window.createImageBitmap === 'function') {
    try {
      return await window.createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // fall through to <img>
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')) }
    img.src = url
  })
}

// Resolve a square JPEG Blob, or throw an Error whose message is safe to show.
export async function shrinkSignaturePhoto(file) {
  if (!file) throw new Error('Pick a photo first.')
  if (isHeic(file.type, file.name)) throw new Error(HEIC_MESSAGE)
  if (file.type && !/^image\//i.test(file.type)) throw new Error('That file isn’t a picture. Pick a JPEG or PNG photo.')

  let img
  try {
    img = await decode(file)
  } catch {
    throw new Error('This browser couldn’t read that picture. Try a JPEG or PNG.')
  }
  const w = img.width || img.naturalWidth
  const h = img.height || img.naturalHeight
  if (!w || !h) throw new Error('This browser couldn’t read that picture. Try a JPEG or PNG.')

  const side = Math.min(w, h)
  const sx = Math.round((w - side) / 2)
  // Headshots: bias the crop toward the top third so a tall portrait keeps the
  // face rather than the chest.
  const sy = h > w ? Math.round((h - side) / 4) : Math.round((h - side) / 2)

  const out = SIGNATURE_PHOTO_STORED_PX
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff' // a transparent PNG becomes white, not black, as a JPEG
  ctx.fillRect(0, 0, out, out)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out)
  if (typeof img.close === 'function') img.close()

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86))
  if (!blob) throw new Error('This browser couldn’t prepare the photo. Try again.')
  return blob
}

// Shrink, upload and save as the TARGET's signature photo. Resolves
// { path } or throws an Error whose message is safe to show as-is.
export async function uploadSignaturePhoto(file, { locationId = null, targetUserId, onStatus } = {}) {
  if (!targetUserId) throw new Error('Reload the page — it isn’t clear whose signature this is.')
  onStatus?.('Preparing photo…')
  const blob = await shrinkSignaturePhoto(file)

  const signRes = await fetch('/api/signature/photo', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'image/jpeg', size: blob.size, locationId, targetUserId }),
  })
  const signed = await signRes.json().catch(() => ({}))
  if (!signRes.ok) throw new Error(signed.error || `Couldn’t prepare the upload (${signRes.status}).`)

  onStatus?.('Uploading…')
  const supabase = createClient()
  const { error } = await supabase.storage
    .from(SIGNATURE_PHOTO_BUCKET)
    .uploadToSignedUrl(signed.path, signed.token, blob, { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error('The upload didn’t finish. Check your connection and try again.')

  onStatus?.('Saving…')
  const saveRes = await fetch('/api/signature', {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, targetUserId, signature_photo_path: signed.path }),
  })
  const saved = await saveRes.json().catch(() => ({}))
  if (!saveRes.ok) throw new Error(saved.error || `Couldn’t save the photo (${saveRes.status}).`)
  return { path: signed.path }
}
