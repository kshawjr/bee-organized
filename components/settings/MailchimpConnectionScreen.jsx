'use client'
// components/settings/MailchimpConnectionScreen.jsx
//
// FL-75 SLICE 6 (2026-11-25): the Mailchimp screen once an account and an
// audience are chosen, built to Kevin's Lovable design (kshawjr/mailchimbeehub
// @ eb3d403: MailchimpConnection.tsx and BeforeWeAdd.tsx).
//
//   <MailchimpConnectionScreen>  never synced (three steps) / synced (numbers,
//                                Sync now) / on hold (a live flow, or Mailchimp
//                                couldn't be read — Sync now stays off)
//   <BeforeWeAdd>                the first-sync confirmation: nothing live /
//                                something live / couldn't check
//
// IT DECIDES NOTHING. What it shows comes from GET /api/mailchimp/overview
// (read only) and from what POST /api/mailchimp/sync answered. The switch, the
// flows, who is allowed and the confirmation are all checked again by the
// sending code, on the server, right before it sends.
//
// WHERE THIS DIFFERS FROM THE DESIGN, ON PURPOSE (Kevin's rulings, 2026-11-25):
//   • No typed-name field and no "I understand" tick. The design's "found"
//     confirmation let the owner add people while flows were live after typing
//     their name; Kevin ruled REFUSE, never warn. With a live flow, "Add" is
//     off and the screen says how to pause it.
//   • "Don't want these emails to go out? Pause them…" is left out: pausing is
//     not optional.
//   • Tags that start a live Mailchimp flow get their own unticked box each —
//     the design has no tags here; the ruling needs a yes per tag.
//   • A Settings page keeps the context a pop-up gets from its frame (Kevin,
//     2026-11-24): the confirmation is a page with a way back, not a dialog.

import { useCallback, useEffect, useState } from 'react'
import { T, R, FONT, alpha } from '@/components/design/tokens'
import { IconMail, IconUsers, IconClock, IconExternalLink, IconCheck } from '@/components/ui/icons'
import { SyncResult } from '@/components/settings/MailchimpSyncAnswer'

const MC_LOGO = 'https://www.google.com/s2/favicons?domain=mailchimp.com&sz=128'
const MAILCHIMP_URL = 'https://mailchimp.com'
const n = (x) => Number(x || 0).toLocaleString('en-US')
const people = (x) => `${n(x)} ${x === 1 ? 'person' : 'people'}`

// The screen's state, the same rule as lib/mailchimp-overview.ts connectionState
// (pinned equal by a test). No overview at all = couldn't check = on hold.
export function screenState(o) {
  if (!o || !o.flows || !o.flows.ok || (o.flows.mustPause || []).length > 0) return 'blocked'
  return o.synced ? 'running' : 'setup'
}
export function startAllowed(state, o) {
  if (state === 'blocked' || !o || o.live !== true) return false
  return state === 'running' || o.reviewed === true
}

export function lastSyncedWords(iso, nowMs = Date.now()) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return '—'
  const mins = Math.max(0, Math.round((nowMs - t) / 60000))
  if (mins < 2) return 'Just now'
  if (mins < 60) return `${mins} minutes ago`
  const h = Math.round(mins / 60)
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'Yesterday' : `${d} days ago`
}

const CSS = `
[data-mcc] *{box-sizing:border-box}
[data-mcc] p,[data-mcc] h2,[data-mcc] h3,[data-mcc] ol,[data-mcc] ul{margin:0;padding:0}
[data-mcc] ol,[data-mcc] ul{list-style:none}
[data-mcc] [data-mcc-btn]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;width:100%;border-radius:${R.lg};padding:10px 16px;font-family:${FONT.ui};font-size:14px;line-height:20px;font-weight:700;cursor:pointer;transition:background-color .15s;white-space:normal;text-align:center}
[data-mcc] [data-mcc-btn="primary"]{background:${T.primary};color:${T.primaryFg};border:1px solid transparent}
[data-mcc] [data-mcc-btn="primary"]:not(:disabled):hover{background:${alpha(T.primary, 0.9)}}
[data-mcc] [data-mcc-btn="outline"]{background:${T.card};color:${T.foreground};border:1px solid ${T.border}}
[data-mcc] [data-mcc-btn="outline"]:not(:disabled):hover{background:${T.muted}}
[data-mcc] [data-mcc-btn]:disabled{opacity:.5;cursor:not-allowed}
[data-mcc] [data-mcc-link]{display:inline-flex;align-items:center;gap:4px;min-height:44px;background:none;border:0;padding:0;cursor:pointer;font-family:${FONT.ui};font-size:14px;font-weight:700;color:${T.primary};text-decoration:underline;text-underline-offset:4px}
[data-mcc] [data-mcc-quiet]{background:none;border:0;padding:0;min-height:44px;cursor:pointer;font-family:${FONT.ui};font-size:14px;color:${alpha(T.destructive, 0.75)}}
[data-mcc] [data-mcc-quiet]:hover{color:${T.destructive}}
[data-mcc] [data-mcc-back]{background:none;border:0;padding:0;cursor:pointer;color:${T.mutedFg};font-family:${FONT.ui};display:inline-flex;align-items:center;gap:6px;min-height:36px;font-size:14px}
[data-mcc] [data-mcc-back]:hover{color:${T.foreground}}
[data-mcc] input[type=checkbox]{width:18px;height:18px;margin:1px 0 0;accent-color:${T.primary};flex-shrink:0}
[data-mcc-account]{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:12px;row-gap:8px}
[data-mcc-account] [data-mcc-pill]{grid-column-start:2}
[data-mcc-step]{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:12px;padding:24px 0}
[data-mcc-step] > [data-mcc-btn],[data-mcc-step] > [data-mcc-link]{grid-column-start:2;justify-self:start;width:auto}
[data-mcc-tiles]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
[data-mcc-actions]{display:flex;flex-direction:column;gap:12px}
@media (min-width:640px){
[data-mcc] [data-mcc-btn]{width:auto}
[data-mcc-account]{grid-template-columns:auto minmax(0,1fr) auto;column-gap:16px}
[data-mcc-account] [data-mcc-pill]{grid-column-start:3}
[data-mcc-step]{grid-template-columns:2rem minmax(0,1fr) auto;gap:16px}
[data-mcc-step] > [data-mcc-btn],[data-mcc-step] > [data-mcc-link]{grid-column-start:auto;align-self:center}
[data-mcc-tiles]{grid-template-columns:repeat(3,minmax(0,1fr))}
[data-mcc-actions]{flex-direction:row}
}
`

const muted = { fontSize: '14px', lineHeight: 1.625, color: T.mutedFg }
const small = { fontSize: '12px', lineHeight: '16px', color: T.mutedFg }
const Lock = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /><circle cx="12" cy="16" r="1" /></svg>
)
const Refresh = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
)
const ArrowLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
)

function Btn({ variant = 'outline', children, ...rest }) {
  return <button type="button" data-mcc-btn={variant} {...rest}>{children}</button>
}
function OpenMailchimp() {
  return <a data-mcc-link href={MAILCHIMP_URL} target="_blank" rel="noreferrer">Open Mailchimp<IconExternalLink size={16} /></a>
}

// The design's four steps, verified in Mailchimp by Kevin (74f7c67).
export const PAUSE_STEPS = [
  <>In Mailchimp, go to <strong style={{ color: T.foreground }}>Automations</strong>.</>,
  <>Find the flow in the list.</>,
  <>Click the arrow on the right of its row.</>,
  <>Choose <strong style={{ color: T.foreground }}>Pause</strong>.</>,
]
function PauseSteps() {
  return (
    <ol data-testid="mc-pause-steps" style={{ display: 'grid', gap: '8px', marginTop: '8px' }}>
      {PAUSE_STEPS.map((s, i) => (
        <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <span style={{ marginTop: '2px', width: '20px', height: '20px', flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: R.full, border: `1px solid ${T.border}`, fontSize: '11px', fontWeight: 700, color: T.foreground }}>{i + 1}</span>
          <span style={{ ...muted, fontFamily: FONT.body }}>{s}</span>
        </li>
      ))}
    </ol>
  )
}

// One flow: its name and what it sends ("Sends “Welcome to …”").
function FlowRows({ flows, testid }) {
  return (
    <ul data-testid={testid} style={{ display: 'grid', gap: '8px', marginTop: '12px' }}>
      {flows.map((f, i) => (
        <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card, padding: '12px' }}>
          <span style={{ marginTop: '2px', color: T.mutedFg, flexShrink: 0 }}><IconMail size={16} /></span>
          <span style={{ minWidth: 0 }}>
            <span data-flow-name style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: T.foreground }}>{f.name}</span>
            {(f.subjects || []).map((s) => <span key={s} style={{ display: 'block', ...small, overflowWrap: 'anywhere' }}>Sends “{s}”</span>)}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ─── The confirmation ──────────────────────────────────────────────────────
//
// kind: 'ask'        nothing live — confirm = the server's needs_confirmation answer
//       'live'       something live — flows = the server's must_pause list
//       'unreadable' couldn't check
export function BeforeWeAdd({ kind, confirm, flows, listName, changed, busy, onYes, onCheckAgain, onCancel }) {
  const [tagsOk, setTagsOk] = useState([])
  const list = (confirm?.list_name || listName || '').trim() || 'your Mailchimp audience'
  const count = kind === 'ask' ? Number(confirm?.count || 0) : null
  const held = kind === 'ask' ? (confirm?.held_tags || []) : []
  const paused = kind === 'ask' ? (confirm?.paused_flows || []) : []
  return (
    <div data-testid="mc-before-we-add" data-kind={kind}>
      <button type="button" data-mcc-back onClick={onCancel} disabled={busy}><ArrowLeft />Back to Mailchimp</button>
      <p style={{ marginTop: '16px', fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.025em', color: T.mutedFg }}>Last step · Nothing has been sent yet</p>
      <h3 style={{ marginTop: '4px', fontSize: '24px', lineHeight: '32px', fontWeight: 300, color: T.foreground, fontFamily: FONT.heading }}>Before we add these people</h3>
      {changed && <p role="status" style={{ marginTop: '12px', ...muted, color: T.warning }}>Something changed in Mailchimp since you looked, so nothing was added. Here it is again.</p>}

      {kind === 'ask' && (
        <>
          <p data-testid="mc-confirm-count" style={{ marginTop: '12px', fontSize: '16px', color: T.foreground }}>
            <strong>{people(count)}</strong> will be added to <strong>{list}</strong>.
          </p>
          <div style={{ marginTop: '20px', borderRadius: R.xl, border: `1px solid ${T.border}`, background: T.card, padding: '16px' }}>
            <p style={{ fontSize: '14px', color: T.foreground }}>Nothing in your Mailchimp will email these people automatically.</p>
            {paused.length > 0 && (
              <p data-testid="mc-paused-flows" style={{ ...small, marginTop: '8px' }}>
                Paused, so they won’t send: {paused.map((f) => f.name).join(', ')}. Keep them paused until this finishes.
              </p>
            )}
          </div>
          {held.length > 0 && (
            <div data-testid="mc-held-tags" style={{ marginTop: '16px' }}>
              <p style={{ fontSize: '14px', fontWeight: 700, color: T.foreground }}>These tags start an email in Mailchimp</p>
              <p style={{ ...small, marginTop: '4px' }}>They are left off unless you tick them, one by one.</p>
              {held.map((h) => {
                const on = tagsOk.includes(h.tag)
                return (
                  <label key={h.tag} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginTop: '10px', fontSize: '14px', color: T.foreground, lineHeight: 1.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={on} disabled={busy} aria-label={`Carry the tag ${h.tag}`}
                      onChange={(e) => setTagsOk(e.target.checked ? [...tagsOk, h.tag] : tagsOk.filter((t) => t !== h.tag))} />
                    <span><strong>{h.tag}</strong> — starts {h.flows.map((f) => `“${f}”`).join(', ')} · {people(h.people)}</span>
                  </label>
                )
              })}
            </div>
          )}
        </>
      )}

      {kind === 'live' && (
        <>
          <p style={{ marginTop: '12px', fontSize: '16px', color: T.foreground }}>Nobody will be added to <strong>{list}</strong> while these are on.</p>
          <div style={{ marginTop: '20px', borderRadius: R.xl, border: `1px solid ${T.gold}`, background: alpha(T.goldSoft, 0.4), padding: '16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: T.foreground }}>Your Mailchimp would email them automatically.</p>
            <FlowRows flows={flows || []} testid="mc-live-flows" />
            <p style={{ ...small, marginTop: '12px' }}>Some flows only email certain people, so not everyone added would get every email.</p>
          </div>
          <div style={{ marginTop: '16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: T.foreground }}>Turn these off before we add anyone. Bee Hub sends its own welcome email, so these would send a second one.</p>
            <PauseSteps />
            <p style={{ marginTop: '12px', fontSize: '14px', lineHeight: 1.625, color: T.foreground, fontFamily: FONT.body }}>Once they are paused, come back here and press Check again. Bee Hub can’t pause them for you.</p>
            <p style={{ ...small, marginTop: '4px', fontFamily: FONT.body }}>Later, you can turn them back on with “Turn back on” in the same place.</p>
            <div style={{ marginTop: '4px' }}><OpenMailchimp /></div>
          </div>
        </>
      )}

      {kind === 'unreadable' && (
        <div style={{ marginTop: '20px', borderRadius: R.xl, border: `1px solid ${alpha(T.gold, 0.5)}`, background: alpha(T.warningSoft, 0.4), padding: '16px' }}>
          <p style={{ fontSize: '16px', color: T.foreground }}>We need to check Mailchimp first</p>
          <p style={{ ...muted, marginTop: '8px' }}>Bee Hub couldn’t read Mailchimp to check whether new people would receive automatic emails. Nothing will be added until we can check.</p>
          <p style={{ ...muted, marginTop: '8px' }}>Try checking again in a moment. If it still can’t be checked, open Mailchimp to make sure you can sign in.</p>
          <div style={{ marginTop: '4px' }}><OpenMailchimp /></div>
        </div>
      )}

      <div data-mcc-actions style={{ marginTop: '24px', paddingTop: '16px', borderTop: `1px solid ${T.border}` }}>
        {kind === 'ask'
          ? <Btn variant="primary" data-testid="mc-add" disabled={busy} onClick={() => onYes(tagsOk)}>{busy ? 'Adding…' : `Add ${people(count)}`}</Btn>
          : <>
              <Btn variant="primary" data-testid="mc-add" disabled>Add people</Btn>
              <Btn variant="outline" data-testid="mc-check-again" disabled={busy} onClick={onCheckAgain}><Refresh />{busy ? 'Checking…' : 'Check again'}</Btn>
            </>}
        <Btn variant="outline" disabled={busy} onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  )
}

// ─── The connection screen ─────────────────────────────────────────────────
export default function MailchimpConnectionScreen({ locationId, accountName, listName, onReview, onDisconnect, disconnectBusy, fetchImpl }) {
  const doFetch = fetchImpl || ((u, i) => fetch(u, i))
  const [ov, setOv] = useState(undefined)        // undefined = loading, null = couldn't load
  const [checking, setChecking] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [ask, setAsk] = useState(null)           // { kind, confirm?, flows?, changed? } — the confirmation page
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  const [disconnecting, setDisconnecting] = useState(false)

  const load = useCallback(async () => {
    setChecking(true)
    try {
      const r = await doFetch('/api/mailchimp/overview?location_id=' + encodeURIComponent(locationId || ''), { cache: 'no-store' })
      setOv(r.ok ? await r.json() : null)
    } catch { setOv(null) } finally { setChecking(false) }
  }, [locationId])
  useEffect(() => { load() }, [load])

  async function sync(confirm) {
    setSyncing(true); setErr(null); setResult(null)
    try {
      const r = await doFetch('/api/mailchimp/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirm ? { location_id: locationId, confirm } : { location_id: locationId }),
      })
      if (!r.ok) { setErr('Nothing was sent. Bee Hub couldn’t start the sync — please try again in a few minutes.'); setAsk(null); return }
      const j = await r.json()
      if (j.reason === 'needs_confirmation' && j.confirm) { setAsk({ kind: 'ask', confirm: j.confirm, changed: !!confirm }); return }
      if (j.reason === 'signup_flows_live') {
        if (ask || (ov && !ov.synced)) setAsk({ kind: 'live', flows: j.must_pause || [] })
        else setAsk(null)
        await load(); return
      }
      if (j.reason === 'mailchimp_unreadable') {
        if (ask || (ov && !ov.synced)) setAsk({ kind: 'unreadable' })
        else { setAsk(null); setResult(j) }
        await load(); return
      }
      setAsk(null); setResult(j); await load()
    } catch {
      setErr('Nothing was sent. Bee Hub couldn’t start the sync — please try again in a few minutes.'); setAsk(null)
    } finally { setSyncing(false) }
  }

  const state = ov === undefined ? 'loading' : screenState(ov)
  const allowed = ov ? startAllowed(state, ov) : false
  const flowsUnread = state === 'blocked' && !(ov && ov.flows && ov.flows.ok)
  const pill = state === 'loading' ? { t: 'Checking…', fg: T.mutedFg, bg: T.muted }
    : state === 'running' ? { t: 'Syncing', fg: T.success, bg: T.successSoft }
    : state === 'blocked' ? { t: 'On hold', fg: T.warning, bg: T.warningSoft }
    : { t: 'Not syncing yet', fg: T.mutedFg, bg: T.muted }
  const list = (listName || '').trim() || 'your audience'
  const partial = ov?.last_run && !ov.last_run.complete ? ov.last_run : null
  const notLive = ov && ov.live !== true

  return (
    <div data-settings-ui data-mcc data-testid="mc-connection" data-state={state} style={{ margin: '0 auto', padding: '16px', maxWidth: '672px', fontFamily: FONT.ui, color: T.foreground }}>
      <style>{CSS}</style>

      {ask ? (
        <BeforeWeAdd kind={ask.kind} confirm={ask.confirm} flows={ask.flows} listName={listName} changed={ask.changed} busy={syncing}
          onYes={(tagsOk) => sync({ count: ask.confirm.count, list_id: ask.confirm.list_id, flows: ask.confirm.flows, tags_ok: tagsOk })}
          onCheckAgain={() => sync(null)}
          onCancel={() => setAsk(null)} />
      ) : (
        <div style={{ display: 'grid', gap: '24px' }}>
          <div data-mcc-account style={{ borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '20px 0' }}>
            <span style={{ width: '48px', height: '48px', display: 'grid', placeItems: 'center', borderRadius: R.xl, border: `1px solid ${T.border}`, background: T.card, padding: '8px' }}>
              <img src={MC_LOGO} alt="Mailchimp" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: '16px', fontWeight: 700, color: T.primary, overflowWrap: 'anywhere' }}>{accountName || 'Mailchimp'}</p>
              <p style={{ marginTop: '4px', fontSize: '14px', color: T.mutedFg, overflowWrap: 'anywhere' }}>Audience · {list}</p>
            </div>
            <span data-mcc-pill data-testid="mc-pill" style={{ display: 'inline-flex', width: 'fit-content', alignItems: 'center', gap: '6px', borderRadius: R.full, padding: '4px 12px', fontSize: '12px', fontWeight: 700, color: pill.fg, background: pill.bg }}>
              <span style={{ width: '6px', height: '6px', borderRadius: R.full, background: 'currentColor' }} />{pill.t}
            </span>
          </div>

          {notLive && (
            <p data-testid="mc-not-live" style={{ ...muted }}>Sending to Mailchimp isn’t switched on for your location yet. We’ll let you know when it is.</p>
          )}

          {state === 'setup' && (
            <>
              <ol style={{ borderRadius: R.xxl, border: `1px solid ${T.border}`, background: T.card, padding: '0 20px' }}>
                <li data-mcc-step style={{ borderBottom: `1px solid ${T.border}` }}>
                  <span aria-label={ov.reviewed ? 'Review completed' : undefined} style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', borderRadius: R.full, fontSize: '14px', fontWeight: 700, background: ov.reviewed ? T.successSoft : T.sageSoft, color: ov.reviewed ? T.success : T.primary }}>{ov.reviewed ? <IconCheck size={16} /> : '1'}</span>
                  <div>
                    <h2 style={{ fontSize: '16px', fontWeight: 700, color: T.primary }}>Review who goes to Mailchimp</h2>
                    <p style={{ ...muted, marginTop: '4px' }}>Choose which of your contacts get added.</p>
                    {ov.reviewed && <p data-testid="mc-reviewed" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: T.success }}><IconCheck size={14} />Review complete</p>}
                  </div>
                  <Btn variant="outline" data-testid="mc-open-review" onClick={onReview}>{ov.reviewed ? 'Review again' : 'Review who goes to Mailchimp'}</Btn>
                </li>
                <li data-mcc-step style={{ borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', borderRadius: R.full, border: `1px solid ${T.border}`, fontSize: '14px', color: T.mutedFg }}>2</span>
                  <div>
                    <h2 style={{ fontSize: '16px', fontWeight: 700, color: T.primary }}>Pause your Mailchimp automations</h2>
                    <p style={{ ...muted, marginTop: '4px' }}>Anything that emails new contacts needs to be off first.</p>
                    {(ov.flows.paused || []).length > 0 && <p data-testid="mc-step2-paused" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: T.success }}><IconCheck size={14} />Checked just now: {ov.flows.paused.map((f) => f.name).join(', ')} {ov.flows.paused.length === 1 ? 'is' : 'are'} paused</p>}
                    {(ov.flows.paused || []).length === 0 && <p data-testid="mc-step2-none" style={{ marginTop: '8px', fontSize: '12px', color: T.mutedFg }}>Checked just now: nothing in your Mailchimp emails new contacts.</p>}
                  </div>
                </li>
                <li data-mcc-step>
                  <span style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', borderRadius: R.full, border: `1px solid ${T.border}`, fontSize: '14px', color: T.mutedFg, background: allowed ? 'transparent' : T.muted }}>3</span>
                  <div>
                    <h2 style={{ fontSize: '16px', fontWeight: 700, color: allowed ? T.primary : T.mutedFg }}>Start the first sync</h2>
                    <p style={{ ...muted, marginTop: '4px' }}>Adds the people you chose to your {list} audience.</p>
                    {!ov.reviewed && <p style={{ ...small, marginTop: '8px' }}>Finish your contact review first.</p>}
                    {partial && <p data-testid="mc-partial" style={{ ...small, marginTop: '8px', color: T.warning }}>Stopped partway last time: {people(partial.added)} added, {n(partial.remaining)} still to go. Nobody is added twice.</p>}
                  </div>
                  <Btn variant="primary" data-testid="mc-start" disabled={!allowed || syncing} onClick={() => sync(null)}>{syncing ? 'Checking…' : 'Start the first sync'}</Btn>
                </li>
              </ol>
              <p style={muted}>Only names, email addresses and tags are sent. Your notes, job details and payment information stay in Bee Hub.</p>
            </>
          )}

          {state === 'running' && (
            <>
              <div data-mcc-tiles>
                {[
                  { label: 'People in the audience', value: ov.audience_count == null ? '—' : n(ov.audience_count), Icon: IconUsers },
                  { label: 'Last synced', value: lastSyncedWords(ov.last_run?.at), Icon: IconClock },
                  ...(partial ? [{ label: 'Still to go from the last sync', value: n(partial.remaining), Icon: Refresh }] : []),
                ].map(({ label, value, Icon }, i) => (
                  <div key={label} style={{ borderRadius: R.xl, border: `1px solid ${T.border}`, background: T.card, padding: '16px', ...(i === 2 ? { gridColumn: '1 / -1' } : {}) }}>
                    <span style={{ color: T.mutedFg }}><Icon size={16} /></span>
                    <p style={{ marginTop: '16px', fontSize: '24px', color: T.primary }}>{value}</p>
                    <p style={{ ...small, marginTop: '4px' }}>{label}</p>
                  </div>
                ))}
              </div>
              <div data-mcc-actions>
                <Btn variant="primary" data-testid="mc-sync-now" disabled={!allowed || syncing} onClick={() => sync(null)}><Refresh />{syncing ? 'Syncing…' : 'Sync now'}</Btn>
                <Btn variant="outline" data-testid="mc-open-review" onClick={onReview}>Review who goes to Mailchimp</Btn>
              </div>
            </>
          )}

          {state === 'blocked' && (
            <section data-testid="mc-on-hold" data-reason={flowsUnread ? 'unreadable' : 'flows'} style={{ borderRadius: R.xxl, border: `1px solid ${alpha(T.gold, 0.5)}`, background: alpha(T.warningSoft, 0.4), padding: '20px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ marginTop: '4px', color: T.warning, flexShrink: 0 }}><Lock /></span>
                <div>
                  <h2 style={{ fontSize: '20px', fontWeight: 400, color: T.primary, fontFamily: FONT.body }}>{flowsUnread ? 'We need to check Mailchimp first' : 'Pause these emails before adding people'}</h2>
                  <p style={{ ...muted, marginTop: '8px' }}>{flowsUnread
                    ? 'Bee Hub couldn’t read Mailchimp to check whether new people would receive automatic emails. Nothing will be added until we can check.'
                    : `These automations email people as soon as they join ${list}. Nothing will be added until they are paused.`}</p>
                </div>
              </div>
              {flowsUnread ? (
                <>
                  <p style={{ ...muted, marginTop: '16px' }}>Try checking again in a moment. If it still can’t be checked, open Mailchimp to make sure you can sign in.</p>
                  <div style={{ marginTop: '4px' }}><OpenMailchimp /></div>
                </>
              ) : (
                <>
                  <FlowRows flows={ov.flows.mustPause} testid="mc-live-flows" />
                  <div style={{ marginTop: '16px' }}>
                    <PauseSteps />
                    <p style={{ ...muted, marginTop: '12px' }}>Pause each flow, then come back here. Bee Hub can’t pause them for you.</p>
                    <OpenMailchimp />
                  </div>
                </>
              )}
              <div data-mcc-actions style={{ marginTop: '20px', paddingTop: '20px', borderTop: `1px solid ${alpha(T.gold, 0.3)}` }}>
                <Btn variant="primary" data-testid="mc-sync-now" disabled>Sync now</Btn>
                <Btn variant="outline" data-testid="mc-check-again" disabled={checking} onClick={load}><Refresh />{checking ? 'Checking…' : 'Check again'}</Btn>
              </div>
            </section>
          )}

          {result && <SyncResult result={result} listName={listName} />}
          {err && <p role="alert" style={{ fontSize: '14px', color: T.destructive }}>{err}</p>}

          <footer style={{ borderTop: `1px solid ${T.border}`, paddingTop: '20px' }}>
            {!disconnecting ? (
              <button type="button" data-mcc-quiet onClick={() => setDisconnecting(true)}>Disconnect Mailchimp</button>
            ) : (
              <div data-testid="mc-disconnect" style={{ borderRadius: R.xl, background: T.muted, padding: '16px' }}>
                <p style={{ fontSize: '16px', color: T.primary }}>Disconnect Mailchimp?</p>
                <p style={{ ...muted, marginTop: '4px' }}>This stops Bee Hub adding people. Your Mailchimp audience stays as it is.</p>
                <div data-mcc-actions style={{ marginTop: '12px' }}>
                  <Btn variant="outline" disabled={disconnectBusy} onClick={() => setDisconnecting(false)}>Keep connected</Btn>
                  <Btn variant="outline" disabled={disconnectBusy} onClick={onDisconnect} style={{ color: T.destructive }}>{disconnectBusy ? 'Disconnecting…' : 'Disconnect'}</Btn>
                </div>
              </div>
            )}
          </footer>
        </div>
      )}
    </div>
  )
}
