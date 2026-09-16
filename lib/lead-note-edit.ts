// lib/lead-note-edit.ts
// ─────────────────────────────────────────────────────────────
// The author-or-admin rule for a lead note, shared by PATCH and DELETE on
// app/api/lead-notes/[id]/route.ts.
//
// WHY IT IS LIFTED. DELETE already had this rule and it was correct. Edit
// needs the SAME rule, and the reliable way to get the same rule is to call
// the same function rather than to write it twice and hope they stay in step
// — the #89 lesson, applied to authorisation instead of a badge count. The
// behaviour and the error strings are exactly what DELETE did before the
// lift; nothing here is new policy.
//
// WHAT IT IS NOT. It does not check auth (401), the hub_user profile, the
// note's existence, kind='system', or the read-only state. Those are the
// route's, in that order, because each has its own status code and its own
// message. This is only the last question: may THIS person act on THIS note?
// ─────────────────────────────────────────────────────────────
import { isAdmin } from '@/lib/auth'

type NoteRow = { user_id?: string | null; location_uuid?: string | null }
type HubUser = { id: string; role: string; location_id?: string | null }

/**
 * @returns null when the caller may act, or the error string the route should
 *          return with a 403. Admins pass unconditionally — they are not
 *          fenced to a location anywhere else either.
 */
export function noteEditAuthError(note: NoteRow, hubUser: HubUser): string | null {
  if (isAdmin(hubUser.role)) return null
  // Order matters and is DELETE's original order: not-author is reported
  // before wrong-location, so someone else's note at your own location and
  // someone else's note elsewhere give the same first answer.
  if (note.user_id !== hubUser.id) return 'forbidden_not_author'
  if (hubUser.location_id !== note.location_uuid) return 'forbidden_wrong_location'
  return null
}

/**
 * True when the database is objecting to lead_notes.edited_at specifically —
 * the column added by migrations/lead_notes_edited_at.sql, which Kevin applies
 * by hand. Modelled on lib/lead-address.ts's isMissingFormerAddressesColumn:
 * Postgres reports 42703 (undefined column) and PostgREST reports PGRST204
 * (not in the schema cache), and either can arrive as a bare message.
 *
 * Narrow on purpose — it names the column, so an unrelated write failure is
 * never mistaken for "the migration hasn't run" and silently downgraded.
 */
export function isMissingEditedAtColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const msg = String(e.message ?? '').toLowerCase()
  if (!msg.includes('edited_at')) return false
  const code = String(e.code ?? '')
  return code === '42703' || code === 'PGRST204' || msg.includes('column') || msg.includes('schema cache')
}
