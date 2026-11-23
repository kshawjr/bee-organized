'use client'

// PARTNER EMAILS ON A CONTACT (partner emails, slice 5, 2026-11-23). The part
// of a Referral partner's contact sheet that starts and stops their email
// sequences. Built from Kevin's design (brief-and-current,
// src/components/network): the "Email Campaign" field, CampaignPicker (pick a
// sequence, see its emails and timing) and WorkflowConfirmation ("Start email
// workflow?"), redrawn in Bee Hub's tokens.
//
//   · not on anything      "Start email workflow" → the picker → the yes
//   · on a sequence        which one, "Email X of Y", when the next one goes,
//                          and Stop (asked to confirm)
//   · finished / stopped   said plainly; starting again starts from the FIRST
//                          email, and the yes says so
//   · cannot be emailed    a quiet line instead of the button (no address,
//                          unsubscribed), never a dead button
//
// It sends a sequence's KEY, never an id; the server picks the copy and
// checks every rule (app/api/network/contacts/[id]/sequences). Nothing starts
// or stops without the yes; Cancel sends nothing.

import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { T, NET } from '@/components/design/tokens'
import ConfirmChange from './ConfirmChange'

const S = '[data-partner-emails]'
const M = '[data-pe-modal]'
export const PARTNER_EMAILS_CSS = `
${S}{display:grid;gap:10px}
${S} .pe-label{margin:0;font-size:12px;font-weight:700;color:${T.primary}}
${S} .pe-field{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:10px 12px;border:1px solid ${T.input};border-radius:10px;background:${T.card};color:${T.primary};font:inherit;font-size:14px!important;font-weight:600;text-align:left;cursor:pointer}
${S} .pe-field span{flex:1;min-width:0}
${S} .pe-on{border:1px solid ${T.border};border-radius:12px;padding:12px;background:${T.card};display:grid;gap:6px}
${S} .pe-on-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}
${S} .pe-name{margin:0;font-size:14px;font-weight:700;color:${T.primary};min-width:0}
${S} .pe-pill{font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}
${S} .pe-pill[data-status="active"]{background:${T.successSoft};color:${T.success}}
${S} .pe-pill[data-status="completed"]{background:${T.sageSoft};color:${T.primary}}
${S} .pe-pill[data-status="stopped"],${S} .pe-pill[data-status="unsubscribed"]{background:${T.muted};color:${T.mutedFg}}
${S} .pe-line{margin:0;font-size:13px;color:${T.primary};line-height:1.45}
${S} .pe-quiet{margin:0;font-size:12.5px;color:${T.mutedFg};line-height:1.5}
${S} .pe-stop{justify-self:start;min-height:36px;padding:0 12px;border-radius:10px;border:1px solid ${T.input};background:${T.card};color:${T.destructive};font:inherit;font-size:13px!important;font-weight:700;cursor:pointer}
${S} .pe-error{margin:0;font-size:13px;color:${T.destructive}}
${M}{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(26,48,44,.4)}
${M} .pm{display:flex;flex-direction:column;width:100%;max-width:560px;max-height:90dvh;overflow:hidden;border:1px solid ${T.border};border-radius:14px;background:${T.card};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);outline:none}
${M} .pm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid ${T.border}}
${M} h2{margin:0;font-size:19px!important;font-weight:700;color:${T.primary}}
${M} .pm-sub{margin:4px 0 0;font-size:13px;color:${T.mutedFg}}
${M} .pm-x{min-width:40px;min-height:40px;border:0;background:none;color:${T.primary};font-size:20px!important;cursor:pointer;border-radius:10px}
${M} .pm-body{min-height:0;overflow-y:auto;padding:18px 20px;display:grid;gap:18px}
${M} .pm-choices{display:grid;gap:8px}
${M} .pm-choice{display:flex;align-items:flex-start;gap:10px;width:100%;padding:12px;border:1px solid ${T.input};border-radius:10px;background:${T.card};color:${T.primary};font:inherit;text-align:left;cursor:pointer}
${M} .pm-choice[aria-pressed="true"]{background:${T.sageSoft};border-color:${T.sage}}
${M} .pm-choice:disabled{opacity:.6;cursor:default}
${M} .pm-choice strong{display:block;font-size:14px}
${M} .pm-choice small{display:block;margin-top:3px;font-size:12.5px;color:${T.mutedFg};font-weight:400}
${M} .pm-choice span{flex:1;min-width:0}
${M} h3{margin:0 0 10px;font-size:14px!important;font-weight:700;color:${T.primary}}
${M} ol{margin:0;padding:0 0 0 14px;list-style:none;border-left:2px solid ${T.border};display:grid;gap:14px}
${M} .pm-when{margin:0;font-size:12px;font-weight:700;color:${NET.accentFg}}
${M} .pm-subj{margin:3px 0 0;font-size:14px;font-weight:700;color:${T.primary}}
${M} .pm-note{margin:0;padding:10px 12px;border-radius:10px;background:${T.goldSoft};font-size:12.5px;color:${T.primary};line-height:1.45}
${M} .pm-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid ${T.border}}
${M} .pm-btn{min-height:44px;padding:0 16px;border-radius:10px;font:inherit;font-size:14px!important;font-weight:700;border:1px solid ${T.input};background:${T.card};color:${T.primary};cursor:pointer}
${M} .pm-btn[data-primary]{background:${T.primary};border-color:${T.primary};color:${T.primaryFg}}
${M} .pm-btn:disabled{opacity:.55;cursor:default}
${M} .pm-confirm{width:100%;max-width:440px;border:1px solid ${T.border};border-radius:14px;background:${T.card};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);padding:20px;outline:none}
${M} .pm-confirm p{margin:12px 0 0;font-size:14px;color:${T.mutedFg};line-height:1.5}
${M} .pm-confirm strong{color:${T.primary}}
${M} .pm-confirm .pm-foot{padding:0;border:0;margin-top:18px}
${M} .pm-error{margin:12px 0 0;font-size:13px;color:${T.destructive}}
@media (max-width:600px){ ${M}{align-items:flex-end;padding:0} ${M} .pm,${M} .pm-confirm{max-width:none;border-radius:16px 16px 0 0} ${M} .pm{padding-bottom:env(safe-area-inset-bottom,0px)} ${M} .pm-confirm{padding-bottom:calc(20px + env(safe-area-inset-bottom,0px))} }
`

const MailIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>
)
const Chevron = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="m6 9 6 6 6-6" /></svg>
)
const Check = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 6 9 17l-5-5" /></svg>
)

export function dayLabel(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// The quiet line instead of the button: why this partner cannot be started.
export function cannotStartWords(view, first) {
  if (!view) return null
  if (!view.canReceive) {
    switch (view.blockReason) {
      case 'no_email': return `Add an email address for ${first} to start partner emails.`
      case 'unsubscribed':
      case 'address_unsubscribed': return `${first} unsubscribed from partner emails, so none can be started.`
      case 'deleted':
      case 'not_found': return 'This contact has been removed, so no partner emails can be started.'
      default: return `We couldn’t check whether ${first} can be emailed, so nothing can be started right now. Try again in a minute.`
    }
  }
  if (!view.locationActive) return 'Partner emails can be started once this location is active on Bee Hub.'
  return null
}

// "Email 1 of 2 sent · the next goes Feb 21, 2027" and its friends.
export function progressWords(p) {
  if (p.status === 'active') {
    const next = dayLabel(p.nextSendAt)
    return `Email ${p.step} of ${p.total} is next${next ? ` · goes ${next}` : ''}. ${p.sent} of ${p.total} sent so far.`
  }
  if (p.status === 'completed') return `Finished${dayLabel(p.completedAt) ? ` ${dayLabel(p.completedAt)}` : ''} · all ${p.total} sent.`
  if (p.status === 'unsubscribed') return `Ended: they unsubscribed${dayLabel(p.stoppedAt) ? ` ${dayLabel(p.stoppedAt)}` : ''} · ${p.sent} of ${p.total} sent.`
  const why = p.stoppedReason === 'owner_stopped' ? 'Stopped' : p.stoppedReason === 'invalid_recipient' ? 'Stopped: the email address bounced' : 'Stopped'
  return `${why}${dayLabel(p.stoppedAt) ? ` ${dayLabel(p.stoppedAt)}` : ''} · ${p.sent} of ${p.total} sent.`
}
const STATUS_WORD = { active: 'On it now', completed: 'Finished', stopped: 'Stopped', unsubscribed: 'Unsubscribed' }

function useEscape(onClose, busy) {
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [onClose, busy])
}

// CampaignPicker (the design's), for partner sequences. Closes by its ✕,
// Cancel or Escape — never a tap outside (Bee Hub's rule).
export function SequencePicker({ name, sequences, progress, onClose, onContinue }) {
  const startable = (sequences || []).filter((s) => s.available && !(progress || []).some((p) => p.pathKey === s.pathKey && p.status === 'active'))
  const [selected, setSelected] = useState(startable[0]?.pathKey || '')
  const chosen = (sequences || []).find((s) => s.pathKey === selected)
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus({ preventScroll: true }) }, [])
  useEscape(onClose, false)
  return (
    <div data-pe-modal role="presentation">
      <section ref={ref} className="pm" role="dialog" aria-modal="true" aria-label="Choose an email workflow" tabIndex={-1} data-sequence-picker>
        <header className="pm-head">
          <div><h2>Email Campaign</h2><p className="pm-sub">Partner campaigns · {name}</p></div>
          <button type="button" className="pm-x" aria-label="Close" title="Close" onClick={onClose} data-picker-close>✕</button>
        </header>
        <div className="pm-body">
          <div role="group" aria-label="Campaign choices" className="pm-choices">
            {(sequences || []).map((s) => {
              const on = (progress || []).find((p) => p.pathKey === s.pathKey && p.status === 'active')
              const off = !s.available || !!on
              return (
                <button key={s.pathKey} type="button" className="pm-choice" aria-pressed={selected === s.pathKey} disabled={off} onClick={() => setSelected(s.pathKey)} data-sequence-choice={s.pathKey}>
                  <MailIcon />
                  <span><strong>{s.name}</strong><small>{on ? `${name} is on this one now.` : !s.available ? (s.why === 'sequence_paused' ? 'Paused on the Emails screen.' : 'Not available.') : s.description}</small></span>
                  {selected === s.pathKey && <Check />}
                </button>
              )
            })}
          </div>
          {chosen && chosen.available && (
            <div data-picker-emails>
              <h3>Emails &amp; timing</h3>
              <ol>{chosen.emails.map((e) => (
                <li key={e.order}><p className="pm-when">{e.order === chosen.emails[0]?.order && e.when === 'Right away' ? 'Right away, when you start' : e.when}</p><p className="pm-subj">{e.subject}</p>{(e.removed || e.paused) && <p className="pm-sub">{e.removed ? 'Removed: won’t send' : 'Paused: won’t send'}</p>}</li>
              ))}</ol>
            </div>
          )}
          <p className="pm-note">Every workflow starts from its first email. Nothing is sent until you confirm.</p>
        </div>
        <footer className="pm-foot">
          <button type="button" className="pm-btn" onClick={onClose} data-picker-cancel>Cancel</button>
          <button type="button" className="pm-btn" data-primary disabled={!chosen || !chosen.available} onClick={() => onContinue(chosen)} data-picker-continue>Continue</button>
        </footer>
      </section>
    </div>
  )
}

// WorkflowConfirmation (the design's): the yes. Says plainly that it starts
// from the beginning, and that a finished or stopped one sends email 1 again.
export function StartConfirm({ name, sequence, before, busy, error, onConfirm, onClose }) {
  const yes = useRef(null)
  useEffect(() => { yes.current?.focus({ preventScroll: true }) }, [])
  useEscape(onClose, busy)
  const first = sequence.emails[0]
  return (
    <div data-pe-modal role="presentation">
      <section className="pm-confirm" role="alertdialog" aria-modal="true" aria-labelledby="pe-confirm-title" aria-describedby="pe-confirm-words" data-start-confirm>
        <span style={{ color: T.primary }}><MailIcon /></span>
        <h2 id="pe-confirm-title" style={{ marginTop: '8px' }}>Start email workflow?</h2>
        <p id="pe-confirm-words">Starting <strong>{sequence.name}</strong> for <strong>{name}</strong> starts it <strong>from the beginning</strong>: {first ? <>the first email, <strong>&ldquo;{first.subject}&rdquo;</strong>, goes {first.when === 'Right away' ? 'right away' : first.when.toLowerCase()}</> : 'its first email goes first'}{sequence.emails.length > 1 ? `, then the rest on their schedule (${sequence.emails.length} emails in all).` : '.'}</p>
        {before && <p data-confirm-restart>{name} {before.status === 'completed' ? 'already finished this workflow' : 'was on this workflow before'}. Starting it again sends the first email again.</p>}
        {error && <p className="pm-error" role="alert" data-start-error>{error}</p>}
        <div className="pm-foot">
          <button type="button" className="pm-btn" onClick={onClose} disabled={busy} data-confirm-cancel>Cancel</button>
          <button type="button" ref={yes} className="pm-btn" data-primary disabled={busy} onClick={onConfirm} data-confirm-start>{busy ? 'Starting…' : 'Confirm & start workflow'}</button>
        </div>
      </section>
    </div>
  )
}

const START_ERRORS = {
  partner_cannot_receive: 'This partner can’t be emailed (no address, or they unsubscribed). Nothing was started.',
  already_on_sequence: 'They’re already on this workflow. Nothing was changed.',
  sequence_paused: 'That workflow is paused on the Emails screen. Nothing was started.',
  sequence_not_found: 'That workflow isn’t there any more. Nothing was started.',
  sequence_has_no_first_email: 'That workflow has no emails. Nothing was started.',
  location_not_active: 'This location isn’t active on Bee Hub, so nothing can be started.',
  forbidden_read_only: 'You can see this contact but not change it.',
  forbidden_read_only_location: 'This location is read-only right now.',
}
export const startErrorWords = (code) => START_ERRORS[code] || `That didn’t work (${code || 'unknown'}). Nothing was started.`

// The boxes open OVER the sheet, not inside it: the sheet slides in with a
// transform, which would trap a fixed box inside the card. They are drawn in
// the sheet's outer frame (where its own confirmation box lives), else body.
function Over({ anchor, children }) {
  const host = anchor.current?.closest('[data-network-sheet]') || (typeof document !== 'undefined' ? document.body : null)
  return host ? createPortal(<>{children}<style>{PARTNER_EMAILS_CSS}</style></>, host) : null
}

/**
 * Props: contactId, name (for the words), first (first name), fetchImpl.
 */
export default function PartnerEmails({ contactId, name, first, fetchImpl = null }) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  const [view, setView] = useState(null)
  const [problem, setProblem] = useState('')
  const [picking, setPicking] = useState(false)
  const [confirming, setConfirming] = useState(null) // a sequence
  const [stopping, setStopping] = useState(null) // a progress row
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)
  const url = `/api/network/contacts/${contactId}/sequences`
  const anchor = useRef(null)

  const load = () => doFetch(url)
    .then(async (res) => { const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`); setView(j); setProblem('') })
    .catch((e) => setProblem(String(e?.message || e)))
  useEffect(() => { setView(null); load() }, [contactId]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (method, body) => {
    const res = await doFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return { res, json: await res.json().catch(() => ({})) }
  }
  async function start() {
    setBusy(true); setError(null)
    try {
      const { res, json } = await send('POST', { pathKey: confirming.pathKey, confirmed: true })
      if (!res.ok) { setError(startErrorWords(json?.error)); return }
      setNote(json.firstEmail?.sent ? `Started. The first email went to ${first}.` : `Started. The first email goes out within the hour.`)
      setConfirming(null)
      await load()
    } catch { setError('That didn’t go through. Nothing was started.') } finally { setBusy(false) }
  }
  async function stop() {
    setBusy(true); setError(null)
    try {
      const { res, json } = await send('DELETE', { pathKey: stopping.pathKey, confirmed: true })
      if (!res.ok && json?.error !== 'not_on_sequence') { setError(json?.error === 'forbidden_read_only' ? START_ERRORS.forbidden_read_only : 'That didn’t go through. Nothing was stopped.'); return }
      setNote(res.ok ? `Stopped. ${first} gets no more emails from ${stopping.name}.` : 'It had already finished or stopped.')
      setStopping(null)
      await load()
    } catch { setError('That didn’t go through. Nothing was stopped.') } finally { setBusy(false) }
  }

  if (problem) return <p className="pe-quiet" role="alert" data-partner-emails-problem style={{ margin: 0, fontSize: '12.5px', color: T.mutedFg }}>Partner emails couldn&rsquo;t be loaded ({problem}).</p>
  if (!view) return <p style={{ margin: 0, fontSize: '12.5px', color: T.mutedFg }} data-partner-emails-loading>Loading partner emails…</p>
  const progress = [...(view.progress || [])].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1))
  const blocked = cannotStartWords(view, first)
  const startable = (view.sequences || []).some((s) => s.available && !progress.some((p) => p.pathKey === s.pathKey && p.status === 'active'))
  const before = confirming ? progress.find((p) => p.pathKey === confirming.pathKey && p.status !== 'active') : null

  return (
    <div data-partner-emails ref={anchor}>
      <style>{PARTNER_EMAILS_CSS}</style>
      {progress.map((p) => (
        <div key={p.pathKey} className="pe-on" data-progress={p.pathKey} data-status={p.status}>
          <div className="pe-on-head">
            <p className="pe-name">{p.name}</p>
            <span className="pe-pill" data-status={p.status}>{STATUS_WORD[p.status] || p.status}</span>
          </div>
          <p className="pe-line" data-progress-words>{progressWords(p)}</p>
          {p.status === 'active' && <button type="button" className="pe-stop" disabled={busy} onClick={() => { setError(null); setStopping(p) }} data-stop={p.pathKey}>Stop</button>}
        </div>
      ))}
      {blocked
        ? <p className="pe-quiet" data-cannot-start={view.canReceive ? 'location' : view.blockReason}>{blocked}</p>
        : startable && (
          <div>
            <p className="pe-label">Email Campaign</p>
            <button type="button" className="pe-field" aria-haspopup="dialog" onClick={() => { setNote(null); setError(null); setPicking(true) }} data-start-workflow style={{ marginTop: '8px' }}>
              <MailIcon /><span>{progress.some((p) => p.status === 'active') ? 'Start another email workflow' : 'Start email workflow'}</span><Chevron />
            </button>
          </div>
        )}
      {note && <p className="pe-quiet" role="status" data-partner-emails-note>{note}</p>}
      {error && !confirming && !stopping && <p className="pe-error" role="alert">{error}</p>}
      <Over anchor={anchor}>
      {picking && (
        <SequencePicker name={name} sequences={view.sequences} progress={progress} onClose={() => setPicking(false)}
          onContinue={(s) => { setPicking(false); setError(null); setConfirming(s) }} />
      )}
      {confirming && (
        <StartConfirm name={name} sequence={confirming} before={before} busy={busy} error={error} onConfirm={start}
          onClose={() => { if (!busy) { setConfirming(null); setError(null) } }} />
      )}
      {stopping && (
        <ConfirmChange title={`Stop ${stopping.name} for ${name}?`}
          detail={`No more emails from it will go to ${first}. ${stopping.sent} of ${stopping.total} already sent. Starting it again later starts from the first email.`}
          confirmLabel="Stop it" busy={busy} error={error}
          onConfirm={stop} onCancel={() => { if (!busy) { setStopping(null); setError(null) } }} />
      )}
      </Over>
    </div>
  )
}
