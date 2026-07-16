// components/hive/SendToJobberModal.jsx
// ─────────────────────────────────────────────────────────────
// THE Send-to-Jobber wizard — reskinned onto the hive modal system
// (OverlayShell + tokens + compact buttons), mirroring TouchpointModal's
// shell/header/footer/Esc/role=dialog composition. It REPLACES the legacy
// bespoke Popup (a fixed div, hardcoded colors, no mobile sheet, no Esc,
// no scroll-lock) that lived in BeeHub.
//
// The 4-step wizard is preserved EXACTLY: 'history' -> 'action' ->
// 'request-details' -> 'confirm' (initial 'history' only when the person
// already carries a linked jobberClient, else 'action'). The endpoint, the
// request body, buildScheduledIso, the creation_type derivation, the
// assessment toggle/type/date/time picker, and the address-required guard
// are byte-for-byte the same behavior — only the chrome changed.
//
// ONE CLICK CREATES REAL JOBBER RECORDS (client / property / request /
// assessment). The confirm step is the only guard; it spells out every
// record this send will create (variant 2) and keeps the live-account
// notice so the weight of the button is honest.
//
// THIS COMPONENT DOES NOT OWN THE AFTER-SUCCESS. onDone hands the caller
// (a) the person-shape patch it always handed up AND (b) the raw Jobber
// ids from the response, so the caller can flip its own server-loaded
// gate to "Open in Jobber" without a refetch. The caller closes on a
// confirmed send; a rejected send leaves the modal open with the wizard
// state intact so it is retryable rather than re-walked.
//
// Chrome ownership matches TouchpointModal: OverlayShell brings the
// backdrop, centered-modal / mobile-sheet geometry, scroll-lock, and the
// X. Esc, the dialog role, and padding are added here.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { inp, lbl } from './shared/formKit'
import { T } from './shared/tokens'
import { formatFullDate } from './shared/engagementStatus'
import {
  IconFileText, IconMapPin, IconMessage, IconCalendar, IconClock,
  IconCheck, IconSend, IconAlertTriangle,
} from '@/components/ui/icons'

// SIZING (standing preference — compact, square-ish, never chunky). Shared
// with TouchpointModal's geometry: the shell width is load-bearing, so the
// two constants move together. Footer buttons stay ~33px (8px pad + 13px
// text), the assessment-type pair reads as compact tiles, and nothing is a
// full-width slab.
const MODAL_WIDTH = 380

// One action today — the direct-job option was retired (the server 400-gates
// job_direct since JobCreateAttributes grew required fields we don't
// collect). The chooser stays a step so the wizard's shape is unchanged.
const ACTIONS = [
  { key: 'request', Icon: IconFileText, title: 'Create a Request', desc: 'Add a request in Jobber. Optionally attach an assessment.' },
]

const ASSESSMENT_TYPES = [
  { value: 'in-person', Icon: IconMapPin, label: 'In-Person' },
  { value: 'virtual', Icon: IconMessage, label: 'Virtual' },
]

// Compact footer buttons — mirror TouchpointModal (8px 15px / 13px / not
// full-width). primary=filled accent, ghost=transparent.
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

// A selectable tile — the action chooser and the In-Person/Virtual pair
// share it. Column layout, accent on select, compact.
function Tile({ Icon, label, sub, selected, onSelect, ariaLabel }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={ariaLabel || label}
      onClick={onSelect}
      style={{
        flex: 1, minWidth: 0,
        display: 'flex', alignItems: 'center', gap: '9px',
        padding: '10px 12px', borderRadius: T.radius.control,
        border: selected ? `1px solid ${T.accent.fg}` : T.border.control,
        background: selected ? T.accent.soft : T.surface.raised,
        color: selected ? T.accent.deep : T.ink.muted,
        fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left',
      }}
    >
      <Icon size={18} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: selected ? T.accent.deep : T.ink.primary }}>{label}</span>
        {sub && <span style={{ fontSize: '12px', color: T.ink.muted, lineHeight: 1.35 }}>{sub}</span>}
      </span>
      {selected && <IconCheck size={15} style={{ marginLeft: 'auto', flexShrink: 0, color: T.accent.fg }} />}
    </button>
  )
}

export default function SendToJobberModal({ person, engagementId = null, onDone, onClose }) {
  const isMobile = useIsMobile()

  const [step, setStep] = useState(person.jobberClient ? 'history' : 'action')
  const [action, setAction] = useState(null)
  const [includeAssessment, setIncludeAssessment] = useState(!!person.assessment)
  const [assessmentType, setAssessmentType] = useState(person.assessmentType || 'in-person')
  // Pre-fill from an existing assessment on record ("YYYY-MM-DD at h:mm AM/PM").
  const [date, setDate] = useState(() => {
    if (person.assessment) return person.assessment.split(' at ')[0] || ''
    return ''
  })
  const [time, setTime] = useState(() => {
    if (person.assessment) return person.assessment.split(' at ')[1] || '10:00 AM'
    return '10:00 AM'
  })
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  // Esc — OverlayShell gives the backdrop tap and the X, not this.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Address is required server-side for in-person assessments (matches the
  // route's validation). request_only and virtual assessments proceed with
  // no address — property creation is skipped there.
  function leadHasUsableAddress(p) {
    const arr = Array.isArray(p?.addresses) ? p.addresses : []
    for (const a of arr) {
      if (a && (a.street || a.value)) return true
    }
    if (p?.address && String(p.address).trim()) return true
    return false
  }
  const hasAddress = leadHasUsableAddress(person)
  const wantsAssessment = action === 'request' && includeAssessment && !!date
  const addressRequired = wantsAssessment && assessmentType === 'in-person'
  const blockSendForAddress = addressRequired && !hasAddress

  // 15-min increments 7am–7pm.
  const times = []
  for (let h = 7; h <= 19; h++) {
    for (let m = 0; m < 60; m += 15) {
      const ampm = h < 12 ? 'AM' : 'PM'
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      times.push(`${h12}:${m.toString().padStart(2, '0')} ${ampm}`)
    }
  }

  // Combine YYYY-MM-DD `date` + "h:mm AM/PM" `time` into an ISO string,
  // interpreted in the browser's local timezone (the route converts to the
  // location's zone). UNCHANGED from the legacy popup.
  function buildScheduledIso() {
    if (!date) return null
    const [hm, ampm] = (time || '10:00 AM').split(' ')
    const [hh, mm] = hm.split(':').map(Number)
    let h24 = hh % 12
    if (ampm === 'PM') h24 += 12
    const d = new Date(`${date}T00:00:00`)
    d.setHours(h24, mm, 0, 0)
    return d.toISOString()
  }

  async function confirm() {
    if (submitting) return
    setErrorMsg(null)

    const isReq = action === 'request'
    const hasAssessment = isReq && includeAssessment && date
    // job_direct retired — the chooser only offers Request, matching the
    // server's validation gate.
    const creationType = hasAssessment ? 'request_with_assessment' : 'request_only'

    const body = { creation_type: creationType }
    if (engagementId) body.engagement_id = engagementId
    if (hasAssessment) {
      const iso = buildScheduledIso()
      if (!iso) { setErrorMsg('Pick a date for the assessment'); return }
      body.scheduled_assessment_at = iso
      body.assessment_type = assessmentType
    }

    setSubmitting(true)
    let json
    try {
      const res = await fetch(`/api/leads/${person.id}/send-to-jobber`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      json = await res.json().catch(() => ({}))
      if (!res.ok || !json || json.success !== true) {
        const msg = json && json.error
          ? `${json.error}${json.stage ? ` (${json.stage})` : ''}`
          : `Send failed (HTTP ${res.status})`
        setErrorMsg(msg)
        setSubmitting(false)
        return
      }
    } catch (e) {
      setErrorMsg('Network error — please try again')
      setSubmitting(false)
      return
    }

    // Success — build human-readable timeline entries from the returned ids.
    const newStage = isReq ? 'Request' : 'Job in Progress'
    const matchLabel = json.match_status === 'matched_existing'
      ? `Matched existing client — JC-${json.jobber_client_id}`
      : `New client created in Jobber — JC-${json.jobber_client_id}`
    const stamp = Date.now()
    const entries = [
      { id: `o${stamp}`, type: 'system', method: 'system', label: matchLabel, ts: 'Just now', status: 'done' },
    ]
    if (json.jobber_request_id) {
      entries.push({ id: `o${stamp + 1}`, type: 'system', method: 'system', label: `Request created in Jobber — REQ-${json.jobber_request_id}`, ts: 'Just now', status: 'done' })
    }
    if (json.jobber_job_id) {
      entries.push({ id: `o${stamp + 1}`, type: 'system', method: 'system', label: `Job created in Jobber — JOB-${json.jobber_job_id}`, ts: 'Just now', status: 'done' })
    }
    if (json.jobber_assessment_id && hasAssessment) {
      entries.push({ id: `o${stamp + 2}`, type: 'system', method: 'system', label: `${assessmentType === 'virtual' ? 'Virtual' : 'In-person'} assessment — ${date} at ${time}`, ts: 'Just now', status: 'done' })
    }

    const ref = json.jobber_request_id
      ? `REQ-${json.jobber_request_id}`
      : json.jobber_job_id
        ? `JOB-${json.jobber_job_id}`
        : null

    setSubmitting(false)
    // (a) the person-shape patch the caller has always merged, PLUS
    // (b) the raw Jobber ids so a server-loaded surface (panel/profile) can
    // flip its Send button to "Open in Jobber" live, without a refetch.
    onDone(
      {
        stage: newStage,
        jobberRef: ref,
        assessment: hasAssessment ? `${date} at ${time}` : person.assessment,
        assessmentType: isReq ? assessmentType : person.assessmentType,
        outreachTimeline: [...person.outreachTimeline, ...entries],
      },
      {
        jobber_client_id: json.jobber_client_id || null,
        jobber_request_id: json.jobber_request_id || null,
        jobber_assessment_id: json.jobber_assessment_id || null,
        match_status: json.match_status || null,
      },
    )
  }

  // Linear step path (for the progress bar). history is present only when the
  // person is already a linked client.
  const steps = person.jobberClient
    ? ['history', 'action', 'request-details', 'confirm']
    : ['action', 'request-details', 'confirm']
  const stepIdx = steps.indexOf(step)

  const head = [person.name, person.locationName].filter(Boolean).join(' · ')

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={MODAL_WIDTH}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send to Jobber"
        style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}
      >
        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
            Send to Jobber
          </h2>
          {head && <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '4px' }}>{head}</p>}
        </div>

        {/* Step progress — one thin segment per step, filled through current. */}
        <div role="progressbar" aria-label="Step progress" aria-valuenow={stepIdx + 1} aria-valuemin={1} aria-valuemax={steps.length}
          style={{ display: 'flex', gap: '5px' }}>
          {steps.map((s, i) => (
            <span key={s} data-step-seg={i <= stepIdx ? 'on' : 'off'} style={{
              flex: 1, height: '3px', borderRadius: T.radius.pill,
              background: i <= stepIdx ? T.accent.fg : T.hairline.line,
            }} />
          ))}
        </div>

        {step === 'history' && person.jobberClient && (
          <>
            <div style={{ padding: '10px 12px', background: T.state.success.soft, border: `1px solid ${T.state.success.ringSoft}`, borderRadius: T.radius.control }}>
              <p style={{ fontSize: '13px', fontWeight: 600, color: T.state.success.fg, marginBottom: '6px' }}>Existing client · {person.jobberClient.clientId}</p>
              {person.jobberClient.jobs?.map(j => (
                <div key={j.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 10px', background: T.surface.raised, borderRadius: T.radius.control, marginBottom: '4px' }}>
                  <div>
                    <p style={{ fontSize: '12px', fontWeight: 500, color: T.ink.primary }}>{j.title}</p>
                    <p style={{ fontSize: '11px', color: T.ink.muted }}>{j.id} · {formatFullDate(j.date)}</p>
                  </div>
                  <span style={{ fontSize: '10px', color: T.state.success.fg, background: T.state.success.soft, padding: '2px 7px', borderRadius: T.radius.pill, alignSelf: 'center', fontWeight: 600 }}>{j.status}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setStep('action')} style={primaryBtn(true)}>Continue →</button>
            </div>
          </>
        )}

        {step === 'action' && (
          <>
            <p style={{ fontSize: '13px', color: T.ink.muted }}>{person.jobberClient ? `For ${person.jobberClient.clientId}` : 'A new client will be created in Jobber.'}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {ACTIONS.map(a => (
                <Tile key={a.key} Icon={a.Icon} label={a.title} sub={a.desc} selected={action === a.key} onSelect={() => setAction(a.key)} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
              <button type="button" disabled={!action} onClick={() => action && setStep('request-details')} style={primaryBtn(!!action)}>Continue →</button>
            </div>
          </>
        )}

        {step === 'request-details' && (
          <>
            {/* Include Assessment toggle */}
            <button type="button" role="switch" aria-checked={includeAssessment} aria-label="Include assessment"
              onClick={() => setIncludeAssessment(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
                padding: '11px 13px', borderRadius: T.radius.control, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%',
                background: includeAssessment ? T.accent.soft : T.surface.sunken,
                border: includeAssessment ? `1px solid ${T.accent.fg}` : T.border.control,
              }}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: T.ink.primary }}>Include Assessment</span>
                <span style={{ fontSize: '12px', color: T.ink.muted }}>Attach a scheduled assessment to this request</span>
              </span>
              <span style={{ width: '38px', height: '22px', borderRadius: T.radius.pill, flexShrink: 0, position: 'relative', background: includeAssessment ? T.accent.fg : T.hairline.control }}>
                <span style={{ position: 'absolute', top: '3px', left: includeAssessment ? '19px' : '3px', width: '16px', height: '16px', borderRadius: T.radius.round, background: T.surface.raised, boxShadow: T.shadow.knob }} />
              </span>
            </button>

            {includeAssessment && (
              <>
                <div role="radiogroup" aria-label="Assessment type" style={{ display: 'flex', gap: '8px' }}>
                  {ASSESSMENT_TYPES.map(t => (
                    <Tile key={t.value} Icon={t.Icon} label={t.label} selected={assessmentType === t.value} onSelect={() => setAssessmentType(t.value)} ariaLabel={t.label} />
                  ))}
                </div>

                <div>
                  <label style={lbl}>Date</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} min={new Date().toISOString().split('T')[0]} style={inp} aria-label="Assessment date" />
                </div>

                <div>
                  <label style={lbl}>Time</label>
                  <div style={{ height: '176px', overflowY: 'scroll', border: T.border.control, borderRadius: T.radius.control, background: T.surface.raised, WebkitOverflowScrolling: 'touch' }}>
                    {times.map(t => {
                      const on = time === t
                      return (
                        <button key={t} type="button" onClick={() => setTime(t)} style={{
                          width: '100%', padding: '10px 14px', border: 'none', borderBottom: T.border.divider, cursor: 'pointer', textAlign: 'left',
                          fontSize: '14px', fontFamily: 'inherit', fontWeight: on ? 600 : 400,
                          background: on ? T.accent.soft : T.surface.raised,
                          color: on ? T.ink.primary : T.ink.muted,
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
              </>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setStep('action')} style={ghostBtn}>Back</button>
              <button type="button" onClick={() => setStep('confirm')} style={primaryBtn(true)}>Review →</button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            {/* Variant 2 — itemize the REAL records this send will create,
                reflecting the actual payload (existing vs new client, and the
                assessment only when the toggle is on with a date). */}
            <div>
              <label style={lbl}>This will create in Jobber</label>
              <div style={{ background: T.surface.sunken, borderRadius: T.radius.inset, padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {person.jobberClient ? (
                  <CreateRow title={`Existing client · ${person.jobberClient.clientId}`} detail="Reused — no new client created" muted />
                ) : (
                  <CreateRow title="New client" detail={person.name} />
                )}
                <CreateRow title="Request" detail="Moves this deal to the Request stage" />
                {includeAssessment && date && (
                  <CreateRow
                    title="Assessment appointment"
                    detail={`${assessmentType === 'virtual' ? 'Virtual' : 'In-person'} · ${date} at ${time}`}
                    Glyph={assessmentType === 'virtual' ? IconMessage : IconCalendar}
                  />
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '9px', padding: '10px 12px', background: T.state.warning.bg, border: `1px solid ${T.state.warning.soft}`, borderRadius: T.radius.control }}>
              <IconAlertTriangle size={15} style={{ color: T.state.warning.fg, flexShrink: 0, marginTop: '1px' }} />
              <p style={{ fontSize: '12px', color: T.state.warning.deep, lineHeight: 1.4 }}>This creates records in your live Jobber account.</p>
            </div>

            {blockSendForAddress && (
              <div style={{ padding: '10px 12px', background: T.state.warning.bg, border: `1px solid ${T.state.warning.soft}`, borderRadius: T.radius.control }}>
                <p style={{ fontSize: '12px', fontWeight: 600, color: T.state.warning.fg, marginBottom: '2px' }}>Address required</p>
                <p style={{ fontSize: '12px', color: T.state.warning.deep, wordBreak: 'break-word' }}>An in-person assessment needs a client address. Add one before sending.</p>
              </div>
            )}

            {errorMsg && (
              <div style={{ padding: '10px 12px', background: T.state.danger.soft, border: `1px solid ${T.state.danger.strong}`, borderRadius: T.radius.control }}>
                <p style={{ fontSize: '12px', fontWeight: 600, color: T.state.danger.strong, marginBottom: '2px' }}>Couldn&apos;t send to Jobber</p>
                <p style={{ fontSize: '12px', color: T.state.danger.fg, wordBreak: 'break-word' }}>{errorMsg}</p>
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button type="button" disabled={submitting} onClick={() => { if (!submitting) { setErrorMsg(null); setStep(action === 'request' ? 'request-details' : 'action') } }} style={{ ...ghostBtn, cursor: submitting ? 'not-allowed' : 'pointer' }}>Back</button>
              <button type="button" disabled={submitting || blockSendForAddress} onClick={confirm} style={primaryBtn(!(submitting || blockSendForAddress))}>
                {submitting
                  ? <><IconClock size={16} /> Sending…</>
                  : <><IconSend size={16} /> {errorMsg ? 'Retry' : 'Send to Jobber'}</>}
              </button>
            </div>
          </>
        )}
      </div>
    </OverlayShell>
  )
}

// One itemized "will create" row — a glyph, a title, and the concrete detail
// (the person's name, the stage move, the scheduled slot).
function CreateRow({ title, detail, Glyph = IconCheck, muted = false }) {
  return (
    <div style={{ display: 'flex', gap: '9px', alignItems: 'flex-start' }}>
      <Glyph size={15} style={{ color: muted ? T.ink.quiet : T.accent.fg, flexShrink: 0, marginTop: '2px' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: T.ink.primary }}>{title}</span>
        {detail && <span style={{ fontSize: '12px', color: T.ink.muted, wordBreak: 'break-word' }}>{detail}</span>}
      </div>
    </div>
  )
}
