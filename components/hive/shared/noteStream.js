// components/hive/shared/noteStream.js
// ─────────────────────────────────────────────────────────────
// PURE merge for the client card's NOTE stream — peopleTouchPatch's opposite
// number for notes.
//
// THE BUG THIS CLOSES: a note writes to lead_notes and never touches the
// leads row, so leads realtime has no event to fire. Two bees on the same
// client could not see each other's notes at all — the most common
// collaborative act in the app reaching nobody until someone reloaded.
//
// ONE SEAM, TWO SOURCES. The card used to prepend a posted note inline, in
// two places (the buzz band and the job-note composer). Both now come through
// here, and so does the realtime arrival, so there is a single opinion about
// how a note joins a client. A remote note and a local one are the same kind
// of thing by construction — both are CONFIRMED server rows carrying the real
// id — which is what lets the dedupe below work on id alone.
//
// ADDITIVE-BY-ID, converging on the snapshot — the same rule peopleTouchPatch
// spells out, and for the same reason. The author's note is already in local
// state when their own INSERT comes back down the socket; a last-wins merge
// would show it twice. A note already in the bucket is therefore DROPPED, and
// the function returns the SAME `data` reference so the no-op costs zero
// re-renders. Notes are appends, never field overwrites: there is no version
// of this where "last wins" is safe.
//
// KIND IS A WHITELIST, not a default. The card holds exactly two buckets, and
// /api/clients/[id]/profile fills them with kind='buzz' and kind='job' only.
// The POST route can also write kind='system'. Bucketing an unknown kind as
// "job" would show a row live that a reload then makes vanish, so anything
// that is not buzz or job is ignored — the snapshot is the authority about
// what this card displays.
//
// Zero imports — safe in any bundle (§8.5 pure-module rule).
// ─────────────────────────────────────────────────────────────

// The two buckets the client card renders, and the note kind that fills each.
const BUCKET_FOR_KIND = { buzz: 'buzz_notes', job: 'job_notes' }

// data — ClientProfile's fetched profile object ({ client, buzz_notes,
//        job_notes, … }), or null before it loads
// note — a CONFIRMED lead_notes row: the POST response, or the flat row
//        postgres_changes delivers. Both carry the real id.
//
// Returns the SAME `data` reference when there is nothing to add (no id, a
// kind this card does not show, or a note already in its bucket).
export function upsertNote(data, note) {
  if (!data || !note || !note.id) return data
  const bucket = BUCKET_FOR_KIND[note.kind]
  if (!bucket) return data
  const cur = data[bucket] || []
  // The dedupe: the author's own note is already here, or a duplicate event
  // fired, or a refetch has already hydrated it.
  if (cur.some(n => n && n.id === note.id)) return data
  return {
    ...data,
    // The profile route ships both buckets created_at DESCENDING (newest
    // first) and the card renders them in that order, so hold that contract
    // rather than depending on arrival order — a note written moments ago can
    // still arrive after one written later, on a slow socket.
    [bucket]: [note, ...cur].sort(
      (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
    ),
  }
}

// ── editing and deleting, which are NOT the arrival path ──────────
// upsertNote above answers "a note I have never seen has arrived". These two
// answer "a note I already have has changed, or is gone" — the opposite
// question, so they are separate functions rather than flags on that one.
//
// DELIBERATELY LOCAL-ONLY. These are called after a CONFIRMED PATCH or DELETE
// by the person who made it. The realtime hook stays INSERT-only, so another
// watcher still needs a reload to see an edit or a deletion — see
// lib/use-lead-notes-realtime.ts for why that is not an oversight.

// Replace a note in place from the server's confirmed row. Searches both
// buckets by id rather than trusting the incoming kind, so a row whose kind
// somehow differs cannot be duplicated into the other bucket — the edit path
// refuses to change kind, and this holds that line even if it ever stopped.
// The list primitives. EngagementPanel holds its notes at children.notes
// rather than in these buckets, so it cannot use replaceNote/removeNote
// below — but it CAN use these, which means both screens share one opinion
// about what "replace in place" and "drop it" mean, and both return the SAME
// array reference when there is nothing to do.
export function replaceInList(list, note) {
  if (!Array.isArray(list) || !note || !note.id) return list
  const i = list.findIndex(n => n && n.id === note.id)
  if (i === -1) return list
  const copy = list.slice()
  copy[i] = note
  return copy
}

export function removeFromList(list, noteId) {
  if (!Array.isArray(list) || !noteId) return list
  return list.some(n => n && n.id === noteId) ? list.filter(n => n && n.id !== noteId) : list
}

export function replaceNote(data, note) {
  if (!data || !note || !note.id) return data
  let changed = false
  const next = { ...data }
  for (const bucket of ['buzz_notes', 'job_notes']) {
    const cur = data[bucket]
    if (!Array.isArray(cur)) continue
    const swapped = replaceInList(cur, note)
    if (swapped === cur) continue
    next[bucket] = swapped
    changed = true
  }
  return changed ? next : data
}

// Drop a note from whichever bucket holds it. Same-reference return when the
// id is not here, so a stray delete costs no re-render.
export function removeNote(data, noteId) {
  if (!data || !noteId) return data
  let changed = false
  const next = { ...data }
  for (const bucket of ['buzz_notes', 'job_notes']) {
    const cur = data[bucket]
    if (!Array.isArray(cur)) continue
    const dropped = removeFromList(cur, noteId)
    if (dropped === cur) continue
    next[bucket] = dropped
    changed = true
  }
  return changed ? next : data
}
