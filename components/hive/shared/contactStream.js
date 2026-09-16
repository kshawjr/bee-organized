// components/hive/shared/contactStream.js
// ─────────────────────────────────────────────────────────────
// PURE merge for the client card's SECONDARY CONTACTS — noteStream's opposite
// number, and the same rule for the same reason.
//
// THE BUG THIS CLOSES: a contact writes to lead_contacts and never touches
// the leads row, so leads realtime has no event to carry it. Two bees on the
// same client could not see each other add one — the husband's mobile, the
// office manager, the person who actually opens the door — until someone
// reloaded. Noticed while building the notes equivalent (94af905) and left
// alone then because it was out of scope.
//
// ADDITIVE-BY-ID, converging on the snapshot — peopleTouchPatch's rule,
// noteStream's rule. The author's contact is already in local state when
// their own INSERT comes back down the socket; a last-wins merge would show
// it twice. A contact already in the list is therefore DROPPED, and the
// function returns the SAME `data` reference so the no-op costs zero
// re-renders.
//
// ONE OPINION ABOUT AN ARRIVING CONTACT, which is what this module is. It is
// deliberately NOT the path a local edit takes: ContactsBlock is a controlled
// component that hands ClientProfile the whole next array, because the three
// things it does — add, edit, remove — are not all insertions and cannot be
// expressed as one. That contract is left exactly as it was. The two layers
// converge because THIS one refuses an id the array already holds, so
// whatever ContactsBlock did locally still stands.
//
// ORDER IS created_at ASCENDING, and that is not the same as notes.
// /api/clients/[id]/profile fetches contacts `.order('created_at', {
// ascending: true })` and the card lists them oldest-first; buzz and job notes
// come back newest-first. Holding each list's own contract is the point —
// guessing one from the other would quietly reorder the card.
//
// Zero imports — safe in any bundle (§8.5 pure-module rule).
// ─────────────────────────────────────────────────────────────

// data    — ClientProfile's fetched profile object ({ client, contacts, … }),
//           or null before it loads
// contact — a CONFIRMED lead_contacts row: the POST response, or the flat row
//           postgres_changes delivers. Both carry the real id.
//
// Returns the SAME `data` reference when there is nothing to add (no id, or a
// contact already in the list).
export function upsertContact(data, contact) {
  if (!data || !contact || !contact.id) return data
  const cur = data.contacts || []
  // The dedupe: the author's own contact is already here, or a duplicate
  // event fired, or a refetch has already hydrated it.
  if (cur.some(ct => ct && ct.id === contact.id)) return data
  return {
    ...data,
    contacts: [...cur, contact].sort(
      (a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
    ),
  }
}
