// components/hive/BookAssessment.jsx
// ─────────────────────────────────────────────────────────────
// Book assessment — the engagement card's door for booking a Jobber
// assessment on the request the card ALREADY sent ("Request only").
//
// WHERE: the card's pinned action bar, in the slot Send to Jobber holds on
// an unsent card. The bar is the card's "what do I do next" row on every
// tab, the two buttons never show together (Send = no request yet; Book =
// a request with no assessment), and it is where the owner already is when
// the client agrees a time. Gate: shared/bookAssessmentGate.
//
// WHAT THE OWNER PICKS: In-person / Virtual, a day, a time — the same tiles,
// date box and 15-minute slots as the send popup (shared/assessmentTime).
// The team is the card's own assignees, exactly as Send to Jobber assigns
// them; this shows who that is and the corner of the card changes it.
//
// ON FAILURE the dialog stays open with what was picked and says what Jobber
// (or the check before it) refused, with the stage — the send popup's shape.
// The route writes nothing locally until Jobber has said yes.
//
// POST /api/engagements/:id/assessment. On success the caller re-reads the
// card (onBooked) so the Assessment milestone appears and this button goes.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { inp, lbl } from './shared/formKit'
import { T } from './shared/tokens'
import { actionBtn } from './shared/cardKit'
import { ASSESSMENT_TIME_OPTIONS, DEFAULT_ASSESSMENT_TIME, buildAssessmentIso } from './shared/assessmentTime'
import { IconCalendar, IconCheck, IconMapPin, IconMessage } from '@/components/ui/icons'

const TYPES = [
  { value: 'in-person', Icon: IconMapPin, label: 'In-Person' },
  { value: 'virtual', Icon: IconMessage, label: 'Virtual' },
]

const btnBase = {
  padding: '8px 15px', borderRadius: T.radius.control, border: 'none',
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
}
const ghostBtn = { ...btnBase, background: 'transparent', color: T.ink.muted, cursor: 'pointer' }
const primaryBtn = (enabled) => ({
  ...btnBase,
  background: enabled ? T.accent.fg : T.ink.disabled,
  color: enabled ? T.accent.onFill : T.ink.quiet,
  cursor: enabled ? 'pointer' : 'not-allowed',
})

export function BookAssessmentDialog({ engagementId, assignees = [], onClose, onBooked }) {
  const isMobile = useIsMobile()
  const [type, setType] = useState('in-person')
  const [date, setDate] = useState('')
  const [time, setTime] = useState(DEFAULT_ASSESSMENT_TIME)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  const team = assignees.map(a => a?.name || a?.email).filter(Boolean)
  const unlinked = assignees.filter(a => a && !a.jobber_user_id).length

  async function book() {
    if (submitting) return
    setErrorMsg(null)
    const iso = buildAssessmentIso(date, time)
    if (!iso) { setErrorMsg('Pick a day for the assessment'); return }
    setSubmitting(true)
    let json
    try {
      const res = await fetch(`/api/engagements/${engagementId}/assessment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_assessment_at: iso, assessment_type: type }),
      })
      json = await res.json().catch(() => ({}))
      if (!res.ok || !json || json.success !== true) {
        setErrorMsg(json && json.error
          ? `${json.error}${json.stage ? ` (${json.stage})` : ''}`
          : `Booking failed (HTTP ${res.status})`)
        setSubmitting(false)
        return
      }
    } catch {
      setErrorMsg('Network error — please try again')
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    onBooked(json, { type, date, time })
  }

  return (
    <OverlayShell isMobile={isMobile} onClose={() => { if (!submitting) onClose() }} maxWidth={380}>
      <div role="dialog" aria-modal="true" aria-label="Book assessment"
        style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>Book assessment</h2>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '4px' }}>
            Books it on the request this card already sent. No new request in Jobber.
          </p>
        </div>

        <div role="radiogroup" aria-label="Assessment type" style={{ display: 'flex', gap: '8px' }}>
          {TYPES.map(t => {
            const on = type === t.value
            return (
              <button key={t.value} type="button" role="radio" aria-checked={on} aria-label={t.label}
                onClick={() => setType(t.value)}
                style={{
                  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '9px',
                  padding: '10px 12px', borderRadius: T.radius.control, cursor: 'pointer', fontFamily: 'inherit',
                  border: on ? `1px solid ${T.accent.fg}` : T.border.control,
                  background: on ? T.accent.soft : T.surface.raised,
                  fontSize: '13px', fontWeight: on ? 600 : 500, color: T.ink.primary,
                }}>
                <t.Icon size={15} style={{ color: on ? T.accent.fg : T.ink.muted }} /> {t.label}
              </button>
            )
          })}
        </div>

        <div>
          <label style={lbl}>Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            min={new Date().toISOString().split('T')[0]} style={inp} aria-label="Assessment date" />
        </div>

        <div>
          <label style={lbl}>Time</label>
          <div style={{ height: '176px', overflowY: 'scroll', border: T.border.control, borderRadius: T.radius.control, background: T.surface.raised, WebkitOverflowScrolling: 'touch' }}>
            {ASSESSMENT_TIME_OPTIONS.map(t => {
              const on = time === t
              return (
                <button key={t} type="button" onClick={() => setTime(t)} style={{
                  width: '100%', padding: '10px 14px', border: 'none', borderBottom: T.border.divider, cursor: 'pointer', textAlign: 'left',
                  fontSize: '14px', fontFamily: 'inherit', fontWeight: on ? 600 : 400,
                  background: on ? T.accent.soft : T.surface.raised, color: on ? T.ink.primary : T.ink.muted,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  {t}
                  {on && <IconCheck size={14} style={{ color: T.accent.fg }} />}
                </button>
              )
            })}
          </div>
          {date && <p style={{ fontSize: '12px', color: T.accent.deep, marginTop: '6px', textAlign: 'center' }}>{date} at {time}</p>}
        </div>

        <p data-book-team="1" style={{ fontSize: '12px', color: T.ink.muted, lineHeight: 1.4 }}>
          {team.length
            ? <>Assigned to {team.join(', ')} — the people on this card.{unlinked ? ` ${unlinked} not linked to Jobber, so not assigned there.` : ''}</>
            : <>Nobody is assigned on this card, so the assessment goes in unassigned. Add someone in the card corner first if it should be theirs.</>}
        </p>

        {errorMsg && (
          <div role="alert" style={{ padding: '10px 12px', background: T.state.danger.soft, border: `1px solid ${T.state.danger.strong}`, borderRadius: T.radius.control }}>
            <p style={{ fontSize: '12px', fontWeight: 600, color: T.state.danger.strong, marginBottom: '2px' }}>Couldn&apos;t book the assessment</p>
            <p style={{ fontSize: '12px', color: T.state.danger.fg, wordBreak: 'break-word' }}>{errorMsg}</p>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button type="button" disabled={submitting} onClick={onClose} style={ghostBtn}>Cancel</button>
          <button type="button" disabled={submitting || !date} onClick={book} style={primaryBtn(!submitting && !!date)}>
            <IconCalendar size={14} /> {submitting ? 'Booking…' : 'Book assessment'}
          </button>
        </div>
      </div>
    </OverlayShell>
  )
}

// The action-bar button + its dialog. Renders nothing unless `show`.
export default function BookAssessment({ show, engagementId, assignees, busy = false, onBooked = () => {} }) {
  const [open, setOpen] = useState(false)
  if (!show) return null
  return (
    <>
      <button type="button" data-testid="book-assessment" style={actionBtn('accent')} disabled={busy} onClick={() => setOpen(true)}>
        <IconCalendar size={14} /> Book assessment
      </button>
      {open && (
        <BookAssessmentDialog
          engagementId={engagementId}
          assignees={assignees}
          onClose={() => setOpen(false)}
          onBooked={(json, pick) => { setOpen(false); onBooked(json, pick) }}
        />
      )}
    </>
  )
}
