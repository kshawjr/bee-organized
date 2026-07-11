// components/hive/shared/inlineEdit.jsx
// ─────────────────────────────────────────────────────────────
// THE inline-edit affordance standard (Kevin, 7/10) — still the quiet
// system, but affordances must be FINDABLE: hairline ≠ washed out.
//
//   View mode  — <EditPencil />: ✎ at readable muted ink (PENCIL_INK,
//     T.ink.secondary — NOT the ink.faint ghost tier), darkening when the host
//     row is hovered (globals.css `.bee-edit-pencil`). Discovery never
//     depends on hover — the base ink is legible at rest.
//   Edit mode  — <InlineEditControls />: the input gains a trailing
//     pair — GREEN CHECK (✓, commits — the visual primary) and muted
//     ✗ (cancels). The buttons make the path visible; they do NOT
//     replace the shortcuts. Enter (⌘-Enter in textareas) still saves,
//     Esc still cancels — pass saveHint so the tooltip tells the truth.
//   Saving     — busy renders the check as a quiet spinner and disables
//     both buttons; a FAILED save keeps edit mode open with the host's
//     inline error (never silently drop a draft).
//
// Both buttons preventDefault on mousedown so a host's blur-save can't
// race the click: focus stays in the input, blur never fires, and the
// click handler is the single writer.
//
// Future inline edits adopt by composition — render EditPencil in the
// view row and InlineEditControls beside the input; never a private ✎
// or a bespoke save affordance. Adopters today: shared/ContactField
// (ClientProfile + EngagementPanel mounts) and EditableDesc
// (ClientProfile + PersonCard request_details, EngagementPanel
// description).
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { TEXT_SUCCESS, TEXT_MUTED } from '@/components/ui/tokens'
import { T } from './tokens'

// Readable muted ink — the affordance floor for view-mode pencils.
export const PENCIL_INK = T.ink.secondary

export function EditPencil({ size = 12, readOnly = false }) {
  // Read-only mode hides the edit entry point entirely.
  if (readOnly) return null
  // cursor:pointer is load-bearing: host rows are cursor:text (editable-
  // text idiom), so without it the pencil — the one element that SAYS
  // "click me" — inherits the I-beam and the affordance goes mute.
  return (
    <span aria-hidden className="bee-edit-pencil"
      style={{ fontSize: `${size}px`, lineHeight: 1, color: PENCIL_INK, flexShrink: 0, cursor: 'pointer', transition: 'color 120ms ease' }}>
      ✎
    </span>
  )
}

const btnBase = {
  width: '22px', height: '22px', padding: 0, borderRadius: T.radius.control,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'inherit', cursor: 'pointer', flexShrink: 0, lineHeight: 1,
  transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
}

export function InlineEditControls({ onSave, onCancel, busy = false, saveHint = 'Enter' }) {
  // Keep focus in the input — see the header note on the blur-save race.
  const hold = (e) => e.preventDefault()
  return (
    <span style={{ display: 'inline-flex', gap: '4px', flexShrink: 0, alignSelf: 'center' }}>
      <button type="button" className="bee-inline-save" aria-label="Save" title={`Save (${saveHint})`}
        disabled={busy} onMouseDown={hold} onClick={onSave}
        style={{
          ...btnBase, fontWeight: 700, color: TEXT_SUCCESS,
          background: T.state.success.soft, border: `0.5px solid ${T.state.success.ring}`,
          cursor: busy ? 'default' : 'pointer',
        }}>
        {busy
          ? <span aria-hidden style={{ width: '10px', height: '10px', borderRadius: T.radius.round, border: `1.5px solid ${T.state.success.ringSoft}`, borderTopColor: TEXT_SUCCESS, animation: 'bee-inline-spin 700ms linear infinite' }} />
          : '✓'}
      </button>
      <button type="button" className="bee-inline-cancel" aria-label="Cancel" title="Cancel (Esc)"
        disabled={busy} onMouseDown={hold} onClick={onCancel}
        style={{
          ...btnBase, color: TEXT_MUTED,
          background: 'transparent', border: T.border.control,
          cursor: busy ? 'default' : 'pointer',
        }}>
        ✗
      </button>
    </span>
  )
}
