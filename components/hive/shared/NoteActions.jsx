// components/hive/shared/NoteActions.jsx
// ─────────────────────────────────────────────────────────────
// Edit and delete, for one note, wherever a note renders.
//
// ONE COMPONENT FOR TWO SURFACES that are shaped very differently:
// NotesStream lists every note, while PinnedBuzz shows only the LATEST with
// its history folded behind the pencil. Sharing the controls means the verbs,
// the confirmation wording and the disabled states cannot drift between them
// — only WHERE they are mounted differs, and each caller decides that.
//
// THE DELETE CONFIRMATION LEADS WITH WHAT IS LOST, not "are you sure?" —
// deleteConfirmSentence in OwnerFeedbackScreen is the house voice for an
// irreversible act and this follows it: the note is gone for good, we cannot
// get it back, and when an admin is deleting someone ELSE's note it says
// whose, because that is not obvious from a bin icon.
//
// Inline, never window.confirm(): a native dialog says "localhost says" and
// cannot name the author.
//
// THE ROUTE IS THE GUARD, not this. `canManage` only decides whether the
// affordance is drawn; PATCH and DELETE re-check author-or-admin server-side
// (lib/lead-note-edit), and beta-lead-note-edit-delete proves the refusals
// there with forged requests rather than through this UI.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from './tokens'
import { IconPencil } from '@/components/ui/icons'

// The house voice for an irreversible delete. Exported so a test can assert
// the exact sentence rather than a paraphrase of it.
export function deleteNoteConfirmSentence(note, isOwn) {
  if (isOwn) return 'This deletes your note for good — we can’t get it back.'
  const who = (note?.user_label || '').trim()
  return who
    ? `This deletes ${who}’s note for good — we can’t get it back.`
    : 'This deletes this note for good — we can’t get it back.'
}

// The quiet marker. Kevin's ruling: an edited note SAYS it was edited, but
// quietly — the fact stays legible without shouting over the note itself.
// Absent entirely when never edited, so an untouched note reads exactly as it
// always has.
export function EditedMark({ note }) {
  if (!note?.edited_at) return null
  return (
    <span data-testid={`note-edited-${note.id}`} style={{ fontSize: '10px', color: T.ink.quiet }}>
      {' · edited'}
    </span>
  )
}

const quietBtn = {
  background: 'transparent', border: 'none', padding: '0 3px', cursor: 'pointer',
  color: T.ink.quiet, display: 'inline-flex', alignItems: 'center', fontFamily: 'inherit',
}

export default function NoteActions({ note, canManage = false, isOwn = false, onSave = async () => {}, onDelete = async () => {} }) {
  const [mode, setMode] = useState(null) // null | 'edit' | 'confirm-delete'
  const [draft, setDraft] = useState(note?.text || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  if (!canManage) return null

  const startEdit = () => { setDraft(note?.text || ''); setErr(null); setMode('edit') }
  const cancel = () => { setMode(null); setErr(null) }

  const save = async () => {
    const text = draft.trim()
    // An empty note is a deletion in disguise, and deletion has a
    // confirmation for a reason — so this refuses rather than quietly
    // emptying the note.
    if (!text) { setErr('A note can’t be empty. Delete it instead.'); return }
    if (text === (note?.text || '')) { cancel(); return } // nothing changed, no write
    setBusy(true); setErr(null)
    try {
      await onSave(text)
      setMode(null)
    } catch (e) {
      setErr(`Couldn’t save it. ${e.message || 'Please try again.'}`) // draft stays
    } finally { setBusy(false) }
  }

  const doDelete = async () => {
    setBusy(true); setErr(null)
    try {
      await onDelete()
      // No setMode: the row is gone from under us on success.
    } catch (e) {
      setErr(`Couldn’t delete it. ${e.message || 'Please try again.'}`)
      setBusy(false)
    }
  }

  if (mode === 'edit') {
    return (
      <span style={{ display: 'block', marginTop: '5px' }}>
        <textarea
          data-testid={`note-edit-input-${note.id}`}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={2}
          style={{
            width: '100%', padding: '7px 9px', border: T.border.control,
            borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit',
            outline: 'none', resize: 'vertical',
          }}
        />
        {err && <span style={{ display: 'block', fontSize: '11px', color: T.state.danger.strong, marginTop: '4px' }}>{err}</span>}
        <span style={{ display: 'inline-flex', gap: '8px', marginTop: '5px' }}>
          <button type="button" className="bee-small-action" data-testid={`note-edit-save-${note.id}`}
            disabled={busy} onClick={save}
            style={{ ...quietBtn, color: T.ink.primary, fontWeight: 600, fontSize: '12px', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="bee-small-action" data-testid={`note-edit-cancel-${note.id}`}
            disabled={busy} onClick={cancel}
            style={{ ...quietBtn, fontSize: '12px' }}>
            Cancel
          </button>
        </span>
      </span>
    )
  }

  if (mode === 'confirm-delete') {
    return (
      <span style={{
        display: 'block', marginTop: '5px', background: T.state.danger.soft,
        borderRadius: '8px', padding: '9px 11px',
      }}>
        <span style={{ display: 'block', fontSize: '12px', color: T.state.danger.strong, fontWeight: 600, lineHeight: 1.5 }}>
          {deleteNoteConfirmSentence(note, isOwn)}
        </span>
        {err && <span style={{ display: 'block', fontSize: '11px', color: T.state.danger.strong, marginTop: '4px' }}>{err}</span>}
        <span style={{ display: 'inline-flex', gap: '8px', marginTop: '7px' }}>
          <button type="button" className="bee-small-action" data-testid={`note-delete-confirm-${note.id}`}
            disabled={busy} onClick={doDelete}
            style={{ ...quietBtn, color: T.state.danger.strong, fontWeight: 600, fontSize: '12px', opacity: busy ? 0.5 : 1 }}>
            {busy ? 'Deleting…' : 'Yes, delete it'}
          </button>
          <button type="button" className="bee-small-action" data-testid={`note-delete-cancel-${note.id}`}
            disabled={busy} onClick={cancel}
            style={{ ...quietBtn, fontSize: '12px' }}>
            Keep it
          </button>
        </span>
      </span>
    )
  }

  return (
    // A pencil for edit, because PinnedBuzz already spends that glyph on
    // exactly this meaning. A WORD for delete, because there is no trash icon
    // in the set and an irreversible act should not hide behind a glyph
    // someone has to hover to understand — the Inbox's row verbs ("Put back",
    // "Bin") set that precedent. .bee-small-action is load-bearing: the
    // globals.css `button{font-size:16px!important}` floor discards an inline
    // fontSize, and without the class these tower over the note.
    <span style={{ display: 'inline-flex', gap: '6px', marginLeft: '6px', verticalAlign: 'baseline' }}>
      <button type="button" className="bee-small-action" title="Edit this note"
        data-testid={`note-edit-${note.id}`} onClick={startEdit} style={quietBtn}>
        <IconPencil size={11} />
      </button>
      <button type="button" className="bee-small-action" data-testid={`note-delete-${note.id}`}
        onClick={() => { setErr(null); setMode('confirm-delete') }}
        style={{ ...quietBtn, fontSize: '10px' }}>
        Delete
      </button>
    </span>
  )
}
