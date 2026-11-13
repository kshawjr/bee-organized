// lib/client-files.ts
// ─────────────────────────────────────────────────────────────
// CLIENT FILES — the rules, in one place (13 Nov 2026).
//
// The Files tab on the client card and on a job was a placeholder from the
// day it shipped: no upload, no storage, no read. This is the real thing.
// These files are photographs of the inside of clients' homes, and quotes
// with their names and prices on them, so every rule here leans the careful
// way.
//
// Pure: no database, no Storage, no React. The server routes
// (app/api/client-files/**), the screen (components/hive/shared/FilesTab.jsx)
// and the tests all read the SAME constants and the SAME rule functions, so
// the screen cannot offer what the server refuses, or the other way round.
//
// WHERE A FILE LIVES. One PRIVATE Storage bucket, `client-files`, and one
// object per file at
//
//     <lead id>/<random uuid>-<cleaned file name>
//
// The first part is the CLIENT, not the person who added it and not the
// location. Feedback attachments are filed under the author because a report
// belongs to whoever wrote it; a client's files belong to the client. And not
// the location, because a client moves (a transfer, a closed franchise) and a
// path that names a location would either have to be rewritten on every move
// or start telling a lie. Who may see a file is never read from its path: it
// is worked out, on every single request, from where the client is filed
// RIGHT NOW (leads.location_uuid).
//
// WHAT MAY BE ADDED. Photos (JPG, PNG, WebP, HEIC) and PDFs. The type is
// decided by reading the first bytes of the file itself — what the browser
// CLAIMS it is, and what the name ends in, are ignored. Anything else is
// refused with a plain sentence; nothing is stored.
//
// HOW BIG. 4 MB, not the 10 MB the feedback form states. Vercel refuses any
// request over 4.5 MB before our code runs (app/api/help/media/sign/route.ts
// says the same), so a 10 MB cap on a file that travels through our own
// server is a promise that cannot be kept. The screen shrinks a large photo
// to 2400px on its longest side before sending, which lands a phone photo
// well under 1 MB.
// ─────────────────────────────────────────────────────────────

export const CLIENT_FILES_BUCKET = 'client-files'
export const CLIENT_FILES_TABLE = 'client_files'

export const MAX_FILE_BYTES = 4 * 1024 * 1024 // 4 MB — see the header
export const MAX_THUMB_BYTES = 200 * 1024 // the small preview picture
export const MAX_NAME_LENGTH = 200

// A photo wider or taller than this is shrunk in the browser before it is
// sent (FilesTab). The preview is the small square shown in the list.
export const PHOTO_MAX_EDGE = 2400
export const THUMB_MAX_EDGE = 320

export const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const
export type ClientFileType = (typeof ALLOWED_TYPES)[number]

// The file picker's hint. A hint only — the server decides (sniffFileType).
export const FILE_PICKER_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf'

export const WORDS = {
  wrongType: 'Only photos (JPG, PNG, WebP or HEIC) and PDFs can be added here.',
  tooBig: 'That file is over 4 MB, which is the most Bee Hub can take. Try a smaller copy.',
  empty: 'That file is empty.',
  notSwitchedOn: 'Files isn’t switched on yet.',
  readOnly: 'You can look at these files, but not add or remove them.',
  inBin: 'This client is in the bin. Restore them to add files.',
  generic: 'That didn’t go through. Please try again.',
}

const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']

/**
 * What a file really is, from its own first bytes. Returns one of
 * ALLOWED_TYPES, or null for anything else (including a file that merely
 * CLAIMS to be a photo: an .html renamed to .jpg is null).
 */
export function sniffFileType(bytes: Uint8Array | null | undefined): ClientFileType | null {
  if (!bytes || bytes.length < 12) return null
  const b = bytes
  const ascii = (from: number, to: number) => String.fromCharCode(...Array.from(b.slice(from, to)))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (ascii(0, 5) === '%PDF-') return 'application/pdf'
  if (ascii(4, 8) === 'ftyp' && HEIC_BRANDS.includes(ascii(8, 12).toLowerCase())) return 'image/heic'
  return null
}

export const isPhotoType = (type: string | null | undefined) => !!type && type.startsWith('image/')

/**
 * The name used INSIDE the Storage path. Feedback's rule, unchanged: the last
 * path segment only, anything outside letters, digits, dot, dash and
 * underscore becomes an underscore, no leading dots, 120 characters.
 * "../../etc/passwd" comes out as "passwd".
 */
export function storageSafeName(name: string | null | undefined): string {
  const base = (name || 'file').split(/[\\/]/).pop() || 'file'
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120)
  return cleaned || 'file'
}

/**
 * The name SHOWN to people and kept on the row: what the owner called the
 * file, spaces and accents and all, minus anything that is not a name — a
 * folder, a control character, a line break.
 */
export function displayName(name: string | null | undefined): string {
  const base = (name || '').split(/[\\/]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH)
  return cleaned || 'file'
}

/** `<lead id>/<uuid>-<cleaned name>` — see the header for why the client. */
export function clientFilePath(leadId: string, uuid: string, name: string): string {
  return `${leadId}/${uuid}-${storageSafeName(name)}`
}
export function clientThumbPath(leadId: string, uuid: string): string {
  return `${leadId}/${uuid}-preview.jpg`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

// ── Who may do what ───────────────────────────────────────────
//
//                      see   add   remove
//   super_admin/admin   any   any   any            (corporate: every location)
//   owner               own   own   any at theirs
//   manager             own   own   only what they added themselves
//   lite_user           own   no    no             (read-only by role)
//   paused / inactive
//   location            own   no    no             (read-only by location;
//                                                   the routes ask
//                                                   lib/read-only-access)
//
// "own" = the client is filed at the person's own location right now.

type Caller = { id: string; role: string | null | undefined; location_id?: string | null }

const isCorporate = (role: string | null | undefined) => role === 'super_admin' || role === 'admin'

/** May this person SEE this client's files at all? */
export function canSeeClientFiles(caller: Caller, lead: { location_uuid?: string | null }): boolean {
  if (isCorporate(caller.role)) return true
  return !!caller.location_id && caller.location_id === lead.location_uuid
}

/**
 * May this ROLE add or remove files anywhere? (The location being paused is a
 * second, separate question — readOnlyWriteBlock.)
 */
export function roleMayChangeFiles(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'admin' || role === 'owner' || role === 'manager'
}

/** May this person remove THIS file? Call only after canSeeClientFiles. */
export function canRemoveClientFile(caller: Caller, file: { uploaded_by?: string | null }): boolean {
  if (!roleMayChangeFiles(caller.role)) return false
  if (isCorporate(caller.role) || caller.role === 'owner') return true
  return !!file.uploaded_by && file.uploaded_by === caller.id
}

/** "1.2 MB", "340 KB". */
export function fileSizeWords(bytes: number | null | undefined): string {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

/**
 * The database saying "there is no client_files table" — the migration has
 * not been run yet. Postgres says 42P01; PostgREST says PGRST205 (not in the
 * schema cache). Narrow on purpose: any other failure is a real failure.
 */
export function isMissingFilesTable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const code = String(e.code ?? '')
  if (code === '42P01' || code === 'PGRST205') return true
  const msg = String(e.message ?? '').toLowerCase()
  return msg.includes(CLIENT_FILES_TABLE) && (msg.includes('does not exist') || msg.includes('schema cache'))
}
