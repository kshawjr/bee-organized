// components/hive/shared/inlineEdit.jsx
// ─────────────────────────────────────────────────────────────
// THE inline-edit affordance standard (Kevin, 7/10) — still the quiet
// system, but affordances must be FINDABLE: hairline ≠ washed out.
//
//   View mode  — <EditPencil />: ✎ at readable muted ink (PENCIL_INK,
//     #6b6a64 — NOT the #c9c7c0 ghost tier), darkening when the host
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

// Readable muted ink — the affordance floor for view-mode pencils.
export const PENCIL_INK = '#6b6a64'

export function EditPencil({ size = 12 }) {
  return (
    <span aria-hidden className="bee-edit-pencil"
      style={{ fontSize: `${size}px`, lineHeight: 1, color: PENCIL_INK, flexShrink: 0, transition: 'color 120ms ease' }}>
      ✎
    </span>
  )
}

const btnBase = {
  width: '22px', height: '22px', padding: 0, borderRadius: '6px',
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
          background: 'rgba(29,158,117,0.12)', border: '0.5px solid rgba(29,158,117,0.4)',
          cursor: busy ? 'default' : 'pointer',
        }}>
        {busy
          ? <span aria-hidden style={{ width: '10px', height: '10px', borderRadius: '50%', border: '1.5px solid rgba(29,158,117,0.3)', borderTopColor: TEXT_SUCCESS, animation: 'bee-inline-spin 700ms linear infinite' }} />
          : '✓'}
      </button>
      <button type="button" className="bee-inline-cancel" aria-label="Cancel" title="Cancel (Esc)"
        disabled={busy} onMouseDown={hold} onClick={onCancel}
        style={{
          ...btnBase, color: TEXT_MUTED,
          background: 'transparent', border: '0.5px solid rgba(0,0,0,0.15)',
          cursor: busy ? 'default' : 'pointer',
        }}>
        ✗
      </button>
    </span>
  )
}
