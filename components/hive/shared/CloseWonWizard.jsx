// components/hive/shared/CloseWonWizard.jsx
// ─────────────────────────────────────────────────────────────
// Close-WON wizard (doc §5) — the classic CloseOutFlow, rebuilt in the
// beta design. Engagement-scoped, a FOUR-step numbered stepper whose
// completed steps fill green (WizardStepper — the "animation" is that
// transition, no confetti lib):
//   1) Invoice check — reuse the shared "Won gates on settled invoices"
//      (invoicesSettled). Shows the total. NO royalty line (corrected
//      elsewhere — never recompute it here).
//   2) Satisfaction — happy / unhappy. Unhappy writes a REAL
//      "satisfaction follow-up needed" flag (a persisted touchpoints
//      marker). Happy proceeds to the review offer.
//   3) Close out — happy only: offer a Google review request using the
//      LOCATION's reviews_link (locations.reviews_link) when configured;
//      when it isn't, skip gracefully. Plus an optional completion note.
//   4) Re-engage — schedule reactivation. The nurture-pool / day-90 cron
//      is NOT built yet (engagements.nurture_started_at is schema-only,
//      no writer, no worker), so we write a REAL re-engage MARKER (a
//      future-dated touchpoints row the step-5 machinery can pick up) —
//      never a hard-coded 183-day mock, never Zoho.
//
// Won commits through commitEngagementClose (the one shared write path);
// the flags/markers are non-fatal touchpoints written after the close.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { CLOSED_WON } from './stageConfig'
import { commitEngagementClose, writeEngagementMarker, invoicesSettled } from './closeEngagement'
import { OWING_REASON_LABEL, OWING_REASON_PLACEHOLDER, OWING_REASON_HELP } from './finalProcessing'
import { WizardShell, wizPrimaryBtn, wizAccentBtn, wizQuietBtn, wizSeg, wizInput, wizLabel } from './CloseWizardKit'
import { IconExternalLink, IconCheck } from '@/components/ui/icons'
import { T } from './tokens'

const STEPS = [
  { key: 'invoice', label: 'Invoices' },
  { key: 'satisfaction', label: 'Satisfaction' },
  { key: 'closeout', label: 'Close out' },
  { key: 'reengage', label: 'Re-engage' },
]

const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString()

// Default reactivation date: ~90 days out (a sensible default the user
// can change — NOT a fixed mock; the field is editable). Formatted for a
// <input type="date"> value.
function defaultReactivationDate() {
  const d = new Date(Date.now() + 90 * 86400000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// overBalance (issue 119) — the OWNER OVERRIDE entry. The owner says the
// deal is settled in Jobber, Bee Hub still shows a balance, and Kevin's
// ruling is that the owner wins. It runs THIS wizard, not a second close
// path: satisfaction, the review offer and re-engage are exactly as
// valuable on a deal whose money didn't reconcile, and skipping them
// would be the real loss. Only step 1 changes — the invoice step stops
// being a dead end and becomes the place the mandatory reason is asked,
// because that is where the balance is on screen. Steps 2–4 are the
// ordinary path, untouched.
export default function CloseWonWizard({
  engagementId, leadId, invoices = [], totalInvoiced = 0, reviewsLink = null,
  overBalance = false,
  isMobile = false, onCancel = () => {}, onClosed = () => {}, setToast = () => {}, readOnly = false,
}) {
  const [step, setStep] = useState(0)
  const [satisfaction, setSatisfaction] = useState(null) // 'happy' | 'unhappy'
  const [reviewRequested, setReviewRequested] = useState(false)
  const [note, setNote] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [reactivateDate, setReactivateDate] = useState(defaultReactivationDate)
  const [busy, setBusy] = useState(false)

  const settled = invoicesSettled(invoices)
  // The override only means anything while money is actually showing; a
  // settled deal that somehow arrives with the flag runs the plain path.
  const overriding = overBalance && !settled
  const reasonGiven = overrideReason.trim().length > 0
  const total = Number(totalInvoiced) || invoices.reduce((s, i) => s + (Number(i.total) || 0), 0)
  const owing = invoices.reduce((s, i) => s + (i.balance_owing != null ? Number(i.balance_owing) || 0 : 0), 0)
  const happy = satisfaction === 'happy'

  async function confirm() {
    setBusy(true)
    try {
      // On the override the owner's REASON is the note that must survive
      // and be legible on the engagement, so it leads; an optional
      // completion note from step 3 follows it on its own line rather
      // than being dropped. The ordinary path is unchanged.
      const closedNote = overriding
        ? [overrideReason.trim(), note.trim()].filter(Boolean).join('\n')
        : note
      const j = await commitEngagementClose(engagementId, { closeAs: CLOSED_WON, closedNote, overBalance: overriding })
      // Side markers — real, persisted touchpoints; each non-fatal (the
      // Won close is the money truth and has already committed).
      const markers = []
      if (satisfaction === 'unhappy') {
        markers.push({ kind: 'system', label: '⚠️ Satisfaction follow-up needed', occurredAt: null })
      }
      if (happy && reviewRequested && reviewsLink) {
        markers.push({ kind: 'system', label: 'Google review requested', occurredAt: null })
      }
      if (reactivateDate) {
        markers.push({
          kind: 'system',
          label: 'Re-engage · reactivation scheduled',
          occurredAt: new Date(`${reactivateDate}T09:00:00`).toISOString(),
        })
      }
      for (const m of markers) {
        try {
          await writeEngagementMarker({ leadId, engagementId, kind: m.kind, label: m.label, notes: null, occurredAt: m.occurredAt })
        } catch { /* non-fatal — the close stands regardless */ }
      }
      setToast({ kind: 'success', msg: overriding ? 'Closed as won — your reason is on the engagement' : 'Closed as won' })
      onClosed(CLOSED_WON, j)
    } catch (e) {
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  function copyReviewLink() {
    if (!reviewsLink) return
    try { navigator?.clipboard?.writeText?.(reviewsLink) } catch { /* clipboard unavailable */ }
    setReviewRequested(true)
    setToast({ kind: 'success', msg: 'Review link copied' })
  }

  // ── step bodies ───────────────────────────────────────────────
  const invoiceStep = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {wizLabel('Invoices')}
      <div style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: '12px', color: T.ink.muted }}>Total</span>
          <span style={{ fontSize: '16px', fontWeight: 600, color: T.ink.primary, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum }}>{fmtMoney(total)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: settled ? T.accent.deep : T.state.danger.fg }}>
          {settled ? <IconCheck size={14} /> : null}
          {settled
            ? (invoices.length === 0 ? 'No invoices outstanding' : 'All invoices settled')
            : overriding
              ? `Bee Hub still shows ${fmtMoney(owing)} owing — you’re closing this anyway`
              : `Still owing ${fmtMoney(owing)} — settle in Jobber before closing won`}
        </div>
      </div>
      {!settled && !overriding && (
        <p style={{ fontSize: '11px', color: T.ink.muted }}>
          A won deal has no open balance. Collect or write off the remainder in Jobber, or close as lost instead.
        </p>
      )}
      {/* OWNER OVERRIDE (issue 119) — asked here, beside the figure it
          overrides, and required before Next will move. The route
          refuses an empty one too; this is the courteous half. */}
      {overriding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {wizLabel(OWING_REASON_LABEL)}
          <textarea value={overrideReason} onChange={e => setOverrideReason(e.target.value)} rows={2}
            aria-label={OWING_REASON_LABEL} data-bee-owing-reason
            placeholder={OWING_REASON_PLACEHOLDER} style={{ ...wizInput(), resize: 'vertical', minHeight: '48px' }} />
          <p style={{ fontSize: '11px', color: T.ink.muted }}>{OWING_REASON_HELP}</p>
          <p style={{ fontSize: '11px', color: T.ink.muted }}>
            We’re not changing the {fmtMoney(owing)} and we’re not touching Jobber — the figure stays as it is, with your reason beside it.
          </p>
        </div>
      )}
    </div>
  )

  const satisfactionStep = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {wizLabel('How did it go for the client?')}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button onClick={() => setSatisfaction('happy')} style={wizSeg(satisfaction === 'happy')}>😊 Happy</button>
        <button onClick={() => setSatisfaction('unhappy')} style={wizSeg(satisfaction === 'unhappy')}>😕 Unhappy</button>
      </div>
      {satisfaction === 'unhappy' && (
        <p style={{ fontSize: '11px', color: T.state.warning.deep, background: T.state.warning.soft, padding: '8px 10px', borderRadius: T.radius.control }}>
          We’ll flag a satisfaction follow-up so someone reaches back out.
        </p>
      )}
    </div>
  )

  const closeoutStep = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {happy && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {wizLabel('Ask for a Google review')}
          {reviewsLink ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={copyReviewLink}
                  style={{ ...wizSeg(reviewRequested), flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  {reviewRequested ? <IconCheck size={13} /> : null} {reviewRequested ? 'Link copied' : 'Copy review link'}
                </button>
                <a href={reviewsLink} target="_blank" rel="noreferrer" onClick={() => setReviewRequested(true)}
                  style={{ ...wizSeg(false), flex: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', textDecoration: 'none' }}>
                  Open <IconExternalLink size={12} />
                </a>
              </div>
              <p title={reviewsLink} style={{ fontSize: '11px', color: T.ink.quiet, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reviewsLink}</p>
            </div>
          ) : (
            <p style={{ fontSize: '11px', color: T.ink.quiet }}>
              No Google review link is configured for this location — skipping. Add one in Settings to enable review requests.
            </p>
          )}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {wizLabel('Completion note (optional)')}
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
          placeholder="How it wrapped up…" style={{ ...wizInput(), resize: 'vertical', minHeight: '48px' }} />
      </div>
    </div>
  )

  const reengageStep = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {wizLabel('Schedule a reactivation reminder')}
      <input type="date" value={reactivateDate} onChange={e => setReactivateDate(e.target.value)} style={wizInput()} />
      <p style={{ fontSize: '11px', color: T.ink.muted }}>
        We’ll drop a re-engage marker on this date so this client resurfaces for a future check-in.
      </p>
    </div>
  )

  const bodies = [invoiceStep, satisfactionStep, closeoutStep, reengageStep]

  // ── footer per step ───────────────────────────────────────────
  let footer
  if (step === 0) {
    footer = (
      <>
        <button onClick={onCancel} disabled={busy} style={wizQuietBtn()}>Cancel</button>
        {/* Overriding: Next unlocks on the REASON, not on the money —
            that is the whole point. Otherwise the settled gate stands. */}
        <button onClick={() => setStep(1)}
          disabled={busy || (overriding ? !reasonGiven : !settled)}
          style={wizPrimaryBtn(overriding ? !reasonGiven : !settled)}>Next</button>
      </>
    )
  } else if (step === 1) {
    footer = (
      <>
        <button onClick={() => setStep(0)} disabled={busy} style={wizQuietBtn()}>Back</button>
        <button onClick={() => setStep(2)} disabled={busy || satisfaction == null} style={wizPrimaryBtn(satisfaction == null)}>Next</button>
      </>
    )
  } else if (step === 2) {
    footer = (
      <>
        <button onClick={() => setStep(1)} disabled={busy} style={wizQuietBtn()}>Back</button>
        <button onClick={() => setStep(3)} disabled={busy} style={wizPrimaryBtn(false)}>Next</button>
      </>
    )
  } else {
    footer = (
      <>
        <button onClick={() => setStep(2)} disabled={busy} style={wizQuietBtn()}>Back</button>
        {/* The reason is re-checked at the commit, not just at step 1 —
            the field is editable and could have been emptied on the way
            back through. The route refuses it regardless. */}
        <button onClick={confirm} disabled={readOnly || busy || (overriding && !reasonGiven)}
          style={wizAccentBtn(readOnly || busy || (overriding && !reasonGiven))}>
          {overriding ? 'Close as won anyway' : 'Close as won'}
        </button>
      </>
    )
  }

  return (
    <WizardShell isMobile={isMobile} onClose={onCancel} title="Close out — won" steps={STEPS} current={step} footer={footer}>
      {bodies[step]}
    </WizardShell>
  )
}
