'use client'
// components/settings/MailchimpImportScreen.jsx
//
// MAILCHIMP SLICE 7 (FL-75, 2026-11-26): "Who comes in from Mailchimp" — the
// owner's review before anyone in Mailchimp is brought into Bee Hub.
//
// Kevin's ruling: no import without an owner review, built like slice 6's
// outgoing review (components/settings/MailchimpReviewScreen.jsx): the same
// frame, heading + reassurance line, big number with parts that add up,
// labelled sections, groups with "See these people", and a confirmation page
// in the first-sync confirmation's words (BeforeWeAdd).
//   • Will be created — ticked by default (slice 5's "everyone ticked"); the
//     owner unticks anyone they don't want. A person's tick overrides the group.
//   • Same person? — a phone or name match. Shown beside the record it
//     matches. Never tickable: Bee Hub never makes a second record for them.
//   • Not coming in — counts only: skipped (with why) and already in Bee Hub.
//   • Nothing is brought in until the owner confirms. Each tick is saved as it
//     is made, as slice 6's are (POST /api/mailchimp/import/choice), only where
//     it differs from "ticked", so leaving and coming back keeps them. If a
//     save fails the tick goes back and the owner is told. Until
//     migrations/mailchimp_import_choices.sql is run, ticks can't be changed.
//
// NOTHING IS SENT from this screen: no email, drip, alert, Jobber or Mailchimp.

import { useEffect, useMemo, useState } from 'react'
import { T, R, FONT, alpha } from '@/components/design/tokens'

export const PAGE_SIZE = 50
const n = (x) => Number(x || 0).toLocaleString('en-US')
const people = (c) => `${n(c)} ${c === 1 ? 'person' : 'people'}`

export function joinedWords(iso) {
  const d = new Date(iso || '')
  if (Number.isNaN(d.getTime())) return null
  return 'Joined Mailchimp ' + d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

export const SKIP_WORDS = {
  cleaned: 'Bounced in Mailchimp',
  staff: 'Bee Organized team address',
  recycle_bin_only: 'Only in your Recycle Bin',
  other_status: 'Never confirmed in Mailchimp',
  no_email: 'No email address',
  no_join_date: 'No join date in Mailchimp',
}
export const HELD_WORDS = {
  phone_match: 'Same phone number as someone in Bee Hub',
  name_match: 'Same name as someone in Bee Hub, different email',
  other_location: 'Already in Bee Hub at another location',
  duplicate_in_mailchimp: 'Shares a phone or name with someone else in your Mailchimp',
}

// The parts of the big number, adding up to everyone Mailchimp holds.
export function importTally(model, ticked) {
  const bringing = model.create.filter((p) => ticked.has(p.k)).length
  return { bringing, unticked: model.create.length - bringing, held: model.held.length, skipped: model.skipped.total, already: model.already, total: model.read }
}

const CSS = `
[data-mci] *{box-sizing:border-box}
[data-mci] p,[data-mci] h2,[data-mci] h4,[data-mci] ul{margin:0;padding:0}
[data-mci] ul{list-style:none}
[data-mci] input[type=checkbox]{appearance:none;-webkit-appearance:none;margin:0;width:16px;height:16px;flex-shrink:0;border:1px solid ${T.primary};border-radius:6px;background:${T.card};box-shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1);display:grid;place-items:center;cursor:pointer}
[data-mci] input[type=checkbox]:checked{background:${T.primary} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FAF8F5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/16px no-repeat}
[data-mci] input[type=checkbox]:disabled{opacity:.5;cursor:not-allowed}
[data-mci] input[type=checkbox]:focus-visible{outline:none;box-shadow:0 0 0 2px ${T.gold}}
[data-mci] [data-mci-btn]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;width:100%;border-radius:${R.lg};padding:10px 20px;font-family:${FONT.ui};cursor:pointer;transition:background-color .15s}
[data-mci] [data-mci-btn] span{font-size:14px;line-height:20px;font-weight:700}
[data-mci] [data-mci-btn="primary"]{background:${T.primary};color:${T.primaryFg};border:1px solid transparent}
[data-mci] [data-mci-btn="primary"]:not(:disabled):hover{background:${alpha(T.primary, 0.9)}}
[data-mci] [data-mci-btn="outline"]{background:${T.card};color:${T.foreground};border:1px solid ${T.border}}
[data-mci] [data-mci-btn="outline"]:not(:disabled):hover{background:${T.muted}}
[data-mci] [data-mci-btn="ghost"]{background:transparent;color:${T.foreground};border:1px solid transparent}
[data-mci] [data-mci-btn="ghost"]:not(:disabled):hover{background:${T.muted}}
[data-mci] [data-mci-btn]:disabled{opacity:.5;cursor:not-allowed}
[data-mci] [data-mci-link]{background:none;border:0;padding:0;cursor:pointer;font-family:${FONT.ui};color:${T.primary};text-underline-offset:2px}
[data-mci] [data-mci-link] span{font-size:12px;line-height:16px;font-weight:700}
[data-mci] [data-mci-link]:not(:disabled):hover{text-decoration:underline}
[data-mci] [data-mci-back]{background:none;border:0;padding:0;cursor:pointer;color:${T.mutedFg};font-family:${FONT.ui}}
[data-mci] [data-mci-back]:hover{color:${T.foreground}}
[data-mci] [data-mci-back]:disabled{opacity:.5;cursor:not-allowed}
[data-mci-actions]{display:flex;flex-direction:column;gap:8px}
[data-mci-two]{display:grid;gap:8px;grid-template-columns:minmax(0,1fr)}
@media (min-width:640px){
[data-mci] [data-mci-btn]{width:auto}
[data-mci-actions]{flex-direction:row}
[data-mci-two]{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
}
`
const card = { borderRadius: R.xl, border: `1px solid ${T.border}`, background: T.card }
const small = { fontSize: '12px', lineHeight: '16px', color: T.mutedFg }
const muted = { fontFamily: FONT.body, fontSize: '14px', lineHeight: 1.625, color: T.mutedFg }
const notice = (tone) => ({ marginTop: '12px', fontSize: '13px', lineHeight: 1.5, borderRadius: R.md, padding: '8px 12px', textAlign: 'left', color: tone === 'bad' ? T.destructive : T.warning, background: tone === 'bad' ? T.destructiveSoft : T.warningSoft })

function Btn({ variant = 'outline', children, ...rest }) {
  return <button type="button" data-mci-btn={variant} {...rest}><span>{children}</span></button>
}
function Label({ children }) {
  return <h4 style={{ margin: '28px 0 8px', fontSize: '12px', lineHeight: '16px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.025em', color: T.mutedFg }}>{children}</h4>
}
const ArrowLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
)

export default function MailchimpImportScreen({ locationId, onClose, fetchImpl }) {
  const doFetch = fetchImpl || ((u, i) => fetch(u, i))
  const [model, setModel] = useState(null)
  const [err, setErr] = useState(null)
  const [group, setGroup] = useState(null)        // 'out' = the group unticked; null = default (ticked)
  const [cs, setCs] = useState({})                // member id → 'in' | 'out', a person's own tick
  const [saveErr, setSaveErr] = useState(null)
  const [open, setOpen] = useState(0)            // how many of "Will be created" are shown; 0 = closed
  const [asking, setAsking] = useState(false)    // the confirmation page
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  const [doneErr, setDoneErr] = useState(null)
  const [result, setResult] = useState(null)

  const take = (m) => {
    setModel(m); setGroup(m.group || null)
    setCs(Object.fromEntries(m.create.filter((p) => p.c).map((p) => [p.k, p.c])))
  }
  const isOn = (p) => (cs[p.k] ? cs[p.k] === 'in' : group !== 'out')
  const ticked = useMemo(() => new Set((model?.create || []).filter(isOn).map((p) => p.k)), [model, group, cs])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await doFetch('/api/mailchimp/import?location_id=' + encodeURIComponent(locationId || ''), { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        if (!r.ok) { setErr(j.words || 'This screen could not be loaded. Please try again.'); return }
        take(j.model)
      } catch {
        if (!cancelled) setErr('This screen could not be loaded. Please try again.')
      }
    })()
    return () => { cancelled = true }
  }, [locationId])

  const tally = useMemo(() => (model ? importTally(model, ticked) : null), [model, ticked])

  async function save(scope, key, choice, undo) {
    setSaveErr(null)
    try {
      const r = await doFetch('/api/mailchimp/import/choice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, scope, key, choice }),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); undo(); setSaveErr(j.words || 'Your choice could not be saved. Please try again.') }
    } catch {
      undo(); setSaveErr('Your choice could not be saved. Please try again.')
    }
  }

  if (err) return <Frame onClose={onClose}><p role="alert" style={notice('bad')}>{err}</p></Frame>
  if (!model) return <Frame onClose={onClose}><p style={{ fontSize: '14px', color: T.mutedFg }}>Reading your Bee Hub and Mailchimp…</p></Frame>

  const chosen = model.create.filter((p) => ticked.has(p.k))
  const unsubChosen = chosen.filter((p) => p.s === 'unsubscribed').length
  const place = model.location.name

  async function bringIn() {
    setBusy(true); setDoneErr(null); setChanged(false)
    try {
      const ids = chosen.map((p) => p.k)
      const r = await doFetch('/api/mailchimp/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, member_ids: ids, count: ids.length }),
      })
      const j = await r.json().catch(() => ({}))
      if (r.status === 409 && j.error === 'changed' && j.model) { take(j.model); setChanged(true); setAsking(false); return }
      if (!r.ok) { setDoneErr(j.words || 'Nobody was brought in. Bee Hub couldn’t finish — please try again in a few minutes.'); return }
      setResult(j); setAsking(false)
    } catch {
      setDoneErr('Nobody was brought in. Bee Hub couldn’t finish — please try again in a few minutes.')
    } finally { setBusy(false) }
  }

  // ── After the import ──
  if (result) return (
    <Frame onClose={onClose} after>
      <section data-testid="mci-result" style={{ ...card, padding: '20px' }}>
        <h2 style={{ fontFamily: FONT.body, fontSize: '20px', lineHeight: '28px', fontWeight: 400, color: T.primary }}>
          <strong>{people(result.created)}</strong> brought into Bee Hub
        </h2>
        <p style={{ ...muted, marginTop: '8px' }}>They’re in your clients list as Nurturing. No one was emailed.</p>
        {result.createdUnsubscribed > 0 && <p style={{ ...small, marginTop: '4px' }}>{people(result.createdUnsubscribed)} came in marked “No marketing emails”, because they unsubscribed in Mailchimp.</p>}
        {result.alreadyThere > 0 && <p style={{ ...small, marginTop: '4px' }}>{people(result.alreadyThere)} had been added to Bee Hub in the meantime, so they weren’t added again.</p>}
        {result.failed?.length > 0 && <p role="alert" data-testid="mci-failed" style={notice('bad')}>{people(result.failed.length)} couldn’t be brought in: {result.failed.map((f) => f.e).join(', ')}. Nothing was created for them.</p>}
        <div data-mci-actions style={{ marginTop: '20px' }}><Btn variant="primary" onClick={onClose}>Back to Mailchimp</Btn></div>
      </section>
    </Frame>
  )

  // ── The confirmation (BeforeWeAdd's shape and words) ──
  if (asking) return (
    <div data-settings-ui data-mci data-testid="mci-confirm" style={frameStyle}>
      <style>{CSS}</style>
      <button type="button" data-mci-back onClick={() => setAsking(false)} disabled={busy} style={backStyle}><ArrowLeft /><span style={{ fontSize: '14px', lineHeight: '20px' }}>Back to the review</span></button>
      <div style={{ marginTop: '20px' }}>
        <h2 data-testid="mci-confirm-count" style={{ fontFamily: FONT.body, fontSize: '24px', lineHeight: '32px', fontWeight: 400, color: T.primary }}>
          Bring <strong>{people(chosen.length)}</strong> into <strong>{place}?</strong>
        </h2>
        <p data-testid="mci-confirm-what" style={{ ...muted, marginTop: '12px' }}>They’re added to Bee Hub as Nurturing, dated from when they joined Mailchimp. No one is emailed, and nothing is sent to Jobber or Slack.</p>
        {unsubChosen > 0 && <p data-testid="mci-confirm-unsub" style={{ ...small, marginTop: '4px' }}>{unsubChosen === 1 ? '1 of them unsubscribed' : `${n(unsubChosen)} of them unsubscribed`} in Mailchimp, so {unsubChosen === 1 ? 'they come' : 'they come'} in marked “No marketing emails” at every location.</p>}
        {doneErr && <p role="alert" style={notice('bad')}>{doneErr}</p>}
        <div data-mci-actions style={{ marginTop: '24px' }}>
          <Btn variant="primary" data-testid="mci-yes" disabled={busy || !chosen.length} onClick={bringIn}>{busy ? 'Bringing them in…' : 'Bring them in'}</Btn>
          <Btn variant="ghost" disabled={busy} onClick={() => setAsking(false)}>Cancel</Btn>
        </div>
      </div>
    </div>
  )

  // ── The review ──
  // Same as slice 6: the group's tick is the group's; a person's own tick
  // overrides it and is kept only where it differs from the group.
  const ready = model.choicesReady
  const setAll = (on) => {
    const before = group, choice = on ? null : 'out'
    setGroup(choice); save('group', 'new', choice, () => setGroup(before))
  }
  const setOne = (p, on) => {
    const before = cs, byGroup = group !== 'out'
    const c = on === byGroup ? undefined : (on ? 'in' : 'out')
    const next = { ...cs }; if (c) next[p.k] = c; else delete next[p.k]
    setCs(next); save('person', String(p.e).trim().toLowerCase(), c || null, () => setCs(before))
  }
  const allOn = model.create.length > 0 && group !== 'out'
  const skippedRows = Object.entries(model.skipped.byReason).sort((a, b) => b[1] - a[1]).map(([r, c]) => [SKIP_WORDS[r] || r, c])

  return (
    <Frame onClose={onClose}>
      <section aria-label="How many people will be brought in" style={{ ...card, padding: '20px', textAlign: 'center' }}>
        <p aria-live="polite" data-testid="mci-big-number" style={{ fontSize: '48px', lineHeight: 1, fontWeight: 300, color: T.foreground, fontFamily: FONT.heading, fontVariantNumeric: 'tabular-nums' }}>{n(tally.bringing)}</p>
        <p data-testid="mci-big-words" style={{ marginTop: '4px', fontSize: '16px', lineHeight: '24px', color: T.foreground }}>
          {tally.bringing === 1 ? 'person' : 'people'} will be brought into <strong style={{ fontWeight: 700 }}>{place}</strong>
        </p>
        <p data-testid="mci-tally" style={{ ...small, marginTop: '8px', fontFamily: FONT.body }}>
          {n(tally.bringing)} to bring in
          {tally.unticked > 0 && <> · {n(tally.unticked)} not ticked</>}
          {tally.held > 0 && <> · {n(tally.held)} to check</>}
          {tally.skipped > 0 && <> · {n(tally.skipped)} skipped</>}
          {' '}· {n(tally.already)} already in Bee Hub — {n(tally.total)} in your Mailchimp
        </p>
        {changed && <p role="status" data-testid="mci-changed" style={notice('warn')}>Something changed in Mailchimp or Bee Hub since you looked, so nobody was brought in. Here it is again.</p>}
        {!ready && model.create.length > 0 && <p role="status" data-testid="mci-not-ready" style={notice('warn')}>Saving choices isn’t switched on yet, so the ticks below can’t be changed.</p>}
        {saveErr && <p role="alert" data-testid="mci-save-err" style={notice('bad')}>{saveErr}</p>}
      </section>

      <Label>Will be created</Label>
      <div data-testid="mci-group-create" style={{ ...card, padding: '16px' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: model.create.length ? 'pointer' : 'default' }}>
          <input type="checkbox" checked={allOn} disabled={!model.create.length || !ready} onChange={(e) => setAll(e.target.checked)} aria-label="New to Bee Hub" style={{ marginTop: '2px' }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: 'block', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>New to Bee Hub</span>
            <span style={{ ...small, display: 'block' }}>{model.create.length ? 'In your Mailchimp, not in Bee Hub · they come in as Nurturing' : 'No one new — everyone in your Mailchimp is already here or listed below'}</span>
            {Object.keys(cs).length > 0 && <span data-testid="mci-one-by-one" style={{ ...small, display: 'block' }}>{n(Object.keys(cs).length)} changed one by one</span>}
          </span>
          <span style={{ flexShrink: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground, fontVariantNumeric: 'tabular-nums' }}>{n(model.create.length)}</span>
        </label>
        {model.create.length > 0 && (
          <button type="button" data-mci-link data-testid="mci-see" aria-expanded={!!open} onClick={() => setOpen(open ? 0 : PAGE_SIZE)} style={{ marginLeft: '28px', marginTop: '4px', minHeight: '36px' }}>
            <span>{open ? 'Hide' : `See ${model.create.length === 1 ? 'this person' : 'these people'}`}</span>
          </button>
        )}
        {open > 0 && (
          <div data-testid="mci-people" style={{ marginTop: '8px', borderRadius: R.lg, border: `1px solid ${T.border}`, background: T.card }}>
            <p style={{ ...small, padding: '12px 16px 0' }}>A tick here overrides the group.</p>
            <ul>
              {model.create.slice(0, open).map((p, i) => (
                <li key={p.k} data-testid="mci-person" style={{ borderTop: i ? `1px solid ${T.border}` : 'none' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '12px', minHeight: '56px', padding: '10px 16px', cursor: 'pointer' }}>
                    <input type="checkbox" checked={ticked.has(p.k)} disabled={!ready} onChange={(e) => setOne(p, e.target.checked)} aria-label={p.n || p.e} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground, wordBreak: 'break-all' }}>{p.n || p.e}</span>
                      {p.n && <span style={{ ...small, display: 'block', wordBreak: 'break-all' }}>{p.e}</span>}
                      {joinedWords(p.j) && <span style={{ ...small, display: 'block' }}>{joinedWords(p.j)}</span>}
                      {p.s === 'unsubscribed' && <span data-testid="mci-unsub-line" style={{ ...small, display: 'block', color: T.warning }}>Unsubscribed in Mailchimp · comes in marked “No marketing emails”</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px', borderTop: `1px solid ${T.border}`, ...small }}>
              <span>Showing {n(Math.min(open, model.create.length))} of {n(model.create.length)}</span>
              {open < model.create.length
                ? <button type="button" data-mci-btn="outline" onClick={() => setOpen(open + PAGE_SIZE)} style={{ width: 'auto', minHeight: '36px', padding: '6px 20px' }}><span>Show next {n(Math.min(PAGE_SIZE, model.create.length - open))}</span></button>
                : <button type="button" data-mci-link onClick={() => setOpen(0)} style={{ minHeight: '36px' }}><span>Hide</span></button>}
            </div>
          </div>
        )}
      </div>

      <Label>Same person?</Label>
      <div data-testid="mci-held" style={{ ...card, padding: '16px' }}>
        {model.held.length === 0 ? (
          <p style={{ fontSize: '14px', lineHeight: '20px', color: T.foreground }}>No one to check. Nobody in your Mailchimp shares only a phone number or a name with someone in Bee Hub.</p>
        ) : (
          <>
            <p style={small}>These aren’t brought in, so Bee Hub never makes a second record for the same person. Check them in your clients list.</p>
            <ul style={{ marginTop: '8px', display: 'grid', gap: '12px' }}>
              {model.held.map((h) => (
                <li key={h.k} data-testid="mci-held-person">
                  <p style={{ ...small, marginBottom: '6px' }}>{HELD_WORDS[h.reason] || h.reason}</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '8px' }}>
                    <Side where="Mailchimp" name={h.n || h.e} line={h.n ? h.e : null} />
                    {h.match ? <Side where="Bee Hub" name={h.match.n || '(no name)'} line={h.match.e} /> : <Side where="Bee Hub" name={h.reason === 'other_location' ? 'At another location' : 'Someone else in your Mailchimp'} line={null} />}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Label>Not coming in</Label>
      <div data-mci-two>
        <Counts testid="mci-already" title="Already in Bee Hub" total={model.already} rows={[]} none="Matched by email address" />
        <Counts testid="mci-skipped" title="Skipped" total={model.skipped.total} rows={skippedRows} none="No one" />
      </div>
      <p style={{ ...small, marginTop: '12px' }}>Mailchimp tags aren’t copied into Bee Hub yet.</p>

      <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: `1px solid ${T.border}` }}>
        <Btn variant="primary" data-testid="mci-continue" disabled={!tally.bringing} onClick={() => { setDoneErr(null); setAsking(true) }}>
          {tally.bringing ? `Bring in ${people(tally.bringing)}` : (model.create.length ? 'Nobody ticked' : 'No one new to bring in')}
        </Btn>
      </div>
    </Frame>
  )
}

const frameStyle = { margin: '0 auto', padding: '16px', maxWidth: '672px', fontFamily: FONT.ui, color: T.foreground }
const backStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '36px' }

function Frame({ onClose, children, after = false }) {
  return (
    <div data-settings-ui data-mci data-testid="mci-review" style={frameStyle}>
      <style>{CSS}</style>
      <button type="button" data-mci-back onClick={onClose} style={{ ...backStyle, marginBottom: '16px' }}>
        <ArrowLeft /><span style={{ fontSize: '14px', lineHeight: '20px' }}>Back to Mailchimp</span>
      </button>
      <h3 data-testid="mci-title" style={{ fontSize: '24px', lineHeight: '32px', fontWeight: 300, color: T.foreground, fontFamily: FONT.heading, margin: 0 }}>Who comes in from Mailchimp</h3>
      {after ? <div style={{ height: '20px' }} />
        : <p data-testid="mci-nothing-yet" style={{ ...muted, marginTop: '8px', marginBottom: '20px' }}>Nobody is brought in until you confirm, and no one is emailed.</p>}
      {children}
    </div>
  )
}

function Counts({ title, total, rows, testid, none }) {
  return (
    <div data-testid={testid} style={{ ...card, padding: '16px' }}>
      <p style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>
        <span>{title}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{n(total)}</span>
      </p>
      <ul style={{ marginTop: '8px', display: 'grid', gap: '4px' }}>
        {rows.length === 0 && <li style={small}>{none}</li>}
        {rows.map(([label, c]) => (
          <li key={label} style={{ ...small, display: 'flex', justifyContent: 'space-between', gap: '8px' }}><span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{n(c)}</span></li>
        ))}
      </ul>
    </div>
  )
}

function Side({ where, name, line }) {
  return (
    <div style={{ borderRadius: R.lg, background: T.muted, padding: '12px', minWidth: 0 }}>
      <p style={{ fontSize: '11px', lineHeight: '16px', color: T.mutedFg }}>{where}</p>
      <p style={{ fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground, wordBreak: 'break-all' }}>{name}</p>
      {line && <p style={{ ...small, wordBreak: 'break-all' }}>{line}</p>}
    </div>
  )
}
