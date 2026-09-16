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
