// components/hive/shared/UndoWonWizard.jsx
// ─────────────────────────────────────────────────────────────
// UNDO A CLOSED WON (2026-10-21) — one step: say what will happen, ask why,
// confirm. The confirm stays disabled until a reason is typed; the reopen
// route refuses an empty reason (400 close_reason_required) regardless, so
// this is the courtesy, not the rule. The panel owns the write
// (reopenEngagement) — this screen only collects the reason.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { WizardShell, wizPrimaryBtn, wizQuietBtn, wizInput, wizLabel } from './CloseWizardKit'
import { T } from './tokens'

export const UNDO_WON_ACTION = 'Undo won'
export const UNDO_WON_SUMMARY =
  'This deal comes off your won list and goes back to Final Processing, ' +
  'or back to Request if nothing was ever invoiced. Nothing changes in Jobber, ' +
  'and the invoice and payment amounts stay as they are.'

export default function UndoWonWizard({ isMobile = false, onCancel = () => {}, onConfirm = () => {} }) {
  const [reason, setReason] = useState('')
  const missing = !reason.trim()

  const footer = (
    <>
      <button onClick={onCancel} style={wizQuietBtn()}>Cancel</button>
      <button data-bee-undo-won-confirm onClick={() => { if (!missing) onConfirm(reason.trim()) }}
        disabled={missing} style={wizPrimaryBtn(missing)}>
        {UNDO_WON_ACTION}
      </button>
    </>
  )

  return (
    <WizardShell isMobile={isMobile} onClose={onCancel} title="Undo this won deal?" footer={footer}>
      <p data-bee-undo-won-summary style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.5 }}>
        {UNDO_WON_SUMMARY}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {wizLabel('Why are you undoing it?')}
        <textarea data-bee-undo-won-reason value={reason} onChange={e => setReason(e.target.value)} rows={3}
          placeholder="e.g. Marked won on the wrong client"
          style={{ ...wizInput(), resize: 'vertical', minHeight: '64px' }} />
      </div>
    </WizardShell>
  )
}
