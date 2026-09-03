// components/help/helpMedia.js
// ─────────────────────────────────────────────────────────────
// The browser half of a Help media upload. Phone-first: the file comes from
// <input type="file" accept="video/*|image/*">, which on iOS offers the
// camera roll or a fresh recording.
//
// Three steps, and the bytes never touch our server (Vercel's 4.5 MB body
// cap would refuse a video):
//   1. probe   — read the video's duration locally so an over-long clip is
//                refused BEFORE any upload starts, in words
//   2. sign    — POST /api/help/media/sign (editors only) → a one-shot
//                signed upload token + the final object path
//   3. put     — supabase-js uploadToSignedUrl straight to the bucket
// ─────────────────────────────────────────────────────────────
import { createClient } from '@/lib/supabase'
import { HELP_MEDIA_BUCKET, mediaKindForType, mediaLimitProblem } from '@/lib/help-content'

// Duration in seconds, or null when the browser can't read it (an odd
// container). null never blocks — the server accepts an unknown duration and
// the size cap still applies.
export function probeVideoSeconds(file) {
  return new Promise(resolve => {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return resolve(null)
    let url = null
    try {
      const v = document.createElement('video')
      v.preload = 'metadata'
      url = URL.createObjectURL(file)
      const done = (val) => { try { if (url) URL.revokeObjectURL(url) } catch {} resolve(val) }
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null)
      v.onerror = () => done(null)
      v.src = url
      setTimeout(() => done(null), 8000)
    } catch { resolve(null) }
  })
}

// Upload one file. Resolves { path, kind, publicUrl } or throws an Error
// whose message is safe to show as-is.
export async function uploadHelpMedia(file, { onStatus } = {}) {
  const kind = mediaKindForType(file?.type)
  if (!kind) throw new Error('That file type isn’t supported. Videos: MP4, MOV or WebM. Screenshots: PNG, JPG, WebP or GIF.')

  let seconds = null
  if (kind === 'video') {
    onStatus?.('Checking the video…')
    seconds = await probeVideoSeconds(file)
  }
  const local = mediaLimitProblem(kind, file.size, seconds)
  if (local) throw new Error(local)

  onStatus?.('Preparing upload…')
  const signRes = await fetch('/api/help/media/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, type: file.type, size: file.size, seconds }),
  })
  const signed = await signRes.json().catch(() => ({}))
  if (!signRes.ok) throw new Error(signed.error || `Couldn’t prepare the upload (${signRes.status}).`)

  onStatus?.(kind === 'video' ? 'Uploading video… keep this open.' : 'Uploading screenshot…')
  const supabase = createClient()
  const { error } = await supabase.storage
    .from(HELP_MEDIA_BUCKET)
    .uploadToSignedUrl(signed.path, signed.token, file, { contentType: file.type, upsert: false })
  if (error) {
    const msg = String(error.message || '')
    if (/exceeded|too large|maximum/i.test(msg)) throw new Error('The file is bigger than the bucket allows (100 MB). Trim it and try again.')
    if (/mime|type/i.test(msg)) throw new Error('The bucket refused that file type.')
    throw new Error('The upload didn’t finish. Check your connection and try again.')
  }
  return { path: signed.path, kind, publicUrl: signed.publicUrl }
}
