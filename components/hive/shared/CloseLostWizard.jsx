// components/hive/shared/CloseLostWizard.jsx
// ─────────────────────────────────────────────────────────────
// Close-LOST wizard (doc §4) — the classic ClosePopup, rebuilt in the
// beta design. Engagement-scoped, two steps:
//   1) Reason — the ADMIN-CONFIGURED close-lost reasons (lookups category
//      'closed_lost_reasons', threaded in via the `reasons` prop off
//      HiveShell's lookupOptions; falls back to DEFAULT_CLOSE_LOST_REASONS
//      when unconfigured). The picked LABEL is stored verbatim in
//      closed_reason. "Other" REQUIRES a note; every other reason takes an
//      optional one.
//   2) Follow-up — "Set a reminder to follow up later?" Yes → a date + a
//      short reason → writes a REAL follow-up (a persisted touchpoints
//      marker via writeEngagementMarker, NOT the old client-side mock).
//      Skip → nothing scheduled.
//
// The terminal close (closed_at / closed_reason / closed_note) commits
// through commitEngagementClose — the ONE shared write path (the board's
// drag-confirm and the Won wizard use it too). Jobber does NOT get a
// lost-lead mutation: the live-schema introspection (2026-07-11) found
// NO quoteArchive and no status field on QuoteEditAttributes — closing
// lost is a Bee Hub sales-layer act with no Jobber side effect, so there
// is no "also archive the quote" checkbox to offer.
//
// LEAD-CLOSE MODE (issue 204): the Inbox row/card menus open this same
// wizard to close a lead who isn't interested. Those leads may have NO
// engagement — closing only the lead does nothing to the Inbox (which reads
// engagements, blind to leads.stage), so the lead derives back by age. So
// when engagementId is absent the wizard find-or-creates one (POST
// /api/engagements { reuse_open }) before committing the close, and when
// stopLeadDrips is set it also fires the lead-side drip/stage-email stop the
// engagement close deliberately omits (POST …/close-not-interested). Both
// are no-ops for the engagement-panel usage (engagementId present,
// stopLeadDrips false), so that path is unchanged.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { CLOSED_LOST } from './stageConfig'
import { commitEngagementClose, writeEngagementMarker, DEFAULT_CLOSE_LOST_REASONS, OTHER_LOST_REASON } from './closeEngagement'
import { WizardShell, wizPrimaryBtn, wizQuietBtn, wizSeg, wizInput, wizLabel } from './CloseWizardKit'
import { T } from './tokens'

const STEPS = [{ key: 'reason', label: 'Reason' }, { key: 'followup', label: 'Follow-up' }]

export default function CloseLostWizard({ engagementId, leadId, reasons = [], isMobile = false, onCancel = () => {}, onClosed = () => {}, setToast = () => {}, readOnly = false, stopLeadDrips = false }) {
  // Admin-configured labels (lookups → HiveShell lookupOptions), with the
  // canonical set as the code-level fallback when the picklist is empty.
  const reasonList = Array.isArray(reasons) && reasons.length > 0 ? reasons : DEFAULT_CLOSE_LOST_REASONS
  const [step, setStep] = useState(0)
  const [reason, setReason] = useState(reasonList[0])
  const [note, setNote] = useState('')
  const [wantFollowUp, setWantFollowUp] = useState(false)
  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpReason, setFollowUpReason] = useState('')
  const [busy, setBusy] = useState(false)

  const otherNeedsNote = reason === OTHER_LOST_REASON && !note.trim()
  const followUpReady = !wantFollowUp || (!!followUpDate && !!followUpReason.trim())

  async function confirm() {
    setBusy(true)
    try {
      // issue 204 — a no-engagement lead: find-or-create an engagement so the
      // Closed Lost lands in System B (Inbox/board/admin), which never reads
      // leads.stage. reuse_open makes the server hand back an existing open
      // engagement rather than found a second (never a duplicate open card).
      let engId = engagementId
      if (!engId) {
        const r = await fetch('/api/engagements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: leadId, reuse_open: true }),
        })
        const jj = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(jj?.error || `HTTP ${r.status}`)
        engId = jj?.engagement?.id
        if (!engId) throw new Error('could not open an engagement to close')
      }
      const j = await commitEngagementClose(engId, { closeAs: CLOSED_LOST, closedReason: reason, closedNote: note })
      // issue 204 — the engagement close never touches leads.stage, so a
      // no-engagement lead's live drips/stage-emails keep running. Fire the
      // lead-side stop the close omits (mirrors markJunk, reason closed_lost).
      // Non-fatal: the close already committed, and the route is fail-closed.
      if (stopLeadDrips && leadId) {
        try {
          await fetch(`/api/leads/${leadId}/close-not-interested`, { method: 'POST' })
        } catch { /* drips are secondary — never unwind a committed close */ }
      }
      // Real follow-up (the current model, not a mock): a persisted
      // touchpoints marker the timeline surfaces and the future nurture
      // scheduler can pick up. Non-fatal — the close already committed.
      if (wantFollowUp && followUpDate && leadId) {
        try {
          await writeEngagementMarker({
            leadId, engagementId: engId, kind: 'reach_out', method: null,
            label: `Follow-up · ${followUpReason.trim() || 'reconnect'}`,
            notes: note.trim() || null,
            occurredAt: new Date(`${followUpDate}T09:00:00`).toISOString(),
          })
        } catch (e) {
          setToast({ kind: 'error', msg: `Closed lost, but the follow-up reminder didn't save: ${e.message}` })
          onClosed(CLOSED_LOST, j)
          return
        }
      }
      setToast({ kind: 'success', msg: wantFollowUp ? 'Closed lost · follow-up set' : 'Closed as lost' })
      onClosed(CLOSED_LOST, j)
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  const reasonStep = (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {wizLabel('Why is this lost?')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {reasonList.map(r => (
            <button key={r} onClick={() => setReason(r)}
              style={{ ...wizSeg(reason === r), textAlign: 'left', flex: 'none' }}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {wizLabel(reason === OTHER_LOST_REASON ? 'Note (required)' : 'Note (optional)')}
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
          placeholder={reason === OTHER_LOST_REASON ? 'Tell us what happened…' : 'Add context…'}
          style={{ ...wizInput(), resize: 'vertical', minHeight: '48px' }} />
        {otherNeedsNote && (
          <p style={{ fontSize: '11px', color: T.state.danger.fg }}>A note is required when the reason is “Other”.</p>
        )}
      </div>
    </>
  )

  const followUpStep = (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {wizLabel('Set a reminder to follow up later?')}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setWantFollowUp(false)} style={wizSeg(!wantFollowUp)}>No, skip</button>
          <button onClick={() => setWantFollowUp(true)} style={wizSeg(wantFollowUp)}>Yes, remind me</button>
        </div>
      </div>
      {wantFollowUp && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {wizLabel('When')}
            <input type="date" value={followUpDate} onChange={e => setFollowUpDate(e.target.value)} style={wizInput()} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {wizLabel('What for')}
            <input value={followUpReason} onChange={e => setFollowUpReason(e.target.value)}
              placeholder="e.g. check back on budget" style={wizInput()} />
          </div>
        </div>
      )}
    </>
  )

  const footer = step === 0 ? (
    <>
      <button onClick={onCancel} disabled={busy} style={wizQuietBtn()}>Cancel</button>
      <button onClick={() => setStep(1)} disabled={busy || otherNeedsNote} style={wizPrimaryBtn(otherNeedsNote)}>Next</button>
    </>
  ) : (
    <>
      <button onClick={() => setStep(0)} disabled={busy} style={wizQuietBtn()}>Back</button>
      <button onClick={confirm} disabled={readOnly || busy || !followUpReady} style={wizPrimaryBtn(readOnly || busy || !followUpReady)}>
        Close as lost
      </button>
    </>
  )

  return (
    <WizardShell isMobile={isMobile} onClose={onCancel} title="Close as lost" steps={STEPS} current={step} footer={footer}>
      {step === 0 ? reasonStep : followUpStep}
    </WizardShell>
  )
}
