// components/hive/shared/photoPrep.js
// ─────────────────────────────────────────────────────────────
// Gets a photo ready to send, in the browser, before it leaves the device.
//
//   · A photo bigger than PHOTO_MAX_EDGE on its longest side, or over the
//     4 MB limit, is redrawn at PHOTO_MAX_EDGE and saved as a JPEG. A phone
//     photo (4032px, 3–6 MB) comes out around half a megabyte and still fills
//     a screen. Without this, most phone photos would be refused: nothing over
//     4.5 MB can pass through Vercel to our server at all.
//   · Every photo also gets a small square-ish preview (THUMB_MAX_EDGE) so the
//     list on a phone loads kilobytes, not the full pictures.
//
// Redrawing a photo also drops what the camera wrote inside it (where it was
// taken, on what phone). Only redrawn photos lose it — a small photo is sent
// exactly as it is.
//
// NEVER BLOCKS AN UPLOAD. If the browser cannot open the picture (a HEIC in
// Chrome, a damaged file) the original is sent untouched with no preview, and
// the server decides. PDFs pass straight through.
// ─────────────────────────────────────────────────────────────
import { MAX_FILE_BYTES, PHOTO_MAX_EDGE, THUMB_MAX_EDGE } from '@/lib/client-files'

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    // A browser that neither opens the picture nor says it can't must not
    // leave the upload waiting forever: give up and send the original.
    const giveUp = setTimeout(() => { URL.revokeObjectURL(url); reject(new Error('picture_timeout')) }, 8000)
    img.onload = () => { clearTimeout(giveUp); URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { clearTimeout(giveUp); URL.revokeObjectURL(url); reject(new Error('cannot_open_picture')) }
    img.src = url
  })
}

function drawTo(img, maxEdge, quality) {
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) return Promise.reject(new Error('no_size'))
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('no_canvas'))
  // A see-through PNG would turn black as a JPEG; paint white under it.
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('no_blob'))), 'image/jpeg', quality)
  })
}

const jpegName = (name) => `${String(name || 'photo').replace(/\.[A-Za-z0-9]+$/, '')}.jpg`

/**
 * @returns {Promise<{ file: File|Blob, name: string, thumb: Blob|null }>}
 *          what to send. `file` is the original unless it had to be shrunk.
 */
export async function prepareForUpload(file) {
  const original = { file, name: file.name, thumb: null }
  const looksLikePhoto = /^image\//.test(file.type || '') || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')
  if (!looksLikePhoto || typeof document === 'undefined') return original

  let img
  try { img = await loadImage(file) } catch { return original }

  let thumb = null
  try { thumb = await drawTo(img, THUMB_MAX_EDGE, 0.7) } catch { thumb = null }

  const longest = Math.max(img.naturalWidth || 0, img.naturalHeight || 0)
  if (longest <= PHOTO_MAX_EDGE && file.size <= MAX_FILE_BYTES) return { ...original, thumb }

  try {
    const smaller = await drawTo(img, PHOTO_MAX_EDGE, 0.85)
    return { file: smaller, name: jpegName(file.name), thumb }
  } catch {
    return { ...original, thumb }
  }
}
