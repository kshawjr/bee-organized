'use client'
// components/settings/MailchimpReviewScreen.jsx
//
// MAILCHIMP SLICE 5 (FL-75, 2026-11-24): "Who goes to Mailchimp" — the
// first-connect review screen, on the location's real data.
//
// LOOK (2026-11-24, second pass): rebuilt to Kevin's Lovable design,
// kshawjr/mailchimbeehub @ 2cbefaf, src/components/settings/WhoGoesToMailchimp.tsx.
// Same order, same sections, same words where the words are true of the real
// data — plus the page's own heading and "Nothing is sent" line, which the
// pop-up design gets from its frame and a Settings page must keep.
// data: a big number card, then Groups, Not changing, Same person?,
// Exceptions (closed until asked for) and Save. Colours, type and radii are
// the export's, through components/design/tokens.js like the rest of the
// rebuilt Settings. ONLY THE LOOK CHANGED — every rule below is the slice 5 one:
//   • who is in, and the big number, come from lib/mailchimp-review.ts (the
//     same functions the server uses), never from the design's sample numbers
//   • archived people start unticked; the Archived group is always on screen,
//     even with nobody in it; each archived person carries their archive day
//   • people who said no are counted, never listed, never tickable
//   • phone-only matches are asked one at a time; "same" only moves the count
//   • every tick is saved as it is made (POST /api/mailchimp/review); "Done"
//     at the bottom only goes back — there is nothing left unsaved by then
//   • the big-number line names the audience (the location's own list name)
//   • until migrations/mailchimp_review_choices.sql is run, nothing can change
//
// NOTHING IS SENT from this screen; it does not touch Sync now or its
// first-sync confirmation.

import { useEffect, useMemo, useState } from 'react'
import { T, R, FONT, alpha } from '@/components/design/tokens'
import { IconUsers, IconSearch } from '@/components/ui/icons'
import { countAdding, isIncluded, groupDefaultIn, matchedByPhone, prettyDay } from '@/lib/mailchimp-review'
import { archivedLine } from '@/lib/mailchimp-rules'

export const PAGE_SIZE = 50

const n = (x) => Number(x || 0).toLocaleString('en-US')

// The design's short notes under each group, where they are true of the real
// group. "Worked with you" is not "Past and current clients": the group also
// holds people who only ever had a request or a note.
function groupNote(g, archivedDays) {
  if (g.key === 'archived') {
    if (!g.count) return 'No one here is archived'
    const [first, last] = [archivedDays[0], archivedDays[archivedDays.length - 1]]
    if (!first) return 'Tick to add them'
    return (first === last ? `Archived on ${prettyDay(first)}` : `Archived ${prettyDay(first)} – ${prettyDay(last)}`) + ' · tick to add them'
  }
  if (g.key === 'worked') return 'Had a job, quote, request or note with you'
  if (g.key.startsWith('added:')) return 'Added all at once on one day'
  return 'No jobs, notes or messages yet'
}

const STATUS_WORDS = { subscribed: 'Subscribed', cleaned: 'Bounced', unsubscribed: 'Unsubscribed', pending: 'Waiting to confirm', transactional: 'Receipts only', archived: 'Archived in Mailchimp' }
const REASON_WORDS = { unsubscribed_elsewhere: 'Said no to marketing', opted_out: 'Marked “No marketing emails”', unsubscribed: 'Unsubscribed', junk: 'In the Recycle Bin', no_email: 'No email address' }

// Scoped CSS: the export's sm: breakpoint (640px), its checkbox, its hovers.
const CSS = `
[data-mcr] *{box-sizing:border-box}
[data-mcr] p,[data-mcr] h4,[data-mcr] ul{margin:0;padding:0}
[data-mcr] ul{list-style:none}
[data-mcr] input[type=checkbox]{appearance:none;-webkit-appearance:none;margin:0;width:16px;height:16px;flex-shrink:0;border:1px solid ${T.primary};border-radius:6px;background:${T.card};box-shadow:0 1px 3px rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1);display:grid;place-items:center;cursor:pointer}
[data-mcr] input[type=checkbox]:checked{background:${T.primary} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23FAF8F5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/16px no-repeat}
[data-mcr] input[type=checkbox]:disabled{opacity:.5;cursor:not-allowed}
[data-mcr] input[type=checkbox]:focus-visible{outline:none;box-shadow:0 0 0 2px ${T.gold}}
[data-mcr] [data-mcr-btn]{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;width:100%;border-radius:${R.lg};padding:10px 20px;font-family:${FONT.ui};cursor:pointer;transition:background-color .15s}
[data-mcr] [data-mcr-btn] span{font-size:14px;line-height:20px;font-weight:700}
[data-mcr] [data-mcr-btn="primary"]{background:${T.primary};color:${T.primaryFg};border:1px solid transparent}
[data-mcr] [data-mcr-btn="primary"]:not(:disabled):hover{background:${alpha(T.primary, 0.9)}}
[data-mcr] [data-mcr-btn="outline"]{background:${T.card};color:${T.foreground};border:1px solid ${T.border}}
[data-mcr] [data-mcr-btn="outline"]:not(:disabled):hover{background:${T.muted}}
[data-mcr] [data-mcr-btn]:disabled{opacity:.5;cursor:not-allowed}
[data-mcr] [data-mcr-link]{background:none;border:0;padding:0;cursor:pointer;font-family:${FONT.ui};color:${T.primary};text-underline-offset:2px}
[data-mcr] [data-mcr-link] span{font-size:12px;line-height:16px;font-weight:700}
[data-mcr] [data-mcr-link]:not(:disabled):hover{text-decoration:underline}
[data-mcr] [data-mcr-link]:disabled{opacity:.5;cursor:not-allowed}
[data-mcr] [data-mcr-back]{background:none;border:0;padding:0;cursor:pointer;color:${T.mutedFg};font-family:${FONT.ui}}
[data-mcr] [data-mcr-back]:hover{color:${T.foreground}}
[data-mcr] [data-mcr-field]{min-height:44px;width:100%;border-radius:${R.lg};border:1px solid ${T.border};background:${T.background};color:${T.foreground};font-family:${FONT.ui};outline:none}
[data-mcr] [data-mcr-field]:focus{border-color:${T.gold}}
[data-mcr] input[data-mcr-field]::placeholder{color:${T.mutedFg}}
[data-mcr-actions]{display:flex;flex-direction:column;gap:8px}
[data-mcr-filters]{display:flex;flex-direction:column;gap:8px}
[data-mcr-notchanging]{display:grid;gap:8px;grid-template-columns:minmax(0,1fr)}
[data-mcr-rowgroup]{display:none}
@media (min-width:640px){
[data-mcr] [data-mcr-btn]{width:auto}
[data-mcr-actions]{flex-direction:row}
[data-mcr-filters]{flex-direction:row}
[data-mcr-notchanging]{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
[data-mcr-rowgroup]{display:block}
[data-mcr] [data-mcr-field]{font-size:14px!important}
}
`

const card = { borderRadius: R.xl, border: `1px solid ${T.border}`, background: T.card }
const small = { fontSize: '12px', lineHeight: '16px', color: T.mutedFg }

function Btn({ variant = 'outline', children, ...rest }) {
  return <button type="button" data-mcr-btn={variant} {...rest}>{children}</button>
}
function Label({ children }) {
  return <h4 style={{ margin: '28px 0 8px', fontSize: '12px', lineHeight: '16px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.025em', color: T.mutedFg }}>{children}</h4>
}
const ArrowLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
)

export default function MailchimpReviewScreen({ locationId, onClose }) {
  const [data, setData] = useState(null)       // the GET answer
  const [err, setErr] = useState(null)
  const [people, setPeople] = useState([])
  const [groups, setGroups] = useState([])
  const [phone, setPhone] = useState([])
  const [saveErr, setSaveErr] = useState(null)
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [shown, setShown] = useState(PAGE_SIZE)
  const [listOpen, setListOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/mailchimp/review?location_id=' + encodeURIComponent(locationId || ''), { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (cancelled) return
        if (!r.ok) { setErr(j.words || 'This screen could not be loaded. Please try again.'); return }
        setData(j); setPeople(j.model.people); setGroups(j.model.groups); setPhone(j.model.phone)
      } catch {
        if (!cancelled) setErr('This screen could not be loaded. Please try again.')
      }
    })()
    return () => { cancelled = true }
  }, [locationId])

  const groupChoice = useMemo(() => Object.fromEntries(groups.map((g) => [g.key, g.choice])), [groups])
  const groupLabel = useMemo(() => Object.fromEntries(groups.map((g) => [g.key, g.label])), [groups])
  // The Archived group is always on screen — with nobody in it when nobody is
  // archived (the model only lists groups that have people).
  const shownGroups = useMemo(() => groups.some((g) => g.key === 'archived') ? groups
    : [{ key: 'archived', label: 'Archived', detail: '', count: 0, defaultIn: false, choice: null }, ...groups], [groups])
  const archivedDays = useMemo(() => {
    const tz = data?.location?.timeZone || 'UTC'
    const days = people.filter((p) => p.a).map((p) => {
      try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(p.a)) } catch { return String(p.a).slice(0, 10) }
    })
    return days.sort()
  }, [people, data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return people.filter((p) => (!groupFilter || p.g === groupFilter) && (!q || p.n.toLowerCase().includes(q) || p.e.toLowerCase().includes(q)))
  }, [people, query, groupFilter])

  if (err) return (
    <Frame onClose={onClose}>
      <p role="alert" style={{ fontSize: '13px', lineHeight: 1.5, color: T.destructive, background: T.destructiveSoft, borderRadius: R.md, padding: '8px 12px' }}>{err}</p>
    </Frame>
  )
  if (!data) return <Frame onClose={onClose}><p style={{ fontSize: '14px', color: T.mutedFg }}>Reading your Bee Hub and Mailchimp…</p></Frame>

  const m = data.model
  const ready = data.choicesReady
  const tz = data.location.timeZone
  const audience = (data.location.audienceName || '').trim()

  async function save(scope, key, choice, undo) {
    setSaveErr(null)
    try {
      const r = await fetch('/api/mailchimp/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, scope, key, choice }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        undo(); setSaveErr(j.words || 'Your choice could not be saved. Please try again.')
      }
    } catch {
      undo(); setSaveErr('Your choice could not be saved. Please try again.')
    }
  }

  function setGroup(key, wantIn) {
    const before = groups
    const choice = wantIn === groupDefaultIn(key) ? null : (wantIn ? 'in' : 'out')
    setGroups(groups.map((g) => g.key === key ? { ...g, choice } : g))
    save('group', key, choice, () => setGroups(before))
  }

  function setPerson(p, wantIn) {
    const before = people
    const byGroup = isIncluded({ ...p, c: undefined }, groupChoice)
    const c = wantIn === byGroup ? undefined : (wantIn ? 'in' : 'out')
    setPeople(people.map((x) => x.k === p.k ? { ...x, c } : x))
    save('person', p.k, c || null, () => setPeople(before))
  }

  function answerPhone(s, answer) {
    const before = phone
    setPhone(phone.map((x) => x.id === s.id ? { ...x, answer } : x))
    save('phone', s.id, answer, () => setPhone(before))
  }
  // "Start over" clears every answer, each saved on its own, so the matches
  // are asked again one at a time.
  function startOver() {
    for (const s of phone.filter((x) => x.answer)) answerPhoneReset(s)
  }
  function answerPhoneReset(s) {
    setPhone((cur) => cur.map((x) => x.id === s.id ? { ...x, answer: null } : x))
    save('phone', s.id, null, () => setPhone((cur) => cur.map((x) => x.id === s.id ? { ...x, answer: s.answer } : x)))
  }

  function openList(key) {
    setGroupFilter(key); setShown(PAGE_SIZE); setListOpen(true)
    setTimeout(() => document.getElementById('mc-list')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 0)
  }

  const sameSet = matchedByPhone(phone)
  const nextPhone = phone.find((s) => !s.answer)
  const nextAt = phone.findIndex((s) => !s.answer)
  // A "same person" answer takes them out of the count (not out of the list).
  const addingNow = countAdding(people, groups, sameSet)
  const alreadyNow = m.alreadyInMailchimp - m.alreadyByPhone + sameSet.size
  const newCount = people.filter((p) => !sameSet.has(p.k)).length

  const statusRows = Object.entries(m.alreadyByStatus || {}).sort((a, b) => b[1] - a[1])
    .map(([s, c]) => [STATUS_WORDS[s] || s, c])
  if (sameSet.size) statusRows.push(['Matched by phone', sameSet.size])
  const reasonRows = Object.entries(m.notOffered.byReason || {}).sort((a, b) => b[1] - a[1])
    .map(([r, c]) => [REASON_WORDS[r] || r, c])

  return (
    <Frame onClose={onClose}>
      {/* The big number */}
      <section aria-label="How many people will be added" style={{ ...card, padding: '20px', textAlign: 'center' }}>
        <p aria-live="polite" data-testid="mc-big-number" style={{ fontSize: '48px', lineHeight: 1, fontWeight: 300, color: T.foreground, fontFamily: FONT.heading, fontVariantNumeric: 'tabular-nums' }}>{n(addingNow)}</p>
        <p data-testid="mc-big-words" style={{ marginTop: '4px', fontSize: '16px', lineHeight: '24px', color: T.foreground }}>
          {/* The destination is named, as the first-sync confirmation names it
              (Kevin, 2026-11-24 — because of Chattanooga). The name is the
              location's own mailchimp_list_name, read by the server; only when
              it is missing does the line fall back to "your Mailchimp audience". */}
          {addingNow === 1 ? 'person' : 'people'} {m.mailchimpKnown ? 'will be added to ' : (addingNow === 1 ? 'is ticked to go to ' : 'are ticked to go to ')}
          {audience ? <strong data-testid="mc-audience" style={{ fontWeight: 700 }}>{audience}</strong> : 'your Mailchimp audience'}
        </p>
        {m.mailchimpKnown ? (
          <p data-testid="mc-gap" style={{ ...small, marginTop: '8px', fontFamily: FONT.body }}>
            {n(alreadyNow)} already in your Mailchimp · {n(newCount)} new to Mailchimp
          </p>
        ) : (
          <p role="status" style={{ marginTop: '12px', fontSize: '13px', lineHeight: 1.5, color: T.warning, background: T.warningSoft, borderRadius: R.md, padding: '8px 12px', textAlign: 'left' }}>
            {data.mailchimpWords} So we can’t tell who is already in your Mailchimp — this count includes everyone ticked.
          </p>
        )}
        {!ready && (
          <p role="status" style={{ marginTop: '12px', fontSize: '13px', lineHeight: 1.5, color: T.warning, background: T.warningSoft, borderRadius: R.md, padding: '8px 12px', textAlign: 'left' }}>
            Saving choices isn’t switched on yet, so the ticks below can’t be changed.
          </p>
        )}
        {saveErr && <p role="alert" style={{ marginTop: '12px', fontSize: '13px', lineHeight: 1.5, color: T.destructive, background: T.destructiveSoft, borderRadius: R.md, padding: '8px 12px', textAlign: 'left' }}>{saveErr}</p>}
      </section>

      {/* Groups */}
      <Label>Groups</Label>
      <div style={{ display: 'grid', gap: '8px' }}>
        {shownGroups.map((g) => {
          const on = g.choice ? g.choice === 'in' : g.defaultIn
          const byHand = people.filter((p) => p.g === g.key && p.c).length
          const empty = g.count === 0
          return (
            <div key={g.key} data-testid={'mc-group-' + g.key} style={{ ...card, padding: '16px', background: g.key === 'archived' && !on ? alpha(T.muted, 0.4) : T.card }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: ready && !empty ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={on} disabled={!ready || empty} onChange={(e) => setGroup(g.key, e.target.checked)}
                  aria-label={g.label} style={{ marginTop: '2px' }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>{g.label}</span>
                  <span data-testid="mc-group-note" style={{ ...small, display: 'block' }}>{groupNote(g, archivedDays)}</span>
                  {byHand > 0 && <span style={{ ...small, display: 'block' }}>{n(byHand)} changed one by one</span>}
                </span>
                <span data-testid="mc-group-count" style={{ flexShrink: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground, fontVariantNumeric: 'tabular-nums' }}>{n(g.count)}</span>
              </label>
              {!empty && (
                <button type="button" data-mcr-link onClick={() => openList(g.key)} style={{ marginLeft: '28px', marginTop: '4px', minHeight: '36px' }}>
                  <span>See {g.count === 1 ? 'this person' : 'these people'}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Not changing — counts only, no tick */}
      <Label>Not changing</Label>
      <div data-mcr-notchanging>
        {m.mailchimpKnown && <Counts testid="mc-already" title="Already in your Mailchimp" total={alreadyNow} rows={statusRows} />}
        <Counts testid="mc-not-offered" title="Can’t be added" total={m.notOffered.total} rows={reasonRows} />
      </div>

      {/* Same person? — phone-only matches, one at a time */}
      <Label>Same person?</Label>
      <div style={{ ...card, padding: '16px' }}>
        {phone.length === 0 ? (
          <p style={{ fontSize: '14px', lineHeight: '20px', color: T.foreground }}>No one to check. Nobody here shares only a phone number with someone in your Mailchimp.</p>
        ) : nextPhone ? (
          <div data-testid="mc-phone-next">
            <p style={small}>{nextAt + 1} of {phone.length}{nextPhone.phone ? ` · Same phone number ${nextPhone.phone}` : ''}</p>
            <p style={{ marginTop: '4px', fontSize: '16px', lineHeight: '24px', fontWeight: 700, color: T.foreground }}>Is this the same person?</p>
            <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '8px' }}>
              <Side where="Bee Hub" name={nextPhone.beeHubName || '(no name)'} line={nextPhone.beeHubEmail} />
              <Side where="Mailchimp" name={nextPhone.mailchimpEmail} line={STATUS_WORDS[nextPhone.mailchimpStatus] || nextPhone.mailchimpStatus} />
            </div>
            <div data-mcr-actions style={{ marginTop: '16px' }}>
              <Btn variant="primary" disabled={!ready} onClick={() => answerPhone(nextPhone, 'same')}><span>Yes, same person</span></Btn>
              <Btn variant="outline" disabled={!ready} onClick={() => answerPhone(nextPhone, 'different')}><span>No, different people</span></Btn>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <p style={{ fontSize: '14px', lineHeight: '20px', color: T.foreground }}>All {n(phone.length)} checked. {n(sameSet.size)} {sameSet.size === 1 ? 'was' : 'were'} the same person.</p>
            <button type="button" data-mcr-link disabled={!ready} onClick={startOver} style={{ minHeight: '36px', flexShrink: 0 }}><span>Start over</span></button>
          </div>
        )}
      </div>

      {/* Exceptions — the full list, closed until asked for */}
      <Label>Exceptions</Label>
      <div id="mc-list" style={{ scrollMarginTop: '16px' }}>
        {!listOpen ? (
          <Btn variant="outline" data-testid="mc-open-list" onClick={() => setListOpen(true)}><IconUsers size={16} /><span>Change one person at a time</span></Btn>
        ) : (
          <div style={card}>
            <div data-mcr-filters style={{ padding: '12px', borderBottom: `1px solid ${T.border}` }}>
              <label style={{ position: 'relative', flex: 1, minWidth: 0, display: 'block' }}>
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: T.mutedFg, pointerEvents: 'none', display: 'flex' }}><IconSearch size={16} /></span>
                <input data-mcr-field type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE) }}
                  placeholder="Search by name or email" aria-label="Search people" style={{ paddingLeft: '36px', paddingRight: '12px' }} />
              </label>
              <select data-mcr-field value={groupFilter} onChange={(e) => { setGroupFilter(e.target.value); setShown(PAGE_SIZE) }} aria-label="Filter by group"
                style={{ width: 'auto', padding: '0 12px' }}>
                <option value="">All groups</option>
                {groups.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
              </select>
            </div>
            <p style={{ ...small, padding: '12px 16px 0' }}>A tick here overrides the person’s group.</p>
            <ul data-testid="mc-people">
              {filtered.slice(0, shown).map((p, i) => {
                const matched = sameSet.has(p.k)
                const on = !matched && isIncluded(p, groupChoice)
                // Once ticked, the archived line keeps its date and drops "Tick to add…".
                const line = p.a ? (on ? archivedLine(p.a, tz).replace(/ Tick to add them to Mailchimp\.$/, '') : archivedLine(p.a, tz)) : null
                return (
                  <li key={p.k} data-testid="mc-person" style={{ borderTop: i ? `1px solid ${T.border}` : 'none' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '12px', minHeight: '56px', padding: '10px 16px', cursor: ready && !matched ? 'pointer' : 'default' }}>
                      <input type="checkbox" checked={on} disabled={!ready || matched} onChange={(e) => setPerson(p, e.target.checked)} aria-label={p.n || p.e} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>{p.n || p.e}</span>
                        {p.n && <span style={{ ...small, display: 'block', wordBreak: 'break-all' }}>{p.e}</span>}
                        {matched && <span style={{ ...small, display: 'block' }}>Matched by phone, already in your Mailchimp</span>}
                        {line && <span data-testid="mc-archived-line" style={{ ...small, display: 'block', color: T.warning }}>{line}</span>}
                      </span>
                      <span data-mcr-rowgroup style={{ ...small, flexShrink: 0 }}>{groupLabel[p.g] || p.g}</span>
                      {p.c && !matched && <span style={{ flexShrink: 0, borderRadius: R.full, background: T.goldSoft, padding: '2px 8px', fontSize: '11px', lineHeight: '16px', fontWeight: 700, color: T.foreground }}>Changed</span>}
                    </label>
                  </li>
                )
              })}
              {!filtered.length && <li style={{ padding: '32px 0', textAlign: 'center', fontSize: '14px', color: T.mutedFg }}>No one matches your search.</li>}
            </ul>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px', borderTop: `1px solid ${T.border}`, ...small }}>
              <span>Showing {n(Math.min(shown, filtered.length))} of {n(filtered.length)}</span>
              {shown < filtered.length && (
                <button type="button" data-mcr-btn="outline" onClick={() => setShown(shown + PAGE_SIZE)} style={{ width: 'auto', minHeight: '36px', padding: '6px 20px' }}>
                  <span>Show next {n(Math.min(PAGE_SIZE, filtered.length - shown))}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: `1px solid ${T.border}` }}>
        {/* "Done", not "Save" (Kevin, 2026-11-24): every tick is already saved
            as it is made, so this button only goes back. */}
        <Btn variant="primary" onClick={onClose}><span>Done</span></Btn>
      </div>
    </Frame>
  )
}

function Frame({ onClose, children }) {
  return (
    <div data-settings-ui data-mcr style={{ margin: '0 auto', padding: '16px', maxWidth: '672px', fontFamily: FONT.ui, color: T.foreground }}>
      <style>{CSS}</style>
      <button type="button" data-mcr-back onClick={onClose} style={{ marginBottom: '16px', display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '36px' }}>
        <ArrowLeft /><span style={{ fontSize: '14px', lineHeight: '20px' }}>Back to Mailchimp</span>
      </button>
      {/* KEPT ON PURPOSE (Kevin, 2026-11-24): the design has no heading and no
          reassurance because it opens in a pop-up framed by the Mailchimp logo.
          This is a Settings page with no such frame, so the page keeps both.
          Styled as the design's own heading + line (H and P in MailchimpModal.tsx). */}
      <h3 data-testid="mc-title" style={{ fontSize: '24px', lineHeight: '32px', fontWeight: 300, color: T.foreground, fontFamily: FONT.heading, margin: 0 }}>Who goes to Mailchimp</h3>
      <p data-testid="mc-nothing-sent" style={{ marginTop: '8px', marginBottom: '20px', fontFamily: FONT.body, fontSize: '14px', lineHeight: 1.625, color: T.mutedFg }}>Nothing is sent from this screen. Your ticks are saved as you make them.</p>
      {children}
    </div>
  )
}

function Counts({ title, total, rows, testid }) {
  return (
    <div data-testid={testid} style={{ ...card, padding: '16px' }}>
      <p style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '14px', lineHeight: '20px', fontWeight: 700, color: T.foreground }}>
        <span>{title}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{n(total)}</span>
      </p>
      <ul style={{ marginTop: '8px', display: 'grid', gap: '4px' }}>
        {rows.length === 0 && <li style={small}>No one</li>}
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
