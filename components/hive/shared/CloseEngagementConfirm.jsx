// components/hive/shared/CloseEngagementConfirm.jsx
// ─────────────────────────────────────────────────────────────
// THE human close flow — ONE component, ONE write path. Extracted from
// EngagementPanel's inline Won/Lost confirm (doc §4) so that every
// HUMAN close intent shares it: the panel's ··· menu Close AND the
// board's drag-to-close both render THIS box and commit through THIS
// PATCH. Do not fork it.
//
// The popup binds to human UI INTENT, not to the Won stage value —
// AUTOMATED closes (import backfill, webhook derivation, panel-open
// drift recovery) write engagements.stage directly and silently and
// must NEVER route through here (an import of hundreds of clients must
// never raise hundreds of dialogs).
//
// Anatomy (unchanged from the panel original): Won/Lost segmented
// choice — Won gated on settled invoices (paid or zero balance) — the
// Lost reason picker, optional note, Cancel / Close-as buttons.
// Nothing commits until the confirm button: cancel = no write at all
// (the board relies on that to snap the dragged card back).
//
// §8.5: props only, no context, no BeeHub imports.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { CLOSED_WON, CLOSED_LOST } from './stageConfig'

export default function CloseEngagementConfirm({
  engagementId,
  invoices = [],
  initialCloseAs = CLOSED_LOST,   // drag-to-close preselects its column
  onClosed = () => {},            // (stage, patchJson) after the PATCH commits
  onCancel = () => {},            // no write happened — safe to snap back
  setToast = () => {},
}) {
  const [closeAs, setCloseAs] = useState(initialCloseAs)
  const [closeReason, setCloseReason] = useState('lost_no_response')
  const [closeNote, setCloseNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Won gate: every invoice paid or zero balance (no invoices = clear).
  const settled = invoices.length === 0 ||
    invoices.every(i => i.status === 'paid' || Number(i.balance_owing) === 0)

  async function confirmClose() {
    const bodyPatch = closeAs === CLOSED_WON
      ? { stage: CLOSED_WON, closed_reason: 'won', closed_note: closeNote.trim() || undefined }
      : { stage: CLOSED_LOST, closed_reason: closeReason, closed_note: closeNote.trim() || undefined }
    setBusy(true)
    try {
      const res = await fetch(`/api/engagements/${engagementId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPatch),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setToast({ kind: 'success', msg: `Closed as ${closeAs === CLOSED_WON ? 'won' : 'lost'}` })
      onClosed(closeAs, j)
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  const segBtn = (key, label, disabled, why) => (
    <button key={key} disabled={disabled} title={disabled ? why : undefined}
      onClick={() => { setCloseAs(key) }}
      style={{ flex: 1, padding: '7px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 500, fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
        border: `0.5px solid ${closeAs === key && !disabled ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.12)'}`,
        background: closeAs === key && !disabled ? '#fff' : 'transparent',
        color: disabled ? '#c9c7c0' : (closeAs === key ? '#1a1a18' : '#8a8a84') }}>
      {label}
    </button>
  )

  return (
    <div style={{ padding: '12px', background: '#f7f6f4', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase' }}>Close as</p>
      <div style={{ display: 'flex', gap: '8px' }}>
        {segBtn(CLOSED_LOST, 'Lost', false)}
        {segBtn(CLOSED_WON, 'Won', !settled, 'Invoices still owing — settle them in Jobber first (or close as lost / written off)')}
      </div>
      {closeAs === CLOSED_LOST && (
        <select value={closeReason} onChange={e => setCloseReason(e.target.value)}
          style={{ padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', background: '#fff' }}>
          <option value="lost_no_response">No response</option>
          <option value="lost_competitor">Went with someone else</option>
          <option value="lost_not_fit">Not a fit</option>
          <option value="written_off">Written off</option>
          <option value="lost_other">Other</option>
        </select>
      )}
      <input value={closeNote} onChange={e => setCloseNote(e.target.value)} placeholder="Note (optional)…"
        style={{ padding: '8px 10px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none', background: '#fff' }} />
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button onClick={onCancel} disabled={busy}
          style={{ padding: '7px 12px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
          Cancel
        </button>
        <button onClick={confirmClose} disabled={busy || (closeAs === CLOSED_WON && !settled)}
          style={{ padding: '7px 14px', borderRadius: '8px', border: 'none', background: '#1a1a18', color: '#fff', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
          Close as {closeAs === CLOSED_WON ? 'won' : 'lost'}
        </button>
      </div>
    </div>
  )
}
