// components/network/NurtureSheet.jsx
// ─────────────────────────────────────────────────────────────
// WHAT OPENS WHEN A NURTURING ROW IS TAPPED (Network & Nurture redesign,
// slice 7). READ-ONLY: it reads GET /api/network/nurturing/<id> and has no
// control that sends anything. Every action is slice 8.
//
// A NURTURING PERSON IS A LEAD, NOT A PARTNER. The design opens Nurturing
// rows in the same contact sheet as Network. That sheet (ContactSheet.jsx)
// was built for `partners`: types, partner level, partner stage, partner
// touchpoint kinds, Network tag groups, and it saves to the partners table.
// A lead has none of those, and has its own things instead: a request and
// what they asked for, assessments, quotes, jobs, engagements and how they
// closed, marketing consent, client tags. So a lead gets its own view, in
// the same look (the same sheet frame and colours), showing a lead's fields.
// Nothing partner-only is drawn here, and nothing here writes to `leads`.
//
// The first thing it shows is WHY this person is Nurturing, line by line,
// from the rule itself (lib/network/nurturing.ts): added when, never a job,
// and when their last assessment or quote was. Kevin can lower the 90 days,
// and this line follows.
//
// It is a WINDOW: it closes by its own ✕ or Escape, never by a click
// outside it (lib/beta-no-outside-close.test.tsx lists it with the windows).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useRef, useState } from 'react'
import { T, NET, FONT, FONT_STYLESHEET_HREF } from '@/components/design/tokens'
import { closedReasonLabel } from '@/components/hive/shared/engagementStatus'

const CSS = `
[data-nurture-sheet]{position:fixed;inset:0;z-index:400;display:flex;justify-content:flex-end;background:color-mix(in oklab,${T.primary} 30%,transparent);font-family:${FONT.ui};color:${T.foreground};animation:nu-fade 240ms ease-out both}
[data-nurture-sheet] *{box-sizing:border-box}
[data-nurture-sheet] button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;font-size:inherit;text-align:inherit;padding:0}
[data-nurture-sheet] :is(button,a):focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
[data-nurture-sheet] .nu-sheet{height:100%;width:100%;max-width:576px;overflow-y:auto;overscroll-behavior-y:contain;background:${T.background};box-shadow:0 24px 60px -20px rgba(26,48,44,.35);animation:nu-in 440ms cubic-bezier(.22,1,.36,1) both;padding-bottom:env(safe-area-inset-bottom,0px);outline:none}
@keyframes nu-fade{from{opacity:0}}
@keyframes nu-in{from{transform:translateX(24px);opacity:0}}
[data-nurture-sheet] .nu-top{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;min-height:52px;padding:4px 24px;background:${T.card}}
[data-nurture-sheet] .nu-eyebrow{font-size:11.2px!important;font-weight:700;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-nurture-sheet] .nu-close{display:grid;place-items:center;width:44px;height:44px;margin-right:-10px;border-radius:10px;color:${T.mutedFg}}
[data-nurture-sheet] .nu-close:hover{background:${T.muted};color:${T.primary}}
[data-nurture-sheet] .nu-mast{background:${T.card};border-bottom:1px solid ${T.border};padding:8px 24px 20px}
[data-nurture-sheet] .nu-identity{display:flex;align-items:flex-start;gap:14px}
[data-nurture-sheet] .nu-avatar{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:56px;height:56px;border-radius:999px;background:${NET.nurtureSoft};color:${T.primary};font-size:16px;font-weight:700}
[data-nurture-sheet] h2{font-family:${FONT.heading};font-size:24px;font-weight:500;line-height:1.25;color:${T.primary};margin:0;overflow-wrap:anywhere}
[data-nurture-sheet] .nu-sub{margin:4px 0 0;font-size:13px;color:${T.mutedFg};overflow-wrap:anywhere}
[data-nurture-sheet] .nu-pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
[data-nurture-sheet] .nu-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;border:1px solid;font-size:11.5px;font-weight:700;white-space:nowrap}
[data-nurture-sheet] .nu-pill[data-tone="nurture"]{color:${T.primary};background:${NET.nurtureSoft};border-color:color-mix(in oklab,${NET.nurture} 45%,transparent)}
[data-nurture-sheet] .nu-pill[data-tone="warn"]{color:${T.foreground};background:${NET.warnSoft};border-color:${NET.warn}}
[data-nurture-sheet] .nu-pill[data-tone="quiet"]{color:${T.mutedFg};background:${T.muted};border-color:${T.border}}
[data-nurture-sheet] .nu-body{display:flex;flex-direction:column;gap:16px;padding:20px 24px 32px}
[data-nurture-sheet] section{background:${T.card};border:1px solid ${T.border};border-radius:14px;padding:16px}
[data-nurture-sheet] h3{font-family:${FONT.heading};font-size:15px;font-weight:700;color:${T.primary};margin:0 0 10px}
[data-nurture-sheet] dl{display:grid;grid-template-columns:minmax(96px,max-content) 1fr;gap:8px 16px;margin:0;font-size:14px}
[data-nurture-sheet] dt{color:${T.mutedFg};font-size:13px}
[data-nurture-sheet] dd{margin:0;min-width:0;overflow-wrap:anywhere;color:${T.foreground}}
[data-nurture-sheet] dd a{color:${T.primary};font-weight:700;text-decoration:none}
[data-nurture-sheet] .nu-why{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:14px}
[data-nurture-sheet] .nu-why li{display:flex;gap:10px;align-items:flex-start;line-height:1.45}
[data-nurture-sheet] .nu-why i{flex-shrink:0;width:8px;height:8px;margin-top:6px;border-radius:999px;background:${NET.nurture}}
[data-nurture-sheet] .nu-list{list-style:none;margin:0;padding:0;font-size:13.5px}
[data-nurture-sheet] .nu-list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid ${T.border}}
[data-nurture-sheet] .nu-list li:first-child{border-top:0;padding-top:0}
[data-nurture-sheet] .nu-list b{font-weight:700;color:${T.primary}}
[data-nurture-sheet] .nu-list span{color:${T.mutedFg};text-align:right;white-space:nowrap}
[data-nurture-sheet] .nu-list s{color:${T.mutedFg}}
[data-nurture-sheet] .nu-quiet{font-size:13px;color:${T.mutedFg};margin:0;line-height:1.5}
[data-nurture-sheet] .nu-chips{display:flex;flex-wrap:wrap;gap:6px}
[data-nurture-sheet] .nu-chip{padding:1px 8px;border-radius:999px;font-size:12px;line-height:18px;font-weight:700;border:1px solid ${T.border};background:${T.muted};color:${T.primary}}
[data-nurture-sheet] .nu-note{white-space:pre-wrap;font-size:14px;line-height:1.5;margin:0}
[data-nurture-sheet] .nu-readonly{margin:0;padding:10px 12px;border:1px dashed ${T.input};border-radius:10px;font-size:12.5px;color:${T.mutedFg};background:${T.card}}
@media (max-width:600px){ [data-nurture-sheet] .nu-top{padding:4px 16px} [data-nurture-sheet] .nu-mast{padding:8px 16px 16px} [data-nurture-sheet] .nu-body{padding:16px 16px 28px} [data-nurture-sheet] dl{grid-template-columns:1fr;gap:2px} [data-nurture-sheet] dd{margin-bottom:8px} }
@media (prefers-reduced-motion:reduce){[data-nurture-sheet] *{animation:none!important}}
`

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function dayLabel(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
const daysAgo = (iso, nowMs) => Math.floor((nowMs - new Date(iso).getTime()) / 86400000)
const money = (n) => (n == null || n === '' ? null : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
// Letters only, so a name like "J. (Jim) Ray" gives JJ, never "J(".
export const initials = (name) => String(name || '?').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'

const WHY_NOT = {
  archived: 'archived',
  junk: 'marked junk',
  too_new: 'added in the last 30 days',
  had_job: 'had a job',
  recent_activity: 'had an assessment or quote recently',
}

const IconX = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>

/**
 * props:
 *   personId    the lead's id
 *   onClose     () => void
 *   fetchImpl   tests hand in a fake fetch
 *   nowMs       tests pin the clock
 */
export default function NurtureSheet({ personId, onClose, fetchImpl = null, nowMs = Date.now() }) {
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState(null)
  const sheet = useRef(null)

  useEffect(() => {
    let live = true
    setData(null); setProblem(null)
    ;(async () => {
      try {
        const res = await (fetchImpl || fetch)(`/api/network/nurturing/${personId}`)
        const json = await res.json().catch(() => ({}))
        if (!live) return
        if (!res.ok) { setProblem(json?.error || `error ${res.status}`); return }
        setData(json)
      } catch (e) { if (live) setProblem('no connection') }
    })()
    return () => { live = false }
  }, [personId, fetchImpl])

  useEffect(() => { sheet.current?.focus() }, [])
  // Escape closes, as every Network window does. A click outside never does.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const p = data?.person
  const v = data?.verdict
  const quiet = data?.quietDays

  return (
    <div data-nurture-sheet>
      <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
      <style>{CSS}</style>
      <aside ref={sheet} className="nu-sheet" role="dialog" aria-modal="true" aria-label={p ? `Nurturing details for ${p.name}` : 'Nurturing details'} tabIndex={-1} data-nurture-person={personId}>
        <div className="nu-top">
          <p className="nu-eyebrow">Nurturing client{p?.locationName ? ` · ${p.locationName}` : ''}</p>
          <button type="button" className="nu-close" onClick={onClose} aria-label="Close" title="Close" data-close><IconX /></button>
        </div>
        <div className="nu-mast">
          {problem && <p className="nu-quiet" role="alert" data-sheet-problem>We couldn&rsquo;t open this person ({problem}). Nothing has been changed.</p>}
          {!problem && !p && <p className="nu-quiet" data-sheet-loading>Opening…</p>}
          {p && (
            <div className="nu-identity">
              <div className="nu-avatar" aria-hidden="true">{initials(p.name)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2 data-person-name>{p.name}</h2>
                {(p.company || p.cityLine) && <p className="nu-sub">{[p.company, p.cityLine].filter(Boolean).join(' · ')}</p>}
                <div className="nu-pills">
                  {v?.nurturing ? <span className="nu-pill" data-tone="nurture" data-pill="nurturing">Nurturing</span>
                    : <span className="nu-pill" data-tone="quiet" data-pill="not-nurturing">No longer Nurturing: {WHY_NOT[v?.why] || 'changed'}</span>}
                  {p.needsContactInfo && <span className="nu-pill" data-tone="warn" data-pill="needs-contact">Needs contact info</span>}
                  {p.marketing?.state === 'unsubscribed' && <span className="nu-pill" data-tone="quiet" data-pill="unsubscribed">Unsubscribed{p.marketing.at ? ` ${dayLabel(p.marketing.at)}` : ''}</span>}
                  {p.marketing?.state === 'opted_out' && <span className="nu-pill" data-tone="quiet" data-pill="opted-out">No marketing emails</span>}
                </div>
              </div>
            </div>
          )}
        </div>

        {p && (
          <div className="nu-body">
            <section data-section="why">
              <h3>Why they&rsquo;re here</h3>
              <ul className="nu-why">
                <li><i />Added {dayLabel(p.createdAt)}, {daysAgo(p.createdAt, nowMs).toLocaleString()} days ago.</li>
                <li><i />{data.jobs.some((j) => j.counts) ? 'Has had a job.' : 'Never had a job.'}</li>
                <li data-why-last><i />{v?.lastActivity
                  ? `Last ${v.lastActivity.kind === 'quote' ? 'quote' : 'assessment'} ${dayLabel(v.lastActivity.at)}, ${daysAgo(v.lastActivity.at, nowMs).toLocaleString()} days ago. Nurturing starts ${quiet} days after the last assessment or quote.`
                  : 'No assessment or quote, ever.'}</li>
              </ul>
            </section>

            <section data-section="contact">
              <h3>Contact</h3>
              {p.needsContactInfo && <p className="nu-quiet" style={{ marginBottom: 10 }} data-needs-contact-line>No email and no phone on file, so nobody can reach them yet. Changing this comes in the next step of the build.</p>}
              <dl>
                <dt>Email</dt><dd>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : 'None'}</dd>
                <dt>Phone</dt><dd>{p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : 'None'}</dd>
                <dt>Address</dt><dd data-address>{p.address || 'None'}</dd>
                {p.preferredContact && <><dt>Prefers</dt><dd>{p.preferredContact}</dd></>}
              </dl>
            </section>

            <section data-section="asked">
              <h3>What they asked for</h3>
              <dl>
                <dt>Came from</dt><dd>{p.source || 'Not recorded'}</dd>
                <dt>Project</dt><dd>{p.projectType || 'Not recorded'}</dd>
                {p.requestDetails && <><dt>They said</dt><dd className="nu-note">{p.requestDetails}</dd></>}
              </dl>
            </section>

            <section data-section="history">
              <h3>History</h3>
              {!data.quotes.length && !data.assessments.length && !data.jobs.length && !data.requests.length && !data.engagements.length && <p className="nu-quiet">Nothing yet: no request, assessment, quote or job.</p>}
              <ul className="nu-list">
                {data.quotes.map((q) => <li key={`q${q.id}`} data-history="quote"><b>{q.counts ? 'Quote' : <s>Draft quote</s>}{money(q.total) ? ` · ${money(q.total)}` : ''}{q.status ? ` · ${q.status}` : ''}</b><span>{dayLabel(q.at)}</span></li>)}
                {data.assessments.map((a) => <li key={`a${a.id}`} data-history="assessment"><b>Assessment{a.status ? ` · ${a.status}` : ''}</b><span>{dayLabel(a.at)}</span></li>)}
                {data.jobs.map((j) => <li key={`j${j.id}`} data-history="job"><b>{j.counts ? 'Job' : <s>Deleted job</s>}{j.title ? ` · ${j.title}` : ''}</b><span>{dayLabel(j.at)}</span></li>)}
                {data.requests.map((r) => <li key={`r${r.id}`} data-history="request"><b>Request{r.status ? ` · ${r.status}` : ''}</b><span>{dayLabel(r.at)}</span></li>)}
                {data.engagements.map((e) => <li key={`e${e.id}`} data-history="engagement"><b>{e.stage}{e.closedReason ? ` · ${closedReasonLabel(e.closedReason)}` : ''}</b><span>{dayLabel(e.closedAt) || ''}</span></li>)}
              </ul>
              {(data.quotes.some((q) => !q.counts) || data.jobs.some((j) => !j.counts)) && <p className="nu-quiet" style={{ marginTop: 10 }}>Struck-through lines don&rsquo;t count: a draft quote was never sent, and a deleted job never happened.</p>}
            </section>

            <section data-section="tags">
              <h3>Tags</h3>
              {data.tags.length ? <div className="nu-chips">{data.tags.map((t) => <span key={t.id} className="nu-chip">{t.icon ? `${t.icon} ` : ''}{t.label}</span>)}</div> : <p className="nu-quiet">No tags.</p>}
            </section>

            <section data-section="touches">
              <h3>Latest touches</h3>
              {data.touchpoints.length ? (
                <ul className="nu-list">{data.touchpoints.map((t) => <li key={t.id}><b>{t.label || 'Touch'}{t.method ? ` · ${t.method}` : ''}</b><span>{dayLabel(t.at)}</span></li>)}</ul>
              ) : <p className="nu-quiet">No touches logged.</p>}
            </section>

            {p.notes && (
              <section data-section="notes">
                <h3>Notes</h3>
                <p className="nu-note">{p.notes}</p>
              </section>
            )}

            <p className="nu-readonly" data-read-only-note>Read only for now. Emailing, tagging and editing Nurturing clients come in the next step of the build.</p>
          </div>
        )}
      </aside>
    </div>
  )
}
