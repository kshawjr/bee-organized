// components/hive/shared/WriteOffWizard.jsx
// ─────────────────────────────────────────────────────────────
// The WRITTEN-OFF close (2026-09-27) — one step: the amount, a required
// reason, and a confirm that names the amount. Commits through the one
// shared close write (commitEngagementClose, closeAs WRITTEN_OFF); the
// route recomputes the amount from the invoices and refuses an empty
// reason or a $0 write-off, so this screen's figure is a preview of what
// the server will record, never the source of it.
//
// DELIBERATELY NOT the owing override (CloseWonWizard overBalance). That
// one closes WON because the money was settled outside Jobber; this one
// closes WRITTEN OFF because the money is never coming. No satisfaction /
// review / confetti steps here — nothing was won.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { commitEngagementClose } from './closeEngagement'
import {
  WRITTEN_OFF, WRITE_OFF_TITLE, WRITE_OFF_REASON_LABEL, WRITE_OFF_REASON_PLACEHOLDER,
  WRITE_OFF_REASON_MISSING, writeOffSummary, writeOffConfirmLabel, writtenOffAmountFromInvoices,
} from './writtenOff'
import { WizardShell, wizPrimaryBtn, wizQuietBtn, wizInput, wizLabel } from './CloseWizardKit'
import { T } from './tokens'

export default function WriteOffWizard({ engagementId, invoices = [], isMobile = false, onCancel = () => {}, onClosed = () => {}, setToast = () => {}, readOnly = false }) {
  const amount = writtenOffAmountFromInvoices(invoices)
  const [note, setNote] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const missing = !note.trim()

  async function confirm() {
    setTried(true)
    if (missing || readOnly) return
    setBusy(true)
    try {
      const j = await commitEngagementClose(engagementId, { closeAs: WRITTEN_OFF, closedNote: note })
      setToast({ kind: 'success', msg: 'Written off' })
      onClosed('Closed Lost', { ...j, closed_reason: WRITTEN_OFF })
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  const footer = (
    <>
      <button onClick={onCancel} disabled={busy} style={wizQuietBtn()}>Cancel</button>
      <button data-bee-write-off-confirm onClick={confirm} disabled={readOnly || busy || !(amount > 0)}
        style={wizPrimaryBtn(readOnly || busy || !(amount > 0))}>
        {writeOffConfirmLabel(amount)}
      </button>
    </>
  )

  return (
    <WizardShell isMobile={isMobile} onClose={onCancel} title={WRITE_OFF_TITLE} footer={footer}>
      <p data-bee-write-off-summary style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.5 }}>
        {writeOffSummary(amount)}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {wizLabel(WRITE_OFF_REASON_LABEL)}
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
          placeholder={WRITE_OFF_REASON_PLACEHOLDER}
          style={{ ...wizInput(), resize: 'vertical', minHeight: '64px' }} />
        {tried && missing && (
          <p style={{ fontSize: '11px', color: T.state.danger.fg }}>{WRITE_OFF_REASON_MISSING}</p>
        )}
      </div>
    </WizardShell>
  )
}
