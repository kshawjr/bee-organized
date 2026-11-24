'use client'
// components/settings/MailchimpReviewScreen.jsx
//
// MAILCHIMP SLICE 5 (FL-75, 2026-11-24): "Who goes to Mailchimp" — the
// first-connect review screen, on the location's real data.
//
// Layout, in Kevin's order (ruling 2026-11-24):
//   1. ONE BIG NUMBER first: how many people will be added to Mailchimp,
//      and beside it how many are already there.
//   2. GROUPS with counts, one tick each. Everyone starts ticked except
//      archived people, who start unticked and are always shown.
//   3. Counts with no tick at all: already in Mailchimp, and people who can
//      never be added (said no, Recycle Bin, no email).
//   4. "Same person?" — phone-only matches, one at a time. Nothing joins.
//   5. The full list, for exceptions only: search, 50 at a time.
//
// Every tick is saved as it is made (POST /api/mailchimp/review) and comes
// back when the owner returns. NOTHING IS SENT from this screen; it does not
// touch the Sync now button or its first-sync confirmation.
//
// The rules (who is in, the big number) come from lib/mailchimp-review.ts,
// the same functions the server uses, so the screen cannot count differently.

import { useEffect, useMemo, useState } from 'react'
import { T as HT } from '@/components/hive/shared/tokens'
import { countAdding, isIncluded, groupDefaultIn, bigNumberWords, matchedByPhone, NOT_OFFERED_WORDS } from '@/lib/mailchimp-review'
import { archivedLine } from '@/lib/mailchimp-rules'

export const PAGE_SIZE = 50

const n = (x) => Number(x || 0).toLocaleString('en-US')
const plural = (x, one, many) => `${n(x)} ${x === 1 ? one : many}`

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return people.filter((p) => (!groupFilter || p.g === groupFilter) && (!q || p.n.toLowerCase().includes(q) || p.e.toLowerCase().includes(q)))
  }, [people, query, groupFilter])

  if (err) return (
    <Frame onClose={onClose}>
      <p role="alert" style={{ fontSize: '13px', color: HT.state.danger.fg, background: HT.state.danger.soft, borderRadius: HT.radius.control, padding: '10px 12px', lineHeight: 1.5 }}>{err}</p>
    </Frame>
  )
  if (!data) return <Frame onClose={onClose}><p style={{ fontSize: '13px', color: HT.ink.quiet }}>Reading your Bee Hub and Mailchimp…</p></Frame>

  const m = data.model
  const ready = data.choicesReady
  const tz = data.location.timeZone

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

  const sameSet = matchedByPhone(phone)
  const nextPhone = phone.find((s) => !s.answer)
  const answered = phone.filter((s) => s.answer)
  // A "same person" answer takes them out of the count (not out of the list).
  const addingNow = countAdding(people, groups, sameSet)
  const alreadyNow = m.alreadyInMailchimp - m.alreadyByPhone + sameSet.size
  const newCount = people.filter((p) => !sameSet.has(p.k)).length

  const statusLine = Object.entries(m.alreadyByStatus || {})
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${n(c)} ${s === 'cleaned' ? 'bounced (cleaned)' : s}`).join(' · ')

  return (
    <Frame onClose={onClose}>
      {/* 1. The big number */}
      <section aria-labelledby="mc-big" style={{ background: HT.surface.raised, border: HT.border.card, borderRadius: HT.radius.card, boxShadow: HT.shadow.card, padding: '18px 18px 16px' }}>
        <p id="mc-big" data-testid="mc-big-number" style={{ fontSize: '44px', lineHeight: 1, fontWeight: 800, color: HT.accent.fg, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>{n(addingNow)}</p>
        <p style={{ fontSize: '15px', fontWeight: 700, color: HT.ink.primary, lineHeight: 1.4, marginTop: '6px' }}>
          {bigNumberWords({ adding: addingNow, mailchimpKnown: m.mailchimpKnown }, data.location.audienceName)}
        </p>
        {m.mailchimpKnown ? (
          <p data-testid="mc-gap" style={{ fontSize: '13px', color: HT.ink.secondary, lineHeight: 1.6, marginTop: '6px' }}>
            {n(alreadyNow)} already in your Mailchimp · {n(newCount)} new to Mailchimp
          </p>
        ) : (
          <p role="status" style={{ fontSize: '13px', color: HT.state.warning.fg, background: HT.state.warning.soft, borderRadius: HT.radius.control, padding: '8px 10px', lineHeight: 1.5, marginTop: '8px' }}>
            {data.mailchimpWords} So we can’t tell who is already in your Mailchimp — this count includes everyone ticked.
          </p>
        )}
        <p style={{ fontSize: '12px', color: HT.ink.muted, lineHeight: 1.6, marginTop: '10px' }}>
          Nothing is sent from this screen. Your ticks are saved as you make them. Everyone starts ticked, except archived people.
        </p>
        {!ready && (
          <p role="status" style={{ fontSize: '12px', color: HT.state.warning.fg, background: HT.state.warning.soft, borderRadius: HT.radius.control, padding: '8px 10px', lineHeight: 1.5, marginTop: '8px' }}>
            Saving choices isn’t switched on yet, so the ticks below can’t be changed.
          </p>
        )}
        {saveErr && <p role="alert" style={{ fontSize: '12px', color: HT.state.danger.fg, background: HT.state.danger.soft, borderRadius: HT.radius.control, padding: '8px 10px', lineHeight: 1.5, marginTop: '8px' }}>{saveErr}</p>}
      </section>

      {/* 2. Groups */}
      <SectionTitle>Groups</SectionTitle>
      <div style={{ background: HT.surface.raised, border: HT.border.card, borderRadius: HT.radius.card, overflow: 'hidden' }}>
        {groups.length === 0 && <p style={{ padding: '14px', fontSize: '13px', color: HT.ink.quiet }}>Nobody new to add — everyone who can be added is already in your Mailchimp.</p>}
        {groups.map((g, i) => {
          const on = g.choice ? g.choice === 'in' : g.defaultIn
          const inGroup = people.filter((p) => p.g === g.key)
          const byHand = inGroup.filter((p) => p.c).length
          const ticked = inGroup.filter((p) => !sameSet.has(p.k) && isIncluded(p, groupChoice)).length
          return (
            <div key={g.key} data-testid={'mc-group-' + g.key} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '13px 14px', borderTop: i ? HT.border.divider : 'none' }}>
              <input type="checkbox" checked={on} disabled={!ready} onChange={(e) => setGroup(g.key, e.target.checked)}
                aria-label={`${on ? 'Untick' : 'Tick'} everyone in ${g.label}`} style={{ width: '20px', height: '20px', marginTop: '2px', flexShrink: 0, accentColor: HT.accent.fg }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <p style={{ fontSize: '14px', fontWeight: 700, color: HT.ink.primary }}>{g.label}</p>
                  <p style={{ fontSize: '13px', color: HT.ink.secondary, fontVariantNumeric: 'tabular-nums' }}>{n(ticked)} of {n(g.count)} ticked</p>
                </div>
                <p style={{ fontSize: '12px', color: HT.ink.muted, lineHeight: 1.5, marginTop: '3px' }}>{g.detail}</p>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '4px', alignItems: 'center' }}>
                  <button type="button" onClick={() => { setGroupFilter(g.key); setShown(PAGE_SIZE); document.getElementById('mc-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}
                    className="bee-small-action" style={linkBtn}>See these {g.count === 1 ? 'person' : 'people'}</button>
                  {byHand > 0 && <span style={{ fontSize: '12px', color: HT.ink.quiet }}>{plural(byHand, 'changed', 'changed')} one by one</span>}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 3. Counts only — no tick */}
      <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
        {m.mailchimpKnown && (
          <InfoRow title="Already in your Mailchimp" count={alreadyNow}
            detail={(statusLine || 'No one yet') + (sameSet.size ? ` · ${plural(sameSet.size, 'person', 'people')} you matched by phone` : '') + '. Nothing to choose here.'} />
        )}
        <InfoRow testid="mc-not-offered" title="Can’t be added" count={m.notOffered.total}
          detail={(Object.entries(m.notOffered.byReason).map(([r, c]) => `${n(c)} ${NOT_OFFERED_WORDS[r] || r}`).join(' · ') || 'No one') + '. No one can tick these people in.'} />
      </div>

      {/* 4. Phone-only matches */}
      {phone.length > 0 && (
        <>
          <SectionTitle>Same person? <span style={{ fontWeight: 500, color: HT.ink.quiet }}>{n(answered.length)} of {n(phone.length)} checked</span></SectionTitle>
          <div style={{ background: HT.surface.raised, border: HT.border.card, borderRadius: HT.radius.card, padding: '14px' }}>
            {nextPhone ? (
              <div data-testid="mc-phone-next">
                <p style={{ fontSize: '13px', color: HT.ink.secondary, lineHeight: 1.6 }}>These two share a phone number{nextPhone.phone ? ` (${nextPhone.phone})` : ''} but not an email address. Nothing is joined unless you say so — and even then, only this screen changes.</p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px', marginTop: '10px' }}>
                  <Side label="In Mailchimp" lines={[nextPhone.mailchimpEmail, nextPhone.mailchimpStatus]} />
                  <Side label="In Bee Hub" lines={[nextPhone.beeHubName || '(no name)', nextPhone.beeHubEmail]} />
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
                  <button type="button" disabled={!ready} onClick={() => answerPhone(nextPhone, 'same')} className="bee-small-action" style={primaryBtn(ready)}>Yes, same person</button>
                  <button type="button" disabled={!ready} onClick={() => answerPhone(nextPhone, 'different')} className="bee-small-action" style={{ ...quietBtn, opacity: ready ? 1 : 0.45, cursor: ready ? 'pointer' : 'default' }}>No, different people</button>
                </div>
              </div>
            ) : <p style={{ fontSize: '13px', color: HT.ink.secondary }}>All checked.</p>}
            {answered.length > 0 && (
              <details style={{ marginTop: '12px' }}>
                <summary style={{ fontSize: '12px', color: HT.ink.secondary, cursor: 'pointer' }}>Answers so far ({n(answered.length)})</summary>
                {answered.map((s) => (
                  <p key={s.id} style={{ fontSize: '12px', color: HT.ink.muted, marginTop: '6px', lineHeight: 1.5, wordBreak: 'break-word' }}>
                    {s.beeHubEmail} ↔ {s.mailchimpEmail}: <strong>{s.answer === 'same' ? 'same person' : 'different people'}</strong>{' '}
                    <button type="button" disabled={!ready} onClick={() => answerPhone(s, null)} className="bee-small-action" style={linkBtn}>Ask again</button>
                  </p>
                ))}
              </details>
            )}
          </div>
        </>
      )}

      {/* 5. The list — for exceptions */}
      <SectionTitle id="mc-list">Change one person</SectionTitle>
      <p style={{ fontSize: '12px', color: HT.ink.muted, lineHeight: 1.5, margin: '-4px 2px 8px' }}>Only needed for exceptions. A tick here overrides the person’s group.</p>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input type="search" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE) }} placeholder="Search name or email" aria-label="Search name or email"
          style={{ flex: '1 1 220px', minWidth: 0, padding: '10px 12px', fontSize: '16px', fontFamily: 'inherit', border: HT.border.control, borderRadius: HT.radius.control, background: HT.surface.raised, color: HT.ink.primary }} />
        <select value={groupFilter} onChange={(e) => { setGroupFilter(e.target.value); setShown(PAGE_SIZE) }} aria-label="Show group"
          style={{ flex: '1 1 160px', minWidth: 0, padding: '10px 12px', fontSize: '16px', fontFamily: 'inherit', border: HT.border.control, borderRadius: HT.radius.control, background: HT.surface.raised, color: HT.ink.primary }}>
          <option value="">All groups ({n(people.length)})</option>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.label} ({n(g.count)})</option>)}
        </select>
      </div>
      <p style={{ fontSize: '12px', color: HT.ink.quiet, margin: '8px 2px' }}>{n(filtered.length)} {filtered.length === 1 ? 'person' : 'people'}{filtered.length > shown ? ` · showing ${n(shown)}` : ''}</p>
      <div data-testid="mc-people" style={{ background: HT.surface.raised, border: HT.border.card, borderRadius: HT.radius.card, overflow: 'hidden' }}>
        {filtered.length === 0 && <p style={{ padding: '14px', fontSize: '13px', color: HT.ink.quiet }}>No one matches.</p>}
        {filtered.slice(0, shown).map((p, i) => {
          const matched = sameSet.has(p.k)
          const on = !matched && isIncluded(p, groupChoice)
          // Once ticked, the archived line keeps its date and drops "Tick to add…".
          const line = p.a ? (on ? archivedLine(p.a, tz).replace(/ Tick to add them to Mailchimp\.$/, '') : archivedLine(p.a, tz)) : null
          return (
            <div key={p.k} data-testid="mc-person" style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '11px 14px', borderTop: i ? HT.border.divider : 'none' }}>
              <input type="checkbox" checked={on} disabled={!ready || matched} onChange={(e) => setPerson(p, e.target.checked)}
                aria-label={`${on ? 'Untick' : 'Tick'} ${p.n || p.e}`} style={{ width: '20px', height: '20px', marginTop: '2px', flexShrink: 0, accentColor: HT.accent.fg }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: '14px', fontWeight: 600, color: HT.ink.primary, lineHeight: 1.35 }}>{p.n || p.e}</p>
                {p.n && <p style={{ fontSize: '12px', color: HT.ink.muted, wordBreak: 'break-all', lineHeight: 1.4 }}>{p.e}</p>}
                <p style={{ fontSize: '12px', color: HT.ink.quiet, lineHeight: 1.5, marginTop: '2px' }}>
                  {groupLabel[p.g] || p.g}
                  {matched && ' · matched by phone, already in your Mailchimp'}
                  {p.c && !matched && <> · changed by you{' '}<button type="button" disabled={!ready} onClick={() => setPerson(p, isIncluded({ ...p, c: undefined }, groupChoice))} className="bee-small-action" style={linkBtn}>Undo</button></>}
                </p>
                {line && <p data-testid="mc-archived-line" style={{ fontSize: '12px', color: HT.state.warning.fg, lineHeight: 1.5, marginTop: '2px' }}>{line}</p>}
              </div>
            </div>
          )
        })}
      </div>
      {filtered.length > shown && (
        <button type="button" onClick={() => setShown(shown + PAGE_SIZE)} className="bee-small-action" style={{ ...quietBtn, marginTop: '10px', width: '100%' }}>Show {n(Math.min(PAGE_SIZE, filtered.length - shown))} more</button>
      )}

      <p style={{ fontSize: '13px', color: HT.ink.secondary, margin: '16px 2px 0', lineHeight: 1.6 }}>
        <strong style={{ color: HT.ink.primary }}>{n(addingNow)}</strong> {addingNow === 1 ? 'person' : 'people'} ticked{m.mailchimpKnown ? ' to be added' : ''}. Your choices are saved.
      </p>
    </Frame>
  )
}

const linkBtn = { background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: '12px', fontWeight: 600, color: HT.accent.fg, cursor: 'pointer', textDecoration: 'underline' }
const quietBtn = { padding: '9px 14px', background: 'transparent', border: HT.border.control, borderRadius: HT.radius.control, fontFamily: 'inherit', fontWeight: 600, fontSize: '13px', color: HT.ink.secondary, cursor: 'pointer' }
const primaryBtn = (on) => ({ padding: '9px 14px', background: on ? HT.accent.fg : HT.ink.disabled, border: 'none', borderRadius: HT.radius.control, fontFamily: 'inherit', fontWeight: 700, fontSize: '13px', color: HT.accent.onFill, cursor: on ? 'pointer' : 'default' })

function Frame({ onClose, children }) {
  return (
    <div style={{ margin: '14px 12px 24px', maxWidth: '720px' }}>
      <button type="button" onClick={onClose} className="bee-small-action" style={{ ...linkBtn, textDecoration: 'none', marginBottom: '8px' }}>← Back to Mailchimp</button>
      <h2 style={{ fontSize: '20px', fontWeight: 700, color: HT.ink.primary, margin: '0 2px 12px', letterSpacing: '-0.015em' }}>Who goes to Mailchimp</h2>
      {children}
    </div>
  )
}

function SectionTitle({ children, id }) {
  return <p id={id} style={{ fontSize: '12px', fontWeight: 700, color: HT.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px', margin: '20px 2px 8px' }}>{children}</p>
}

function InfoRow({ title, count, detail, testid }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '12px 14px', background: HT.surface.sunken, borderRadius: HT.radius.inset }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <p style={{ fontSize: '14px', fontWeight: 700, color: HT.ink.primary }}>{title}</p>
          <p style={{ fontSize: '14px', fontWeight: 700, color: HT.ink.primary, fontVariantNumeric: 'tabular-nums' }}>{n(count)}</p>
        </div>
        <p style={{ fontSize: '12px', color: HT.ink.muted, lineHeight: 1.5, marginTop: '3px' }}>{detail}</p>
      </div>
    </div>
  )
}

function Side({ label, lines }) {
  return (
    <div style={{ background: HT.surface.sunken, borderRadius: HT.radius.control, padding: '10px 12px', minWidth: 0 }}>
      <p style={{ fontSize: '11px', fontWeight: 700, color: HT.ink.muted, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</p>
      {lines.filter(Boolean).map((l, i) => <p key={i} style={{ fontSize: '13px', color: i ? HT.ink.muted : HT.ink.primary, fontWeight: i ? 400 : 600, wordBreak: 'break-all', marginTop: '3px' }}>{l}</p>)}
    </div>
  )
}
