'use client'
// components/settings/MailchimpConnectionScreen.jsx
//
// MAILCHIMP SLICE 6 (FL-75 / FL-101, 2026-11-25): the Mailchimp screen once an
// account and an audience are chosen, built to Kevin's Lovable design in
// "Bee Organized Control Hive" (src/components/settings/MailchimpConnection.tsx,
// BeforeWeAdd.tsx and MailchimpHold.tsx, as edited 2026-11-25).
//
//   <MailchimpConnectionScreen>  never synced (three steps) / syncing (numbers,
//                                Sync now) / on hold (a live flow, or Mailchimp
//                                couldn't be read — Sync now stays off)
//   <BeforeWeAdd>                the first-sync confirmation: nothing live /
//                                something live / couldn't check
//   <Hold>                       the one amber refusal both of them show
//
// IT DECIDES NOTHING. What it shows comes from GET /api/mailchimp/overview
// (read only) and from what POST /api/mailchimp/sync answered. The switch, the
// flows, who is allowed and the confirmation are all checked again by the
// sending code, on the server, right before it sends.
//
// KEVIN'S RULINGS (2026-11-25), all in the design now: REFUSE, never warn —
// with a live flow, or a Mailchimp that can't be read, "Add them" is off and
// each flow is named with how to pause it. There is no typed-name field and no
// "I understand" tick, and no way round the refusal.
//
// WHERE THIS DIFFERS FROM THE DESIGN, ON PURPOSE:
//   • The design's rows of preview pills ("Never synced · Synced and running ·
//     Blocked", "Nothing live · Something live · Couldn't check") are
//     design-tool controls for flipping between samples. They are not built.
//   • Tags that start a live Mailchimp flow get their own unticked box each —
//     the design has no tags here; the ruling needs a yes per tag.
//   • "They'll get Bee Hub's welcome email." is left out of the confirmation.
//     The first sync adds people who are already in Bee Hub; nothing here
//     sends them a Bee Hub email, so the screen does not promise one.
//   • The third number, "Waiting to be added", is only shown when the last
//     sync stopped partway, as "Still to go from the last sync" — the only
//     count of that kind Bee Hub actually holds.
//   • A Settings page keeps the context a pop-up gets from its frame (Kevin,
//     2026-11-24): the confirmation is a page with a way back, under the
//     design's own title ("Mailchimp · First sync"). The two small pop-ups
//     (how to pause, disconnect) are windows, closed by their own buttons.

import { useCallback, useEffect, useState } from 'react'
import { T, R, FONT, SHADOW, alpha } from '@/components/design/tokens'
import { IconUsers, IconClock, IconExternalLink, IconCheck } from '@/components/ui/icons'
import { SyncResult } from '@/components/settings/MailchimpSyncAnswer'
import MailchimpImportScreen from '@/components/settings/MailchimpImportScreen'
import MailchimpGuidedSetup from '@/components/settings/MailchimpGuidedSetup'

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

// A button that is off LOOKS off (the design's OFF): flat grey, no fade.
const CSS = `
[data-mcc] *,[data-mcc-window] *{box-sizing:border-box}
[data-mcc] p,[data-mcc] h2,[data-mcc] h3,[data-mcc] ol,[data-mcc] ul,[data-mcc-window] p,[data-mcc-window] h2,[data-mcc-window] ol{margin:0;padding:0}
[data-mcc] ol,[data-mcc] ul,[data-mcc-window] ol{list-style:none}
[data-mcc-btn]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;width:100%;border-radius:${R.lg};padding:10px 16px;font-family:${FONT.ui};cursor:pointer;transition:background-color .15s;white-space:normal;text-align:center}
[data-mcc-btn]>span{font-size:14px;line-height:20px;font-weight:700}
[data-mcc-btn="primary"]{background:${T.primary};color:${T.primaryFg};border:1px solid transparent}
[data-mcc-btn="primary"]:not(:disabled):hover{background:${alpha(T.primary, 0.9)}}
[data-mcc-btn="outline"]{background:${T.card};color:${T.foreground};border:1px solid ${T.border}}
[data-mcc-btn="outline"]:not(:disabled):hover{background:${T.muted}}
[data-mcc-btn="ghost"]{background:transparent;color:${T.foreground};border:1px solid transparent}
[data-mcc-btn="ghost"]:not(:disabled):hover{background:${T.muted}}
[data-mcc-btn="warn"]{background:transparent;color:${T.warning};border:1px solid transparent}
[data-mcc-btn="warn"]:not(:disabled):hover{background:${T.warningSoft}}
[data-mcc-btn]:disabled{cursor:not-allowed}
[data-mcc-btn="primary"]:disabled{background:${T.muted};color:${T.mutedFg};border:1px solid ${T.border}}
[data-mcc-btn="outline"]:disabled,[data-mcc-btn="ghost"]:disabled,[data-mcc-btn="warn"]:disabled{opacity:.6}
[data-mcc-link]{display:inline-flex;align-items:center;gap:4px;min-height:44px;background:none;border:0;padding:0;cursor:pointer;font-family:${FONT.ui};color:${T.primary};text-decoration:underline;text-underline-offset:4px}
[data-mcc-link]>span{font-size:14px;line-height:20px;font-weight:700}
[data-mcc-quiet]{display:inline-flex;align-items:center;background:none;border:0;padding:0;min-height:44px;cursor:pointer;font-family:${FONT.ui};color:${T.mutedFg}}
[data-mcc-quiet]>span{font-size:14px;line-height:20px;font-weight:400}
[data-mcc-quiet]:hover{color:${T.primary}}
[data-mcc-back]{background:none;border:0;padding:0;cursor:pointer;color:${T.mutedFg};font-family:${FONT.ui};display:inline-flex;align-items:center;gap:6px;min-height:44px}
[data-mcc-back]>span{font-size:14px;line-height:20px}
[data-mcc-back]:hover{color:${T.foreground}}
[data-mcc] input[type=checkbox]{width:18px;height:18px;margin:1px 0 0;accent-color:${T.primary};flex-shrink:0}
[data-mcc-account]{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;column-gap:12px;row-gap:8px}
[data-mcc-account] [data-mcc-pill]{grid-column-start:2}
[data-mcc-step]{display:grid;grid-template-columns:2rem minmax(0,1fr);gap:12px;padding:24px 0}
[data-mcc-step] > [data-mcc-btn],[data-mcc-step] > [data-mcc-link]{grid-column-start:2;justify-self:start;width:auto}
[data-mcc-tiles]{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
[data-mcc-actions]{display:flex;flex-direction:column;gap:12px}
[data-mcc-hold]{padding:20px}
[data-mcc-big]{font-size:24px;line-height:1.375}
@media (min-width:640px){
[data-mcc-btn]{width:auto}
[data-mcc-account]{grid-template-columns:auto minmax(0,1fr) auto;column-gap:16px}
[data-mcc-account] [data-mcc-pill]{grid-column-start:3}
[data-mcc-step]{grid-template-columns:2rem minmax(0,1fr) auto;gap:16px}
[data-mcc-step] > [data-mcc-btn],[data-mcc-step] > [data-mcc-link]{grid-column-start:auto;align-self:center}
[data-mcc-tiles]{grid-template-columns:repeat(3,minmax(0,1fr))}
[data-mcc-actions]{flex-direction:row}
[data-mcc-hold]{padding:24px}
[data-mcc-big]{font-size:30px}
}
`

const muted = { fontSize: '14px', lineHeight: 1.625, color: T.mutedFg }
const small = { fontSize: '12px', lineHeight: 1.625, color: T.mutedFg }
const Lock = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /><circle cx="12" cy="16" r="1" /></svg>
)
const Refresh = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
)
const ArrowLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
)

// The words sit in a <span> with their own size: app/globals.css forces 16px
// onto every <button> itself.
// ── The people Mailchimp refused (2026-11-26) ────────────────────────────
// "N people couldn't be added", and who, opened in place. Each shows what
// Mailchimp said — labelled as Mailchimp's words — and whether Bee Hub will
// send them again. Edit address saves through the client record's own route;
// Try again sends a held address once more on the next sync; Leave out unticks
// them for Mailchimp (undone on "Who goes to Mailchimp"). A person who said no
// in Mailchimp is never here: they are on the no-marketing list. A bounce is
// here (not a no), with what kind of bounce Mailchimp said it was, if it did.
// What a bounce means, in plain words. Mailchimp's own message is shown
// above it; this only says whether it told us the bounce was for good.
export function bounceWords(p) {
  if (p.bounce === 'hard') return 'Mailchimp says this mailbox doesn’t exist (a hard bounce).'
  if (p.bounce === 'soft') return 'Mailchimp says this mailbox didn’t take mail for now, like a full inbox (a soft bounce).'
  if (p.bounce === 'unknown') return 'Mailchimp didn’t say whether this bounce is for good, so Bee Hub tries again and stops after 3 tries.'
  return null
}
export function refusedStatus(p) {
  if (p.retry_requested) return 'Will be tried once more on the next sync.'
  if (p.held && p.kind === 'invalid') return 'Not sent again until the address is changed.'
  if (p.held) return `Not sent again: Mailchimp refused them ${n(p.refused_count)} times.`
  return 'Will be tried again on the next sync.'
}
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function RefusedPeople({ locationId, count, doFetch, onChanged }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)        // email_key being saved
  const [editing, setEditing] = useState(null)  // email_key with the address field open
  const [draft, setDraft] = useState('')

  const read = useCallback(async () => {
    setErr(null)
    try {
      const r = await doFetch('/api/mailchimp/refused?location_id=' + encodeURIComponent(locationId || ''), { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(j.words || 'Who Mailchimp refused couldn’t be read. Please try again.'); return }
      setList(Array.isArray(j.people) ? j.people : [])
    } catch { setErr('Who Mailchimp refused couldn’t be read. Please try again.') }
  }, [doFetch, locationId])

  async function toggle() {
    if (open) { setOpen(false); return }
    setOpen(true)
    await read()
  }
  async function act(p, action) {
    setBusy(p.email_key); setErr(null)
    try {
      const r = await doFetch('/api/mailchimp/refused', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location_id: locationId, email_key: p.email_key, action }) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) setErr(j.words || 'That couldn’t be saved. Please try again.')
    } catch { setErr('That couldn’t be saved. Please try again.') }
    setBusy(null)
    await read(); onChanged && onChanged()
  }
  async function saveAddress(p) {
    const email = draft.trim()
    if (!EMAIL_OK.test(email)) { setErr('That doesn’t look like an email address.'); return }
    setBusy(p.email_key); setErr(null)
    try {
      for (const rec of p.records) {
        const r = await doFetch('/api/leads/' + encodeURIComponent(rec.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
        if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.detail || j.error || 'The new address couldn’t be saved.'); setBusy(null); return }
      }
    } catch { setErr('The new address couldn’t be saved.'); setBusy(null); return }
    setBusy(null); setEditing(null); setDraft('')
    await read(); onChanged && onChanged()
  }

  return (
    <section aria-label="People Mailchimp refused" data-testid="mc-refused" style={{ borderRadius: R.xl, border: `1px solid ${T.border}`, background: T.card, padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <p data-testid="mc-refused-line" style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>{people(count)} couldn’t be added to Mailchimp</p>
        <button type="button" data-mcc-link data-testid="mc-refused-toggle" aria-expanded={open} onClick={toggle}><span>{open ? 'Hide' : 'See who'}</span></button>
      </div>
      <p style={{ ...small, marginTop: '4px' }}>Mailchimp turned these addresses down, so Bee Hub doesn’t keep sending them.</p>
      {err && <p role="alert" style={{ marginTop: '8px', fontSize: '13px', color: T.destructive }}>{err}</p>}
      {open && list && (
        <ul data-testid="mc-refused-list" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: '8px' }}>
          {list.length === 0 && <li style={small}>Nobody now. Everyone Mailchimp refused has been changed or left out.</li>}
          {list.map((p) => (
            <li key={p.email_key} data-testid="mc-refused-person" style={{ borderTop: `1px solid ${T.border}`, paddingTop: '10px' }}>
              <p style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>{p.records.map((r) => r.name).filter(Boolean).join(' · ') || p.email}</p>
              <p style={{ ...small, wordBreak: 'break-all' }}>{p.email}{p.records.length > 1 ? ` · on ${p.records.length} Bee Hub records` : ''}</p>
              <p data-testid="mc-refused-said" style={{ marginTop: '6px', fontSize: '13px', lineHeight: '18px', color: T.foreground }}>
                <span style={{ fontWeight: 700 }}>Mailchimp said:</span> <span style={{ fontStyle: 'italic' }}>“{p.mailchimp_said}”</span>
              </p>
              {bounceWords(p) && <p data-testid="mc-refused-bounce" style={{ ...small, marginTop: '4px' }}>{bounceWords(p)}</p>}
              <p data-testid="mc-refused-status" style={{ ...small, marginTop: '4px', color: p.held && !p.retry_requested ? T.warning : T.mutedFg }}>{refusedStatus(p)}</p>
              {editing === p.email_key ? (
                <div style={{ marginTop: '8px', display: 'grid', gap: '8px' }}>
                  <input data-testid="mc-refused-email" type="email" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`New email address for ${p.email}`}
                    style={{ minHeight: '44px', borderRadius: R.lg, border: `1px solid ${T.border}`, padding: '0 12px', fontSize: '16px', fontFamily: FONT.ui, background: T.background, color: T.foreground }} />
                  {p.records.length > 1 && <p style={small}>This changes the address on all {p.records.length} Bee Hub records.</p>}
                  <div data-mcc-actions>
                    <Btn variant="primary" data-testid="mc-refused-save" disabled={busy === p.email_key} onClick={() => saveAddress(p)}>{busy === p.email_key ? 'Saving…' : 'Save address'}</Btn>
                    <Btn variant="outline" onClick={() => { setEditing(null); setDraft('') }}>Cancel</Btn>
                  </div>
                </div>
              ) : (
                <div data-mcc-actions style={{ marginTop: '8px' }}>
                  <Btn variant="outline" data-testid="mc-refused-edit" disabled={!!busy} onClick={() => { setEditing(p.email_key); setDraft(p.email) }}>Edit address</Btn>
                  {p.held && !p.retry_requested && <Btn variant="outline" data-testid="mc-refused-retry" disabled={!!busy} onClick={() => act(p, 'retry')}>Try again</Btn>}
                  <Btn variant="outline" data-testid="mc-refused-leave" disabled={!!busy} onClick={() => act(p, 'leave_out')}>Leave out</Btn>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Btn({ variant = 'outline', icon, children, ...rest }) {
  return <button type="button" data-mcc-btn={variant} {...rest}>{icon}<span>{children}</span></button>
}
function OpenMailchimp() {
  return <a data-mcc-link href={MAILCHIMP_URL} target="_blank" rel="noreferrer"><span>Open Mailchimp</span><IconExternalLink size={16} /></a>
}

// A small window over the page. Closed by its own controls only (the cross,
// like the design's, or a button inside), never by a click outside it.
function Window({ title, sub, onClose, closeDisabled, children, ...rest }) {
  return (
    <div data-settings-ui data-mcc-window style={{ position: 'fixed', inset: 0, zIndex: 10100, background: alpha(T.foreground, 0.45), display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', fontFamily: FONT.ui }}>
      <style>{CSS}</style>
      <div role="dialog" aria-modal="true" aria-label={title} {...rest}
        style={{ position: 'relative', background: T.background, borderRadius: R.lg, padding: '20px', maxWidth: '672px', width: '100%', maxHeight: '92dvh', overflowY: 'auto', boxShadow: SHADOW.dialog, color: T.foreground }}>
        <button type="button" aria-label="Close" data-mcc-x disabled={closeDisabled} onClick={onClose}
          style={{ position: 'absolute', top: '6px', right: '6px', width: '44px', height: '44px', display: 'grid', placeItems: 'center', background: 'none', border: 0, padding: 0, cursor: 'pointer', color: T.mutedFg }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
        <h2 style={{ paddingRight: '36px', fontSize: '20px', lineHeight: '28px', fontWeight: 400, color: T.primary }}>{title}</h2>
        {sub && <p style={{ ...muted, marginTop: '6px' }}>{sub}</p>}
        <div style={{ marginTop: '16px' }}>{children}</div>
      </div>
    </div>
  )
}

// How to pause one flow, the design's one line (its steps were checked in
// Mailchimp by Kevin). Shown under every flow that must be paused.
export const PAUSE_LINE = 'Pause it in Mailchimp: Automations, find the flow, then the arrow on the right of its row, then Pause.'
// The same, as four steps, for the "How to pause them" window.
export const PAUSE_STEPS = [
  <>In Mailchimp, go to <strong style={{ color: T.foreground }}>Automations</strong>.</>,
  <>Find the flow in the list.</>,
  <>Click the arrow on the right of its row.</>,
  <>Choose <strong style={{ color: T.foreground }}>Pause</strong>.</>,
]

// ─── The refusal ───────────────────────────────────────────────────────────
// The design's MailchimpHold: one amber box, used by the on-hold screen and by
// the first-sync confirmation. reason 'flows' names each flow and how to pause
// it; 'unreadable' says Mailchimp couldn't be checked. `actions` never holds a
// button that can add anyone.
export function Hold({ reason, flows = [], status, actions, ...rest }) {
  const line = `1px solid ${alpha(T.gold, 0.3)}`
  return (
    <section data-mcc-hold data-reason={reason} {...rest} style={{ borderRadius: R.lg, border: `1px solid ${alpha(T.gold, 0.5)}`, background: alpha(T.warningSoft, 0.4) }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span style={{ marginTop: '4px', color: T.warning, flexShrink: 0 }}><Lock /></span>
        <div style={{ minWidth: 0 }}>
          <h2 data-testid="mc-hold-title" style={{ fontSize: '20px', lineHeight: '28px', fontWeight: 400, color: T.primary, fontFamily: FONT.body }}>
            {reason === 'flows' ? 'Can’t add people yet' : 'Can’t add people yet: we couldn’t check Mailchimp'}
          </h2>
          <p style={{ ...muted, marginTop: '8px' }}>
            {reason === 'flows'
              ? 'These would send a second welcome email on top of Bee Hub’s.'
              : 'Bee Hub couldn’t read your Mailchimp, so we can’t tell whether it would email these people. Until we can check, nobody will be added.'}
          </p>
        </div>
      </div>
      {reason === 'flows' && (
        <ul data-testid="mc-live-flows" style={{ marginTop: '20px', borderTop: line }}>
          {flows.map((f, i) => (
            <li key={i} style={{ padding: '12px 0', borderTop: i ? line : 'none' }}>
              <p data-flow-name style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.primary, overflowWrap: 'anywhere' }}>{f.name}</p>
              <p data-flow-pause style={{ ...small, marginTop: '4px' }}>{PAUSE_LINE}</p>
            </li>
          ))}
        </ul>
      )}
      <div data-mcc-actions style={{ marginTop: '20px', paddingTop: '20px', borderTop: line }}>{actions}</div>
      {status && <p role="status" data-testid="mc-hold-status" style={{ marginTop: '12px', fontSize: '14px', lineHeight: '20px', color: T.warning }}>{status}</p>}
    </section>
  )
}
const STILL = { flows: 'Checked again. These are still on.', unreadable: 'Checked again. Mailchimp still couldn’t be read.' }

// ─── The confirmation ──────────────────────────────────────────────────────
//
// kind: 'ask'        nothing live — confirm = the server's needs_confirmation answer
//       'live'       something live — flows = the server's must_pause list
//       'unreadable' couldn't check
// Only 'ask' has a button that can add anyone.
// The one quiet line under the count: who is NOT being added, only when
// someone is (archived people left unticked; people held on the refused list).
export function leftOutWords(lo) {
  const a = Number(lo?.archived || 0), r = Number(lo?.refused || 0)
  if (!a && !r) return null
  const arch = a ? `${n(a)} archived ${a === 1 ? 'person' : 'people'}` : ''
  const ref = r ? `${n(r)} ${r === 1 ? 'person' : 'people'} Mailchimp refused` : ''
  if (a && r) return `${arch} and ${ref} aren’t included.`
  return `${arch || ref} ${(a || r) === 1 ? 'isn’t' : 'aren’t'} included.`
}

export function BeforeWeAdd({ kind, confirm, flows, listName, accountName, changed, again, busy, onYes, onCheckAgain, onCancel }) {
  const [tagsOk, setTagsOk] = useState([])
  const list = (confirm?.list_name || listName || '').trim() || 'your Mailchimp audience'
  const count = kind === 'ask' ? Number(confirm?.count || 0) : null
  const held = kind === 'ask' ? (confirm?.held_tags || []) : []
  const reason = kind === 'live' ? 'flows' : 'unreadable'
  return (
    <div data-testid="mc-before-we-add" data-kind={kind}>
      <button type="button" data-mcc-back onClick={onCancel} disabled={busy}><ArrowLeft /><span>Back to Mailchimp</span></button>
      {changed && <p role="status" style={{ marginTop: '12px', fontSize: '14px', lineHeight: '20px', color: T.warning }}>Something changed in Mailchimp since you looked, so nothing was added. Here it is again.</p>}

      {kind === 'ask' ? (
        <div style={{ marginTop: '20px' }}>
          {/* Kevin's approved design (Bee Organized Control Hive, BeforeWeAdd):
              the count and the audience once, in the heading; one line on what
              happens; one quiet line only if someone is left out; Add them,
              Cancel. The count is the people who will actually be sent. */}
          <h2 data-testid="mc-confirm-count" data-mcc-big style={{ fontFamily: FONT.body, color: T.primary, fontWeight: 400 }}>
            Add <strong>{people(count)}</strong> to <strong>{list}?</strong>
          </h2>
          <p data-testid="mc-confirm-what" style={{ ...muted, marginTop: '12px' }}>They’re added to your Mailchimp audience. Nothing else is sent from Bee Hub.</p>
          {leftOutWords(confirm?.left_out) && <p data-testid="mc-confirm-left-out" style={{ ...small, marginTop: '4px' }}>{leftOutWords(confirm?.left_out)}</p>}
          {held.length > 0 && (
            <div data-testid="mc-held-tags" style={{ marginTop: '20px' }}>
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
          <div data-mcc-actions style={{ marginTop: '24px' }}>
            <Btn variant="primary" data-testid="mc-add" disabled={busy} onClick={() => onYes(tagsOk)}>{busy ? 'Adding…' : 'Add them'}</Btn>
            <Btn variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: '20px' }}>
          <Hold reason={reason} flows={flows || []} status={again && !busy ? STILL[reason] : null}
            actions={<>
              <Btn variant="primary" data-testid="mc-add" disabled>Add them</Btn>
              <Btn variant="outline" data-testid="mc-check-again" disabled={busy} onClick={onCheckAgain} icon={<Refresh />}>{busy ? 'Checking…' : 'Check again'}</Btn>
              <Btn variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Btn>
            </>} />
        </div>
      )}
    </div>
  )
}

// ─── The connection screen ─────────────────────────────────────────────────
export default function MailchimpConnectionScreen({ locationId, accountName, listName, onReview, onDisconnect, disconnectBusy, fetchImpl, notice = null, onListChanged = null, storage }) {
  const doFetch = fetchImpl || ((u, i) => fetch(u, i))
  const [ov, setOv] = useState(undefined)        // undefined = loading, null = couldn't load
  const [checking, setChecking] = useState(false)
  const [checkedAgain, setCheckedAgain] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [ask, setAsk] = useState(null)           // { kind, confirm?, flows?, changed?, again? } — the confirmation page
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  const [win, setWin] = useState(null)           // 'pause' | 'disconnect' | null
  // FL-75 slice 7: "Bring people in from Mailchimp" — the server says whether
  // it is switched on here (pilot locations only); its review opens in place.
  const [canImport, setCanImport] = useState(false)
  const [importing, setImporting] = useState(false)
  useEffect(() => {
    let off = false
    doFetch('/api/mailchimp/import?available=1&location_id=' + encodeURIComponent(locationId || ''), { cache: 'no-store' })
      .then((r) => (r && r.ok ? r.json() : null)).then((j) => { if (!off) setCanImport(!!(j && j.available === true)) })
      .catch(() => { if (!off) setCanImport(false) })
    return () => { off = true }
  }, [locationId])

  const load = useCallback(async () => {
    setChecking(true)
    try {
      const r = await doFetch('/api/mailchimp/overview?location_id=' + encodeURIComponent(locationId || ''), { cache: 'no-store' })
      setOv(r.ok ? await r.json() : null)
    } catch { setOv(null) } finally { setChecking(false) }
  }, [locationId])
  useEffect(() => { load() }, [load])
  // The guided set-up (2026-11-26) is the never-sent-yet page: decided once,
  // when the first answer arrives, so finishing it (which records the first
  // send) shows its own finish page before this screen moves on.
  const [guided, setGuided] = useState(null)
  useEffect(() => { if (guided === null && ov !== undefined) setGuided(!!ov && !ov.synced) }, [ov, guided])

  async function sync(confirm, again = false) {
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
        if (ask || (ov && !ov.synced)) setAsk({ kind: 'live', flows: j.must_pause || [], again })
        else setAsk(null)
        await load(); return
      }
      if (j.reason === 'mailchimp_unreadable') {
        if (ask || (ov && !ov.synced)) setAsk({ kind: 'unreadable', again })
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
  // No "stopped partway last time" line after a reload (2026-11-26): the only
  // trace a partial first sync leaves is people stamped as synced, and an older
  // sync left the same stamps (Test Location has one from August), so the
  // screen cannot tell the two apart. A run that stops partway says so, with
  // its numbers, in its own answer (SyncResult); the next press asks again
  // for the people still to go.
  const notLive = ov && ov.live !== true
  const frame = [list, (accountName || '').trim()].filter(Boolean).join(' · ')

  if (importing) return <MailchimpImportScreen locationId={locationId} fetchImpl={fetchImpl} onClose={() => setImporting(false)} />
  if (ov === undefined) return <div data-settings-ui data-mcc data-testid="mc-connection" data-state="loading" style={{ margin: '0 auto', padding: '16px', maxWidth: '672px', fontFamily: FONT.ui, color: T.mutedFg, fontSize: '14px' }}>Opening Mailchimp…</div>
  if (guided) return (
    <>
      <MailchimpGuidedSetup locationId={locationId} accountName={accountName} listName={listName} ov={ov} checking={checking}
        onCheckAgain={load} fetchImpl={fetchImpl} storage={storage} notice={notice} onListChanged={onListChanged}
        onDisconnectAsk={() => setWin('disconnect')}
        onFinished={async () => { await load(); setGuided(null) }} />
      {win === 'disconnect' && (
        <div data-mcc>
          <Window title="Disconnect Mailchimp?" sub="This stops Bee Hub adding people. Your Mailchimp list stays as it is." onClose={() => setWin(null)} closeDisabled={disconnectBusy} data-testid="mc-disconnect">
            <div data-mcc-actions>
              <Btn variant="outline" disabled={disconnectBusy} onClick={() => setWin(null)}>Keep connected</Btn>
              <Btn variant="warn" data-testid="mc-disconnect-yes" disabled={disconnectBusy} onClick={onDisconnect}>{disconnectBusy ? 'Disconnecting…' : 'Disconnect'}</Btn>
            </div>
          </Window>
        </div>
      )}
    </>
  )

  return (
    <div data-settings-ui data-mcc data-testid="mc-connection" data-state={state} style={{ margin: '0 auto', padding: '16px', maxWidth: '672px', fontFamily: FONT.ui, color: T.foreground }}>
      <style>{CSS}</style>

      {ask ? (
        <BeforeWeAdd kind={ask.kind} confirm={ask.confirm} flows={ask.flows} listName={listName} accountName={accountName} changed={ask.changed} again={ask.again} busy={syncing}
          onYes={(tagsOk) => sync({ count: ask.confirm.count, list_id: ask.confirm.list_id, flows: ask.confirm.flows, tags_ok: tagsOk })}
          onCheckAgain={() => sync(null, true)}
          onCancel={() => setAsk(null)} />
      ) : (
        <div style={{ display: 'grid', gap: '24px' }}>
          <div data-mcc-account style={{ borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: '20px 0' }}>
            <span style={{ width: '48px', height: '48px', display: 'grid', placeItems: 'center', borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card, padding: '8px' }}>
              <img src={MC_LOGO} alt="Mailchimp" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.primary, overflowWrap: 'anywhere' }}>{accountName || 'Mailchimp'}</p>
              <p style={{ marginTop: '4px', fontSize: '14px', lineHeight: '20px', color: T.mutedFg, overflowWrap: 'anywhere' }}>Audience · {list}</p>
            </div>
            <span data-mcc-pill data-testid="mc-pill" style={{ display: 'inline-flex', width: 'fit-content', alignItems: 'center', gap: '6px', borderRadius: R.full, padding: '4px 12px', fontSize: '12px', lineHeight: '16px', fontWeight: 700, color: pill.fg, background: pill.bg }}>
              <span style={{ width: '6px', height: '6px', borderRadius: R.full, background: 'currentColor' }} />{pill.t}
            </span>
          </div>

          {/* Why the set-up started again, when the audience or the connection
              changed and the review and first sync were cleared (2026-11-26). */}
          {notice && (
            <p role="status" data-testid="mc-reset-notice" style={{ fontSize: '14px', lineHeight: '20px', color: T.foreground, background: T.sageSoft, borderRadius: R.lg, padding: '12px 16px' }}>{notice}</p>
          )}

          {notLive && (
            <p data-testid="mc-not-live" style={{ ...muted }}>Sending to Mailchimp isn’t switched on for your location yet. We’ll let you know when it is.</p>
          )}

          {state === 'setup' && (
            <>
              <ol style={{ borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card, padding: '0 20px', overflow: 'hidden' }}>
                <li data-mcc-step style={{ borderBottom: `1px solid ${T.border}` }}>
                  <span aria-label={ov.reviewed ? 'Review completed' : undefined} style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', borderRadius: R.full, fontSize: '14px', fontWeight: 700, background: ov.reviewed ? T.successSoft : T.sageSoft, color: ov.reviewed ? T.success : T.primary }}>{ov.reviewed ? <IconCheck size={16} /> : '1'}</span>
                  <div>
                    <h2 style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.primary }}>Review who goes to Mailchimp</h2>
                    <p style={{ ...muted, marginTop: '4px' }}>Choose which of your contacts get added.</p>
                    {ov.reviewed && <p data-testid="mc-reviewed" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: T.success }}><IconCheck size={14} />Review complete</p>}
                  </div>
                  <Btn variant="outline" data-testid="mc-open-review" onClick={onReview}>{ov.reviewed ? 'Review again' : 'Review who goes to Mailchimp'}</Btn>
                </li>
                <li data-mcc-step style={{ borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', borderRadius: R.full, border: `1px solid ${T.border}`, fontSize: '14px', color: T.mutedFg }}>2</span>
                  <div>
                    <h2 style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.primary }}>Pause your Mailchimp automations</h2>
                    <p style={{ ...muted, marginTop: '4px' }}>Anything that emails new contacts needs to be off first.</p>
                    {(ov.flows.paused || []).length > 0 && <p data-testid="mc-step2-paused" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700, color: T.success }}><IconCheck size={14} />Checked just now: {ov.flows.paused.map((f) => f.name).join(', ')} {ov.flows.paused.length === 1 ? 'is' : 'are'} paused</p>}
                    {(ov.flows.conditional || []).map((c) => (
                      <p key={c.name} data-testid="mc-step2-conditional" style={{ marginTop: '8px', fontSize: '12px', lineHeight: 1.5, color: T.mutedFg }}>
                        {c.name} is on, but it only emails people tagged “{c.tag}” (Bee Organized checked this in Mailchimp by hand; Mailchimp doesn’t report it). Bee Hub won’t sync if it would send that tag.
                      </p>
                    ))}
                    {(ov.flows.paused || []).length === 0 && (ov.flows.conditional || []).length === 0 && <p data-testid="mc-step2-none" style={{ marginTop: '8px', fontSize: '12px', color: T.mutedFg }}>Checked just now: nothing in your Mailchimp emails new contacts.</p>}
                  </div>
                  <button type="button" data-mcc-link data-testid="mc-how-to-pause" onClick={() => setWin('pause')}><span>How to pause them</span><IconExternalLink size={16} /></button>
                </li>
                <li data-mcc-step>
                  <span style={{ width: '32px', height: '32px', display: 'grid', placeItems: 'center', borderRadius: R.full, border: `1px solid ${T.border}`, fontSize: '14px', color: allowed ? T.foreground : T.mutedFg, background: allowed ? 'transparent' : T.muted }}>3</span>
                  <div>
                    <h2 style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: allowed ? T.primary : T.mutedFg }}>Start the first sync</h2>
                    <p style={{ ...muted, marginTop: '4px' }}>Adds the people you chose to your {list} audience.</p>
                    {!ov.reviewed && <p style={{ ...small, marginTop: '8px' }}>Finish your contact review first.</p>}
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
                  { label: 'Last synced', value: lastSyncedWords(ov.last_synced_at), Icon: IconClock },
                ].map(({ label, value, Icon }, i) => (
                  <div key={label} style={{ borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card, padding: '16px', ...(i === 2 ? { gridColumn: '1 / -1' } : {}) }}>
                    <span style={{ color: T.mutedFg }}><Icon size={16} /></span>
                    <p style={{ marginTop: '16px', fontSize: '24px', lineHeight: '32px', color: T.primary }}>{value}</p>
                    <p style={{ ...small, marginTop: '4px' }}>{label}</p>
                  </div>
                ))}
              </div>
              <div data-mcc-actions>
                <Btn variant="primary" data-testid="mc-sync-now" disabled={!allowed || syncing} onClick={() => sync(null)} icon={<Refresh />}>{syncing ? 'Syncing…' : 'Sync now'}</Btn>
                <Btn variant="outline" data-testid="mc-open-review" onClick={onReview}>Review who goes to Mailchimp</Btn>
              </div>
            </>
          )}

          {state === 'blocked' && (
            <Hold data-testid="mc-on-hold" reason={flowsUnread ? 'unreadable' : 'flows'} flows={flowsUnread ? [] : ov.flows.mustPause}
              status={checkedAgain && !checking ? STILL[flowsUnread ? 'unreadable' : 'flows'] : null}
              actions={<>
                <Btn variant="primary" data-testid="mc-sync-now" disabled>Sync now</Btn>
                <Btn variant="outline" data-testid="mc-check-again" disabled={checking} onClick={async () => { await load(); setCheckedAgain(true) }} icon={<Refresh />}>{checking ? 'Checking…' : 'Check again'}</Btn>
              </>} />
          )}

          {canImport && (
            <section data-testid="mc-import-card" style={{ borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card, padding: '20px', display: 'grid', gap: '12px' }}>
              <div>
                <h2 style={{ fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.primary }}>Bring people in from Mailchimp</h2>
                <p style={{ ...muted, marginTop: '4px' }}>People in your Mailchimp who aren’t in Bee Hub yet. You choose who comes in; no one is emailed.</p>
              </div>
              <div data-mcc-actions><Btn variant="outline" data-testid="mc-open-import" onClick={() => setImporting(true)}>Review who comes in</Btn></div>
            </section>
          )}

          {result && <SyncResult result={result} listName={listName} />}
          {err && <p role="alert" style={{ fontSize: '14px', color: T.destructive }}>{err}</p>}

          {ov && Number(ov.refused_count) > 0 && (
            <RefusedPeople locationId={locationId} count={Number(ov.refused_count)} doFetch={doFetch} onChanged={load} />
          )}

          <footer style={{ borderTop: `1px solid ${T.border}`, paddingTop: '12px' }}>
            <button type="button" data-mcc-quiet data-testid="mc-disconnect-link" onClick={() => setWin('disconnect')}><span>Disconnect Mailchimp</span></button>
          </footer>
        </div>
      )}

      {win === 'pause' && (
        <Window title="How to pause your automations" sub={frame} onClose={() => setWin(null)} data-testid="mc-pause-window">
          <ol data-testid="mc-pause-steps" style={{ display: 'grid', gap: '8px' }}>
            {PAUSE_STEPS.map((s, i) => (
              <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', ...muted }}>
                <span style={{ flexShrink: 0, minWidth: '16px' }}>{i + 1}.</span><span>{s}</span>
              </li>
            ))}
          </ol>
          <p style={{ ...muted, marginTop: '12px' }}>Pause each flow, then come back here. Bee Hub can’t pause them for you.</p>
          <OpenMailchimp />
        </Window>
      )}
      {win === 'disconnect' && (
        <Window title="Disconnect Mailchimp?" sub="This stops Bee Hub adding people. Your Mailchimp audience stays as it is." onClose={() => setWin(null)} closeDisabled={disconnectBusy} data-testid="mc-disconnect">
          <div data-mcc-actions>
            <Btn variant="outline" disabled={disconnectBusy} onClick={() => setWin(null)}>Keep connected</Btn>
            <Btn variant="warn" data-testid="mc-disconnect-yes" disabled={disconnectBusy} onClick={onDisconnect}>{disconnectBusy ? 'Disconnecting…' : 'Disconnect'}</Btn>
          </div>
        </Window>
      )}
    </div>
  )
}
