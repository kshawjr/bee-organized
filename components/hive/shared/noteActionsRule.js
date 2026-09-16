// components/hive/shared/noteActionsRule.js
// ─────────────────────────────────────────────────────────────
// WHO MAY EDIT OR DELETE A NOTE, and what happens when they do — written
// ONCE and spent by every surface that renders notes.
//
// THREE SURFACES NOW, not two. ClientProfile's Overview (the buzz band and
// its Recent activity) and EngagementPanel's Recent activity. Recent activity
// is the same NotesStream in both, and for a while only one of them passed
// noteActionsFor — so an owner who reached a note from an engagement, which
// is most of the time including from the Inbox, could not touch it. The fix
// is not to write the rule twice; it is to have one rule with a place to plug
// each screen's own state in.
//
// WHAT IS SHARED: who may act, which items are notes at all, the two API
// calls, and the toasts. WHAT IS NOT: how the answer lands in state, because
// the two screens genuinely hold notes differently — ClientProfile has
// buzz_notes/job_notes buckets, EngagementPanel has children.notes. Those are
// passed in as onEdited/onDeleted rather than guessed at here.
//
// NOT A NOTE, SO NO CONTROLS. Recent activity is a MIXED stream: real notes
// beside system entries — "Address added → …", "Client created", stage
// changes, the audit touchpoints. Two things keep verbs off those:
//   · NotesStream only calls this for items it tagged t === 'note';
//     touchpoints never reach it at all.
//   · this refuses kind === 'system' and anything with no id.
// Both matter. An owner invited to delete the record of something that
// happened is the failure this exists to prevent, and it is why the id check
// comes first: a synthesised row with no id can never be addressed by the API
// anyway.
//
// THE ROUTE IS THE GUARD. This only decides whether the affordance is DRAWN.
// PATCH and DELETE re-check author-or-admin server-side (lib/lead-note-edit),
// and beta-lead-note-edit-delete proves the refusals there with forged
// requests. A hidden button is a courtesy, not a rule.
//
// §8.5: no React context here or in its callers — currentUserId and
// currentUserRole arrive as PROPS all the way down.
// ─────────────────────────────────────────────────────────────

/**
 * @param currentUserId    signed-in hub_user id, or null
 * @param currentUserRole  their role, for the admin bypass
 * @param onEdited   (confirmedRow) => void — fold the server's row into state
 * @param onDeleted  (noteId) => void — drop it from state
 * @param setToast   the card's toast setter
 * @returns noteActionsFor(note) → props for NoteActions, or null for
 *          "draw nothing" — which is also the answer for every non-note.
 */
export function makeNoteActionsFor({ currentUserId, currentUserRole, onEdited, onDeleted, setToast = () => {} }) {
  return function noteActionsFor(note) {
    if (!note || !note.id || note.kind === 'system') return null
    const isOwn = !!currentUserId && note.user_id === currentUserId
    const canManage = isOwn || currentUserRole === 'admin' || currentUserRole === 'super_admin'
    if (!canManage) return null
    return {
      canManage,
      isOwn,
      onSave: async (text) => {
        const res = await fetch(`/api/lead-notes/${note.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
        // Fold in the CONFIRMED row, so the edited marker and the saved text
        // are the server's and never a guess at them.
        onEdited?.(j.note)
        setToast({ kind: 'success', msg: 'Note updated' })
      },
      onDelete: async () => {
        const res = await fetch(`/api/lead-notes/${note.id}`, { method: 'DELETE' })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j?.error || `HTTP ${res.status}`)
        }
        onDeleted?.(note.id)
        setToast({ kind: 'success', msg: 'Note deleted' })
      },
    }
  }
}
