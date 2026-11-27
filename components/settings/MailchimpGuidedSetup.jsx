'use client'
// components/settings/MailchimpGuidedSetup.jsx
//
// MAILCHIMP GUIDED SET-UP (FL-75, 2026-11-26): one guided path, one step on
// screen at a time, in place of the never-sent-yet page of separate cards.
// Built to Kevin's approved Lovable design, "Bee Organized Control Hive"
// (src/components/settings/MailchimpConnection.tsx + MailchimpPeopleStep.tsx).
//
//   Overview  how many steps; rough numbers both ways; the flow check HERE,
//             before any work; and the honest line that Bee Hub checks again
//             at the end
//   Step 1    Is this your Mailchimp? (account + list)
//   Step 2    Who comes into Bee Hub   (MailchimpImportScreen, embedded)
//   Step 3    Who goes over to Mailchimp (MailchimpReviewScreen, embedded)
//   Step 4    Confirm — the server's own numbers, then one button that says
//             what it does
//   Finish    what actually happened, from the server's answers
//
// THE DIRECTION PICTURE (2026-11-27) sits in the same place on every one of
// these, above the content: both arrows on the overview, step 1, the last
// step and the finish; only Mailchimp → Bee Hub lit on step 2, only Bee Hub →
// Mailchimp on step 3. Its numbers are the headline numbers, nothing else.
//
// IT DECIDES NOTHING. Every number is a server answer (lib/mailchimp-guided.ts
// shapes them). Bringing in and sending over are the slice 6 and 7 routes,
// unchanged: they re-check every rule, refuse while a flow is live or
// Mailchimp can't be read, and confirm the exact number first.
//
// THE PLACE is kept on this device (no migration): the step and which steps
// are finished. The ticks are kept on the server by the two review screens.
//
// WHERE THIS DIFFERS FROM THE DESIGN, ON PURPOSE:
//   • "Is this the same person?" (2026-11-27): phone matches only. Coming in,
//     the design's Same / Different / Leave out are built on step 2; going
//     over keeps slice 6's Yes / No, one at a time.
//   • The design's "Sample options" pills are design-tool controls. Not built.
//   • "Save and leave" is not built: every step is saved as you go, so the
//     owner can simply leave; the line says the place is kept.

import { useCallback, useEffect, useRef, useState } from 'react'
import { T, R, FONT, alpha } from '@/components/design/tokens'
import MailchimpImportScreen from '@/components/settings/MailchimpImportScreen'
import MailchimpReviewScreen from '@/components/settings/MailchimpReviewScreen'
import MailchimpFlowDiagram from '@/components/settings/MailchimpFlowDiagram'
import {
  STEP_NAMES, STEP_COUNT, START, placeKey, readPlace, nextPlace, backPlace, canGoTo, goTo,
  emailCheck, incomingNumbers, outgoingNumbers, tickedToBringIn, leftOutLine, finishLabel, finishLines, sendFinished, peopleWords, flowActive, flowFinish,
} from '@/lib/mailchimp-guided'

const n = (x) => Number(x || 0).toLocaleString('en-US')

export const HONEST_LINE = 'This check is for right now. Bee Hub checks again just before anyone is sent, so if a Mailchimp email is switched back on in the meantime, it will stop then.'
export const PAUSE_HOW = 'In Mailchimp, open Automations, find this name, then choose the arrow on the right of its row and Pause.'
export const CHANGED_WORDS = 'Something changed since you looked, so nothing was done yet. Here are the new numbers.'

const CSS = `
[data-mcg] *{box-sizing:border-box}
[data-mcg] h2,[data-mcg] h3,[data-mcg] p,[data-mcg] ol,[data-mcg] ul{margin:0;padding:0}
[data-mcg] ol,[data-mcg] ul{list-style:none}
[data-mcg-btn]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;width:100%;border-radius:${R.lg};padding:10px 20px;font-family:${FONT.ui};cursor:pointer;white-space:normal;text-align:center}
[data-mcg-btn]>span{font-size:14px;line-height:20px;font-weight:700}
[data-mcg-btn="primary"]{background:${T.primary};color:${T.primaryFg};border:1px solid transparent}
[data-mcg-btn="primary"]:not(:disabled):hover{background:${alpha(T.primary, 0.9)}}
[data-mcg-btn="outline"]{background:${T.card};color:${T.foreground};border:1px solid ${T.border}}
[data-mcg-btn="outline"]:not(:disabled):hover{background:${T.muted}}
[data-mcg-btn]:disabled{cursor:not-allowed}
[data-mcg-btn="primary"]:disabled{background:${T.muted};color:${T.mutedFg};border:1px solid ${T.border}}
[data-mcg-btn="outline"]:disabled{opacity:.6}
[data-mcg-quiet]{display:inline-flex;align-items:center;background:none;border:0;padding:0;min-height:44px;cursor:pointer;font-family:${FONT.ui};color:${T.mutedFg}}
[data-mcg-quiet]>span{font-size:14px;line-height:20px}
[data-mcg-quiet]:hover{color:${T.primary}}
[data-mcg-dot]{width:44px;height:44px;border-radius:9999px;display:grid;place-items:center;font-family:${FONT.ui};font-size:14px;font-weight:700;border:1px solid ${T.border};background:transparent;color:${T.mutedFg};cursor:pointer;padding:0}
[data-mcg-dot][aria-current="step"]{background:${T.primary};border-color:${T.primary};color:${T.primaryFg}}
[data-mcg-dot][data-done="1"]:not([aria-current]){background:${T.sageSoft};border-color:${T.sage || T.border};color:${T.primary}}
[data-mcg-dot]:disabled{cursor:default}
[data-mcg-actions]{display:flex;flex-direction:column-reverse;gap:12px}
[data-mcg] select{min-height:44px;width:100%;border-radius:${R.lg};border:1px solid ${T.border};background:${T.background};color:${T.foreground};font-family:${FONT.ui};font-size:16px;padding:0 12px}
[data-mcg] input[type=checkbox]{width:18px;height:18px;margin:1px 0 0;accent-color:${T.primary};flex-shrink:0}
[data-mcg-h1]{font-size:26px;line-height:1.3}
@media (min-width:640px){
[data-mcg-btn]{width:auto}
[data-mcg-actions]{flex-direction:row;justify-content:space-between}
[data-mcg-h1]{font-size:30px}
}
`
const muted = { fontSize: '14px', lineHeight: 1.625, color: T.mutedFg }
const small = { fontSize: '13px', lineHeight: 1.55, color: T.mutedFg }
const rule = `1px solid ${T.border}`
const amberLine = `1px solid ${alpha(T.gold, 0.3)}`

function Btn({ variant = 'outline', children, ...rest }) {
  return <button type="button" data-mcg-btn={variant} {...rest}><span>{children}</span></button>
}
const Tick = ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
const Lock = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
const Circle = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>

// The flow check, in the design's words. Amber, never red.
export function EmailCheckBox({ check, onCheck, checking, status, children }) {
  if (check.kind === 'clear') return (
    <div data-testid="mcg-check" data-kind="clear" style={{ borderTop: rule, borderBottom: rule, padding: '20px 0', display: 'grid', gap: '8px' }}>
      <p style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', fontSize: '14px', lineHeight: 1.6, color: T.foreground }}>
        <span style={{ color: T.success, flexShrink: 0, marginTop: '1px' }}><Circle /></span>
        <span>Mailchimp won’t email anyone just because they’re added.</span>
      </p>
      {check.conditional.map((c) => (
        <p key={c.name} data-testid="mcg-conditional" style={{ ...small, paddingLeft: '32px' }}>“{c.name}” is on, but it only emails people tagged “{c.tag}”. Bee Hub won’t send that tag.</p>
      ))}
    </div>
  )
  return (
    <section data-testid="mcg-check" data-kind={check.kind} aria-label="Mailchimp email check" style={{ borderRadius: R.lg, border: `1px solid ${alpha(T.gold, 0.5)}`, background: alpha(T.warningSoft, 0.4), padding: '20px 16px' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <span style={{ color: T.warning, flexShrink: 0, marginTop: '4px' }}><Lock /></span>
        <div style={{ minWidth: 0 }}>
          <h3 data-testid="mcg-check-title" style={{ fontFamily: FONT.body, fontSize: '20px', lineHeight: 1.4, fontWeight: 400, color: T.primary }}>{check.kind === 'live' ? 'Can’t add people yet' : 'Couldn’t check Mailchimp'}</h3>
          <p style={{ ...muted, marginTop: '8px' }}>{check.kind === 'live'
            ? 'These emails would go to everyone you send over. Pause them first so people don’t get an unexpected welcome email.'
            : 'We can’t tell whether Mailchimp would email these people. Nothing can be added until we can check.'}</p>
        </div>
      </div>
      {check.kind === 'live' && (
        <ul data-testid="mcg-live-flows" style={{ marginTop: '20px', borderTop: amberLine }}>
          {check.flows.map((name, i) => (
            <li key={i} style={{ padding: '16px 0', borderBottom: amberLine }}>
              <p data-flow-name style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.primary, overflowWrap: 'anywhere' }}>{name}</p>
              <p style={{ ...muted, marginTop: '8px' }}>{PAUSE_HOW}</p>
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
        {children}
        <Btn variant="outline" data-testid="mcg-check-again" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Check again'}</Btn>
      </div>
      {status && <p role="status" data-testid="mcg-check-status" style={{ marginTop: '12px', fontSize: '14px', lineHeight: '20px', color: T.warning }}>{status}</p>}
    </section>
  )
}

function Head({ title, line, big }) {
  return (
    <header>
      <h2 data-testid="mcg-title" data-mcg-h1={big ? '' : undefined} style={{ fontFamily: FONT.body, fontWeight: 400, color: T.primary, ...(big ? {} : { fontSize: '24px', lineHeight: 1.35 }) }}>{title}</h2>
      {line && <p style={{ ...muted, marginTop: '12px' }}>{line}</p>}
    </header>
  )
}
function Amber({ children, testid, role = 'status' }) {
  return <p role={role} data-testid={testid} style={{ fontSize: '14px', lineHeight: 1.55, color: T.warning, background: alpha(T.warningSoft, 0.5), border: `1px solid ${alpha(T.gold, 0.4)}`, borderRadius: R.lg, padding: '10px 14px' }}>{children}</p>
}

async function getJson(doFetch, url, init) {
  const r = await doFetch(url, init || { cache: 'no-store' })
  const j = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, j }
}

export default function MailchimpGuidedSetup({ locationId, accountName, listName, ov, checking, onCheckAgain, fetchImpl, storage, onFinished, onListChanged, onDisconnectAsk, notice = null }) {
  const doFetch = fetchImpl || ((u, i) => fetch(u, i))
  const store = storage === undefined ? (typeof window !== 'undefined' ? window.localStorage : null) : storage
  const key = placeKey(locationId)
  const [place, setPlace] = useState(() => { try { return readPlace(store ? store.getItem(key) : null) } catch { return START } })
  const [saveProblem, setSaveProblem] = useState(false)
  useEffect(() => {
    try { if (store) store.setItem(key, JSON.stringify(place)) } catch { setSaveProblem(true) }
  }, [place, key])
  const top = useRef(null)
  const move = (p) => { setPlace(p); setCheckedAgain(false); try { top.current?.scrollIntoView?.({ block: 'start' }) } catch {} }

  const [checkedAgain, setCheckedAgain] = useState(false)
  const check = emailCheck(ov)
  const safe = check.kind === 'clear'
  const live = ov && ov.live === true
  const list = (listName || '').trim() || 'your Mailchimp list'

  // Is bringing people in switched on here? (Pilot locations only.)
  const [canImport, setCanImport] = useState(null)
  useEffect(() => {
    let off = false
    getJson(doFetch, '/api/mailchimp/import?available=1&location_id=' + encodeURIComponent(locationId || ''))
      .then(({ ok, j }) => { if (!off) setCanImport(ok && j.available === true) })
      .catch(() => { if (!off) setCanImport(false) })
    return () => { off = true }
  }, [locationId])

  // The rough numbers, for the overview — the screens' own answers.
  const [rough, setRough] = useState(null)   // { incoming, outgoing } — each { bringing|sending, leftOut } | 'off' | 'failed'
  useEffect(() => {
    if ((place.step !== 0 && place.step !== 1) || canImport === null) return
    if (place.step === 1 && rough) return
    let off = false
    ;(async () => {
      const loc = encodeURIComponent(locationId || '')
      const [rv, im] = await Promise.all([
        getJson(doFetch, '/api/mailchimp/review?location_id=' + loc).catch(() => ({ ok: false })),
        canImport ? getJson(doFetch, '/api/mailchimp/import?location_id=' + loc).catch(() => ({ ok: false })) : Promise.resolve(null),
      ])
      if (off) return
      setRough({
        outgoing: rv.ok && rv.j?.model ? outgoingNumbers(rv.j.model) : 'failed',
        incoming: im === null ? 'off' : im.ok && im.j?.model ? incomingNumbers(im.j.model) : 'failed',
      })
    })()
    return () => { off = true }
  }, [place.step, canImport, locationId])

  async function checkAgain() { await onCheckAgain(); setCheckedAgain(true) }
  const stillWords = check.kind === 'live' ? 'Checked again. These emails are still on.' : check.kind === 'unreadable' ? 'Checked again. Mailchimp still couldn’t be read.' : null

  // ── Step 1: the list ──
  const [lists, setLists] = useState(null)
  const [listErr, setListErr] = useState(null)
  const [listBusy, setListBusy] = useState(false)
  const [listId, setListId] = useState(null)
  useEffect(() => {
    if (place.step !== 1 || lists) return
    let off = false
    getJson(doFetch, '/api/mailchimp/audiences?location_id=' + encodeURIComponent(locationId || ''))
      .then(({ ok, j }) => { if (!off) { if (ok && Array.isArray(j.audiences)) setLists(j.audiences); else setListErr('Your Mailchimp lists couldn’t be read just now, so the list can’t be changed here.') } })
      .catch(() => { if (!off) setListErr('Your Mailchimp lists couldn’t be read just now, so the list can’t be changed here.') })
    return () => { off = true }
  }, [place.step, lists, locationId])
  const currentId = listId || (lists || []).find((a) => a.name === listName)?.id || ''
  async function changeList(id) {
    if (!id || id === currentId) return
    setListBusy(true); setListErr(null)
    try {
      const { ok, j } = await getJson(doFetch, '/api/mailchimp/audiences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, list_id: id }) })
      if (!ok) { setListErr('That list couldn’t be saved. Please try again.'); return }
      setListId(j.list_id || id)
      onListChanged && onListChanged(j.list_id || id, j.list_name || '')
      // A different list starts the rest again: who goes over is about this list.
      setPlace((p) => ({ v: 1, step: 1, done: [] }))
    } catch { setListErr('That list couldn’t be saved. Please try again.') } finally { setListBusy(false) }
  }

  // ── Step 3: Next saves the review (the first send needs it) ──
  async function reviewDone() {
    try {
      const { ok, j } = await getJson(doFetch, '/api/mailchimp/overview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, reviewed: true }) })
      if (!ok || j?.ok !== true) return { ok: false, words: j?.words || 'Your choices couldn’t be saved, so you can’t move on yet. Please press Next again.' }
    } catch { return { ok: false, words: 'Your choices couldn’t be saved, so you can’t move on yet. Please press Next again.' } }
    move(nextPlace(place))
    return { ok: true }
  }

  // ── Step 4: the server's own numbers ──
  const [ask, setAsk] = useState(null)   // { loading } | { incoming, ids, outgoing, confirm, hold, leftIn, leftOut, nothingToSend }
  const [changed, setChanged] = useState(false)
  const [tagsOk, setTagsOk] = useState([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const loadAsk = useCallback(async () => {
    setAsk({ loading: true }); setTagsOk([])
    const loc = encodeURIComponent(locationId || '')
    try {
      const [im, rv, fresh] = await Promise.all([
        canImport ? getJson(doFetch, '/api/mailchimp/import?location_id=' + loc) : Promise.resolve(null),
        getJson(doFetch, '/api/mailchimp/review?location_id=' + loc),
        getJson(doFetch, '/api/mailchimp/overview?location_id=' + loc).catch(() => ({ ok: false, j: null })),
      ])
      if ((im && !im.ok) || !rv.ok) { setAsk({ error: (im && !im.ok && im.j?.words) || rv.j?.words || 'Bee Hub couldn’t read your Mailchimp just now. Please try again in a few minutes.' }); return }
      const inc = im ? incomingNumbers(im.j.model) : { bringing: 0, leftOut: 0 }
      const ids = im ? tickedToBringIn(im.j.model) : []
      const outRough = outgoingNumbers(rv.j.model)
      // Only ask the sending code when someone would go: with nobody to send,
      // asking would itself count as the first send.
      // The flow check again, fresh: while a flow is live, or Mailchimp can't
      // be read, nothing at all is done here — the design's one off button.
      let confirm = null, hold = null
      const now = emailCheck(fresh.ok ? fresh.j : null)
      if (now.kind === 'live') hold = { kind: 'live', flows: now.flows }
      else if (now.kind === 'unreadable') hold = { kind: 'unreadable' }
      if (!hold && outRough.sending > 0 && live) {
        const s = await getJson(doFetch, '/api/mailchimp/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId }) })
        if (!s.ok) { setAsk({ error: 'Bee Hub couldn’t check just now. Nothing was sent. Please try again in a few minutes.' }); return }
        if (s.j.reason === 'needs_confirmation' && s.j.confirm) confirm = s.j.confirm
        else if (s.j.reason === 'signup_flows_live') hold = { kind: 'live', flows: (s.j.must_pause || []).map((f) => f?.name).filter(Boolean) }
        else if (s.j.reason === 'mailchimp_unreadable') hold = { kind: 'unreadable' }
        else if (s.j.ran) { setResult({ inn: null, out: s.j }); return }   // nobody needed sending after all
        else { setAsk({ error: s.j.words || 'Nothing can be sent just now.' }); return }
      }
      setAsk({ incoming: inc.bringing, ids, leftIn: inc.leftOut, outgoing: confirm ? Number(confirm.count) : 0, outRough, confirm, hold })
    } catch { setAsk({ error: 'Bee Hub couldn’t check just now. Nothing was done. Please try again in a few minutes.' }) }
  }, [locationId, canImport, live])
  useEffect(() => { if (place.step === STEP_COUNT && canImport !== null && !result) loadAsk() }, [place.step, canImport])

  async function finish() {
    if (!ask || ask.loading || ask.error || ask.hold) return
    setBusy(true); setChanged(false)
    let inn = null, out = null
    try {
      if (ask.incoming > 0) {
        const r = await getJson(doFetch, '/api/mailchimp/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, member_ids: ask.ids, count: ask.ids.length }) })
        if (r.status === 409 && r.j?.error === 'changed') { setChanged(true); await loadAsk(); return }
        inn = r.ok ? r.j : { error: true, words: r.j?.words }
        // Nothing goes over if bringing in failed: the owner sees why first.
        if (!r.ok) { setResult({ inn, out: null }); return }
      }
      if (ask.confirm) {
        const c = ask.confirm
        const r = await getJson(doFetch, '/api/mailchimp/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, confirm: { count: c.count, list_id: c.list_id, flows: c.flows, tags_ok: tagsOk } }) })
        out = r.ok ? r.j : { error: true }
        if (!inn && r.ok && r.j.reason === 'needs_confirmation') { setChanged(true); await loadAsk(); return }
      }
      setResult({ inn, out })
    } catch {
      setResult({ inn: inn || null, out: out || { error: true } })
    } finally { setBusy(false) }
  }

  function done() {
    const finished = !result?.out || sendFinished(result.out)
    if (finished && (result?.out || result?.inn)) { try { store && store.removeItem(key) } catch {} }
    else move({ ...place, step: STEP_COUNT })
    const r = result; setResult(null)
    onFinished && onFinished({ sent: !!r?.out && sendFinished(r.out) })
  }

  // ── The direction picture's numbers: the headline numbers only ──
  const [liveIn, setLiveIn] = useState(null)    // step 2's own count, as ticks change
  const [liveOut, setLiveOut] = useState(null)  // step 3's own count, as ticks change
  const roughIn = !rough ? null : rough.incoming === 'off' ? 0 : typeof rough.incoming === 'object' ? rough.incoming.bringing : null
  const roughOut = !rough ? null : typeof rough.outgoing === 'object' ? rough.outgoing.sending : null

  // ── The frame ──
  const step = result ? STEP_COUNT + 1 : place.step
  const flow = (() => {
    const active = flowActive(step)
    if (result) return { active, ...flowFinish(result.inn, result.out) }
    if (step === STEP_COUNT) {
      if (!ask || ask.loading || ask.error) return { active, incoming: null, outgoing: null }
      return { active, incoming: ask.incoming, outgoing: ask.hold || !live ? 0 : ask.outgoing }
    }
    if (step === 2) return { active, incoming: canImport === false ? 0 : liveIn, outgoing: roughOut }
    if (step === 3) return { active, incoming: roughIn, outgoing: liveOut }
    return { active, incoming: roughIn, outgoing: roughOut }
  })()
  return (
    <div data-settings-ui data-mcg data-testid="mcg" data-step={step} style={{ margin: '0 auto', padding: '16px', maxWidth: '672px', fontFamily: FONT.ui, color: T.foreground, display: 'grid', gap: '28px' }}>
      <style>{CSS}</style>
      <div ref={top} style={{ display: 'flex', alignItems: 'center', gap: '12px', borderBottom: rule, paddingBottom: '20px' }}>
        <img src="https://www.google.com/s2/favicons?domain=mailchimp.com&sz=128" alt="" style={{ width: '40px', height: '40px', objectFit: 'contain' }} />
        <h1 style={{ margin: 0, fontFamily: FONT.body, fontSize: '24px', fontWeight: 400, color: T.primary }}>Mailchimp</h1>
      </div>

      {notice && <p role="status" data-testid="mc-reset-notice" style={{ fontSize: '14px', lineHeight: '20px', color: T.foreground, background: T.sageSoft, borderRadius: R.lg, padding: '12px 16px' }}>{notice}</p>}

      {step >= 1 && step <= STEP_COUNT && (
        <nav aria-label="Set-up progress" data-testid="mcg-progress" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <p data-testid="mcg-marker" style={{ fontSize: '14px', fontWeight: 700, color: T.mutedFg }}>Step {step} of {STEP_COUNT}</p>
          <ol style={{ display: 'flex', gap: '8px' }}>
            {STEP_NAMES.map((label, i) => {
              const s = i + 1, isDone = place.done.includes(s)
              return (
                <li key={label}>
                  <button type="button" data-mcg-dot data-done={isDone ? '1' : '0'} data-testid={'mcg-dot-' + s} title={label}
                    aria-label={`${label}${isDone ? ', finished' : ''}`} aria-current={step === s ? 'step' : undefined}
                    disabled={!canGoTo(place, s) || step === s || busy} onClick={() => move(goTo(place, s))}>
                    {isDone && step !== s ? <Tick /> : s}
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>
      )}

      <MailchimpFlowDiagram flow={flow} />

      {/* ── Overview ── */}
      {step === 0 && (
        <div data-testid="mcg-overview" style={{ display: 'grid', gap: '28px' }}>
          <Head big title="Let’s get your people together." line={`Four steps: check it’s your Mailchimp, choose who comes into Bee Hub, choose who goes over to Mailchimp, then decide. About 5 to 10 minutes.`} />
          <div style={{ borderTop: rule, borderBottom: rule }}>
            <p data-testid="mcg-rough-in" style={{ padding: '20px 0', borderBottom: rule, fontSize: '16px', lineHeight: 1.6 }}>
              {!rough ? 'Counting the people in your Mailchimp…'
                : rough.incoming === 'off' ? 'Bringing people in from Mailchimp isn’t switched on for your location yet.'
                : rough.incoming === 'failed' ? 'Bee Hub couldn’t count the people in your Mailchimp just now.'
                : <>About <strong style={{ fontSize: '20px', color: T.primary }}>{n(rough.incoming.bringing)}</strong> {rough.incoming.bringing === 1 ? 'person' : 'people'} in your Mailchimp {rough.incoming.bringing === 1 ? 'isn’t' : 'aren’t'} in Bee Hub yet.</>}
            </p>
            <p data-testid="mcg-rough-out" style={{ padding: '20px 0', fontSize: '16px', lineHeight: 1.6 }}>
              {!rough ? 'Counting the people in Bee Hub…'
                : rough.outgoing === 'failed' ? 'Bee Hub couldn’t count who isn’t in your Mailchimp just now.'
                : <>About <strong style={{ fontSize: '20px', color: T.primary }}>{n(rough.outgoing.sending)}</strong> {rough.outgoing.sending === 1 ? 'person' : 'people'} in Bee Hub {rough.outgoing.sending === 1 ? 'isn’t' : 'aren’t'} in your Mailchimp yet.</>}
            </p>
          </div>
          {rough && leftOutLine(typeof rough.incoming === 'object' ? rough.incoming.leftOut : null, typeof rough.outgoing === 'object' ? rough.outgoing.leftOut : null) && (
            <p data-testid="mcg-rough-left-out" style={small}>{leftOutLine(typeof rough.incoming === 'object' ? rough.incoming.leftOut : null, typeof rough.outgoing === 'object' ? rough.outgoing.leftOut : null)}</p>
          )}
          <EmailCheckBox check={check} onCheck={checkAgain} checking={checking} status={checkedAgain && !checking ? stillWords : null} />
          <p data-testid="mcg-honest" style={muted}>{HONEST_LINE}</p>
          {!live && <Amber testid="mcg-not-live">Sending to Mailchimp isn’t switched on for your location yet. You can get everything ready; we’ll let you know when it’s on.</Amber>}
          <div><Btn variant="primary" data-testid="mcg-begin" disabled={!safe} onClick={() => move(nextPlace(place))}>Let’s begin</Btn></div>
        </div>
      )}

      {/* ── Step 1 ── */}
      {step === 1 && (
        <div data-testid="mcg-step-1" style={{ display: 'grid', gap: '28px' }}>
          <Head title="Is this your Mailchimp?" line="Check the account and the list you want to use." />
          <div style={{ borderTop: rule, borderBottom: rule, padding: '24px 0', display: 'grid', gap: '20px' }}>
            <div>
              <p style={{ fontSize: '14px', fontWeight: 700 }}>Your Mailchimp account</p>
              <p data-testid="mcg-account" style={{ ...muted, marginTop: '4px', overflowWrap: 'anywhere' }}>{accountName || 'Connected'}</p>
            </div>
            <label style={{ display: 'grid', gap: '8px' }}>
              <span style={{ fontSize: '14px', fontWeight: 700 }}>Your Mailchimp list</span>
              {lists && lists.length > 1
                ? <select data-testid="mcg-list" value={currentId} disabled={listBusy} onChange={(e) => changeList(e.target.value)}>
                    {!currentId && <option value="">{list}</option>}
                    {lists.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                : <span data-testid="mcg-list-name" style={{ ...muted, overflowWrap: 'anywhere' }}>{list}</span>}
            </label>
            {listErr && <Amber testid="mcg-list-err">{listErr}</Amber>}
          </div>
          <div data-mcg-actions>
            <Btn variant="outline" data-testid="mcg-back" onClick={() => move(backPlace(place))}>Back</Btn>
            <Btn variant="primary" data-testid="mcg-next" disabled={listBusy} onClick={() => move(nextPlace(place))}>Next — this is the right one</Btn>
          </div>
        </div>
      )}

      {/* ── Step 2 ── */}
      {step === 2 && (
        <div data-testid="mcg-step-2" style={{ display: 'grid', gap: '20px' }}>
          <Head title="Who comes into Bee Hub?" line="These people are in your Mailchimp but not in Bee Hub. Untick anyone you want to leave out. Nobody is brought in until the last step." />
          {canImport === null ? <p style={muted}>Checking…</p>
            : canImport ? <MailchimpImportScreen locationId={locationId} fetchImpl={fetchImpl} embed={{ onBack: () => move(backPlace(place)), onNext: () => move(nextPlace(place)), onCount: setLiveIn }} />
            : <>
                <p data-testid="mcg-import-off" style={muted}>Bringing people in from Mailchimp isn’t switched on for your location yet, so there’s nothing to choose here.</p>
                <div data-mcg-actions>
                  <Btn variant="outline" data-testid="mcg-back" onClick={() => move(backPlace(place))}>Back</Btn>
                  <Btn variant="primary" data-testid="mcg-next" onClick={() => move(nextPlace(place))}>Next</Btn>
                </div>
              </>}
        </div>
      )}

      {/* ── Step 3 ── */}
      {step === 3 && (
        <div data-testid="mcg-step-3" style={{ display: 'grid', gap: '20px' }}>
          <Head title="Who goes over to Mailchimp?" line="These people are in Bee Hub but not in your Mailchimp. Untick anyone you want to leave out. Nobody is sent until the last step." />
          <MailchimpReviewScreen locationId={locationId} onClose={() => move(backPlace(place))} onDone={reviewDone} embed={{ onBack: () => move(backPlace(place)), onCount: setLiveOut }} />
        </div>
      )}

      {/* ── Step 4 ── */}
      {step === STEP_COUNT && (
        <div data-testid="mcg-step-4" style={{ display: 'grid', gap: '28px' }}>
          <Head title="Ready to add your people?" />
          {changed && <Amber testid="mcg-changed">{CHANGED_WORDS}</Amber>}
          {(!ask || ask.loading) && <p style={muted}>Checking everything again…</p>}
          {ask && ask.error && (
            <>
              <Amber testid="mcg-ask-error">{ask.error}</Amber>
              <div data-mcg-actions>
                <Btn variant="outline" data-testid="mcg-back" onClick={() => move(backPlace(place))}>Back</Btn>
                <Btn variant="outline" data-testid="mcg-retry" onClick={loadAsk}>Try again</Btn>
              </div>
            </>
          )}
          {ask && !ask.loading && !ask.error && (() => {
            const label = finishLabel(ask.incoming, ask.outgoing)
            const outLeft = (ask.outRough?.leftOut || 0)
            const heldTags = ask.confirm?.held_tags || []
            return (
              <>
                <div style={{ borderTop: rule, borderBottom: rule }}>
                  <p data-testid="mcg-in-count" style={{ padding: '20px 0', borderBottom: rule, fontSize: '20px', lineHeight: 1.4, fontWeight: 700, color: T.primary }}>
                    {ask.incoming > 0 ? `Bring ${peopleWords(ask.incoming)} into Bee Hub.` : 'Nobody to bring into Bee Hub.'}
                  </p>
                  <p data-testid="mcg-out-count" style={{ padding: '20px 0', fontSize: '20px', lineHeight: 1.4, fontWeight: 700, color: T.primary }}>
                    {ask.hold ? 'Nobody can be sent over yet.'
                      : !live ? 'Nobody can be sent over yet: sending to Mailchimp isn’t switched on for your location.'
                      : ask.outgoing > 0 ? `Send ${peopleWords(ask.outgoing)} over to ${list}.` : 'Nobody to send over.'}
                  </p>
                </div>
                {(ask.leftIn > 0 || outLeft > 0) && (
                  <p data-testid="mcg-left-out" style={small}>{[ask.leftIn > 0 ? `${n(ask.leftIn)} left out coming in.` : '', outLeft > 0 ? `${n(outLeft)} left out going over.` : ''].filter(Boolean).join(' ')}</p>
                )}
                <p style={small}>No email is sent from Bee Hub.</p>
                {heldTags.length > 0 && !ask.hold && (
                  <div data-testid="mcg-held-tags">
                    <p style={{ fontSize: '14px', fontWeight: 700 }}>These tags start an email in Mailchimp</p>
                    <p style={{ ...small, marginTop: '4px' }}>They’re left off unless you tick them, one by one.</p>
                    {heldTags.map((h) => (
                      <label key={h.tag} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginTop: '10px', fontSize: '14px', lineHeight: 1.5, cursor: 'pointer' }}>
                        <input type="checkbox" checked={tagsOk.includes(h.tag)} disabled={busy} aria-label={`Send the tag ${h.tag}`}
                          onChange={(e) => setTagsOk(e.target.checked ? [...tagsOk, h.tag] : tagsOk.filter((t) => t !== h.tag))} />
                        <span><strong>{h.tag}</strong> starts {h.flows.map((f) => `“${f}”`).join(', ')} · {peopleWords(h.people)}</span>
                      </label>
                    ))}
                  </div>
                )}
                {ask.hold && <EmailCheckBox check={ask.hold.kind === 'live' ? { kind: 'live', flows: ask.hold.flows } : { kind: 'unreadable' }} onCheck={loadAsk} checking={false} status={null} />}
                <div data-mcg-actions>
                  <Btn variant="outline" data-testid="mcg-back" disabled={busy} onClick={() => move(backPlace(place))}>Back</Btn>
                  <Btn variant="primary" data-testid="mcg-finish" disabled={busy || !!ask.hold || !label} onClick={finish}>{busy ? 'Working on it…' : (ask.hold ? 'Bring them in & send them over' : (label || 'Nothing to do'))}</Btn>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* ── Finish ── */}
      {result && (() => {
        const f = finishLines(result.inn, result.out, listName)
        const lineEl = (l, i) => l.tone === 'big'
          ? <h3 key={i} style={{ fontSize: '20px', lineHeight: 1.4, fontWeight: 700, color: T.primary }}>{l.text}</h3>
          : l.tone === 'amber' ? <Amber key={i} testid="mcg-finish-amber">{l.text}</Amber>
          : <p key={i} style={{ ...small, marginTop: '4px' }}>{l.text}</p>
        return (
          <div data-testid="mcg-finish-page" style={{ display: 'grid', gap: '28px' }}>
            <header>
              {f.allWell && <span style={{ color: T.success, display: 'block', marginBottom: '12px' }}><Circle /></span>}
              <h2 data-testid="mcg-title" data-mcg-h1="" style={{ fontFamily: FONT.body, fontWeight: 400, color: T.primary }}>{f.allWell ? 'You’re all set.' : 'Here’s what happened.'}</h2>
            </header>
            <div style={{ borderTop: rule, borderBottom: rule, padding: '24px 0', display: 'grid', gap: '24px' }}>
              {f.incoming.length > 0 && <section data-testid="mcg-finish-in" style={{ display: 'grid', gap: '6px' }}>{f.incoming.map(lineEl)}</section>}
              {f.outgoing.length > 0 && <section data-testid="mcg-finish-out" style={{ display: 'grid', gap: '6px' }}>{f.outgoing.map(lineEl)}</section>}
            </div>
            <div><Btn variant="primary" data-testid="mcg-done" onClick={done}>Done</Btn></div>
          </div>
        )
      })()}

      {step >= 1 && step <= STEP_COUNT && (
        <p data-testid="mcg-saved" style={{ ...small, borderTop: rule, paddingTop: '16px' }}>
          {saveProblem ? 'Your browser couldn’t save your place. Keep this page open to finish.' : 'Your place is saved on this device, so you can leave and come back. Your ticks are saved as you make them.'}
        </p>
      )}
      {!result && onDisconnectAsk && (
        <footer style={{ borderTop: step >= 1 && step <= STEP_COUNT ? 'none' : rule, paddingTop: step >= 1 && step <= STEP_COUNT ? 0 : '12px' }}>
          <button type="button" data-mcg-quiet data-testid="mc-disconnect-link" onClick={onDisconnectAsk}><span>Disconnect Mailchimp</span></button>
        </footer>
      )}
    </div>
  )
}
