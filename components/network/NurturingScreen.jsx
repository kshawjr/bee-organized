// components/network/NurturingScreen.jsx
// ─────────────────────────────────────────────────────────────
// THE NURTURING TAB (Network & Nurture redesign, slice 7 of 9).
//
// BEHIND THE GREY. Only a viewer lib/network/access.ts says yes to ever
// mounts this (super admins, for now); the route it reads answers 403 to
// everyone else. Kevin: nothing un-greys until all nine slices are done.
//
// READ-ONLY. It reads two addresses and writes nothing:
//   /api/network/nurturing          one page of the list, and the counts
//   /api/network/nurturing/<id>     one person (NurtureSheet.jsx)
// There is no tick box, no bulk bar and no edit here. Every action is
// slice 8, which waits on Kevin's consent decision.
//
// WHO IS LISTED is Kevin's rule, in lib/network/nurturing.ts, worked out on
// the server. This screen never decides it.
//
// BUILT FOR 18,826. Philadelphia Suburbs holds nearly half of everyone
// Nurturing. The server pages the list (the design's bounded pages); the
// browser only ever holds one page. Search waits for a pause in typing
// before it asks.
//
// The two lightweight menus here (Filters, Sort) close on a click outside,
// on Escape, on a choice and on their own button (Kevin, 2026-11-19, via
// components/ui/useClickAway.js). The person view is a window and does not.
//
// Nurturing people also still show in the Nurturing band on the Clients
// screen. That is expected: slice 9 removes the band. This file does not
// touch it.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useRef, useState } from 'react'
import { useClickAway, insideRefs } from '@/components/ui/useClickAway'
import { T, NET, FONT, FONT_STYLESHEET_HREF } from '@/components/design/tokens'
import { PAGE_SIZES, defaultPageSize, pageCount } from '@/lib/network/paging'
import NurtureSheet, { dayLabel, initials } from './NurtureSheet'

// The same four sorts the server knows (lib/network/nurturing.ts NURTURE_SORTS).
const SORTS = [
  { value: 'az', label: 'A–Z' },
  { value: 'newest', label: 'Recently added' },
  { value: 'oldest', label: 'Added longest ago' },
  { value: 'quoted', label: 'Most recent quote or assessment' },
]

const CSS = `
[data-nurture-ui]{font-family:${FONT.ui};color:${T.foreground};background:${T.background};min-height:100vh;-webkit-tap-highlight-color:transparent}
[data-nurture-ui] *{box-sizing:border-box}
[data-nurture-ui] button{font-family:inherit;cursor:pointer;border:0;background:none;color:inherit;font-size:inherit;text-align:inherit;padding:0}
[data-nurture-ui] button:disabled{cursor:not-allowed;opacity:.4}
[data-nurture-ui] :is(button,input,select):focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
[data-nurture-ui] .nn-wrap{width:100%;max-width:1152px;margin:0 auto;padding:24px 32px 40px}
[data-nurture-ui] .nn-eyebrow{font-size:11.2px!important;font-weight:700;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-nurture-ui] .nn-title{font-family:${FONT.heading};font-size:30px;font-weight:300;line-height:1.2;color:${T.primary};margin:6px 0 0}
[data-nurture-ui] .nn-lede{font-family:${FONT.body};font-size:14px;line-height:1.6;color:${T.mutedFg};margin:6px 0 0}
[data-nurture-ui] .nn-preview{display:inline-flex;align-items:center;gap:6px;margin-top:12px;padding:5px 10px;border:1px dashed ${T.input};border-radius:999px;font-size:12px!important;color:${T.mutedFg};background:${T.card}}
[data-nurture-ui] .nn-band{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
[data-nurture-ui] .nn-stat{display:inline-flex;align-items:baseline;gap:6px;min-height:40px;padding:8px 14px;border-radius:12px;border:1px solid ${T.border};background:${T.card};font-size:13px;color:${T.mutedFg}}
[data-nurture-ui] .nn-stat b{font-family:${FONT.heading};font-size:17px;color:${T.primary};font-variant-numeric:tabular-nums}
[data-nurture-ui] .nn-stat[data-tone="nurture"]{background:${NET.nurtureSoft};border-color:color-mix(in oklab,${NET.nurture} 40%,transparent)}
[data-nurture-ui] button.nn-stat:hover{border-color:${T.primary}}
[data-nurture-ui] button.nn-stat[aria-pressed="true"]{border-color:${T.primary};background:color-mix(in oklab,${T.primary} 8%,${T.card})}
[data-nurture-ui] .nn-toolbar{display:flex;align-items:center;gap:8px;margin-top:16px;padding-bottom:12px;border-bottom:1px solid ${T.border}}
[data-nurture-ui] .nn-search{flex:1;min-width:0}
[data-nurture-ui] .nn-input{height:44px;width:100%;border-radius:8px;border:1px solid ${T.input};background:${T.card};padding:0 12px;font-size:14px!important;font-family:inherit;color:${T.foreground};outline:none}
[data-nurture-ui] .nn-input:focus{border-color:${T.primary}}
[data-nurture-ui] .nn-anchor{position:relative;display:flex}
[data-nurture-ui] .nn-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 14px;border:1px solid ${T.input};border-radius:8px;background:${T.card};color:${T.primary};font-size:14px!important;font-weight:700;white-space:nowrap}
[data-nurture-ui] .nn-trigger:hover{border-color:${T.primary}}
[data-nurture-ui] .nn-trigger[data-active]{border-color:${T.primary};background:color-mix(in oklab,${T.primary} 8%,${T.card})}
[data-nurture-ui] .nn-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:${T.primary};color:${T.primaryFg};font-size:11px}
[data-nurture-ui] .nn-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:60;width:min(300px,calc(100vw - 32px));background:${T.card};border:1px solid ${T.border};border-radius:14px;overflow:hidden;padding:6px 0;box-shadow:0 1px 2px rgba(42,48,43,.06),0 8px 24px -12px rgba(42,48,43,.14),0 18px 40px -18px color-mix(in oklab,${T.primary} 40%,transparent);animation:nn-in .15s ease-out}
@keyframes nn-in{from{opacity:0;transform:translateY(-4px)}}
[data-nurture-ui] .nn-menu-title{padding:8px 14px 4px;font-size:11px!important;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-nurture-ui] .nn-option{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:6px 14px;font-size:14px!important;color:${T.primary}}
[data-nurture-ui] .nn-option:hover,[data-nurture-ui] .nn-option:focus-visible{background:${T.muted};outline:none}
[data-nurture-ui] .nn-mark{display:grid;place-items:center;width:18px;height:18px;flex-shrink:0;border:1.5px solid ${T.input};border-radius:5px;color:${T.primaryFg}}
[data-nurture-ui] .nn-option[aria-checked="true"] .nn-mark{background:${T.primary};border-color:${T.primary}}
[data-nurture-ui] .nn-mark[data-radio]{border-radius:999px}
[data-nurture-ui] .nn-option small{margin-left:auto;font-size:12px;color:${T.mutedFg};font-variant-numeric:tabular-nums}
[data-nurture-ui] .nn-list{margin-top:12px;background:${T.card};border:1px solid ${T.border};border-radius:14px;overflow:hidden}
[data-nurture-ui] .nn-row{display:flex;align-items:center;gap:14px;width:100%;padding:12px 16px;border-bottom:1px solid ${T.border};min-width:0}
[data-nurture-ui] .nn-row:hover{background:color-mix(in oklab,${T.muted} 60%,${T.card})}
[data-nurture-ui] .nn-row[data-even]{background:color-mix(in oklab,${NET.nurtureSoft} 30%,${T.card})}
[data-nurture-ui] .nn-row[data-even]:hover{background:color-mix(in oklab,${T.muted} 60%,${T.card})}
[data-nurture-ui] .nn-avatar{display:flex;flex-shrink:0;align-items:center;justify-content:center;width:40px;height:40px;border-radius:999px;background:${NET.nurtureSoft};color:${T.primary};font-size:12px;font-weight:700}
[data-nurture-ui] .nn-main{min-width:0;flex:1}
[data-nurture-ui] .nn-line{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
[data-nurture-ui] .nn-name{font-family:${FONT.heading};font-size:15px;font-weight:700;color:${T.primary};overflow-wrap:anywhere}
[data-nurture-ui] .nn-flag{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11.5px;font-weight:700;border:1px solid ${NET.warn};background:${NET.warnSoft};color:${T.foreground};white-space:nowrap}
[data-nurture-ui] .nn-sub{margin-top:3px;font-size:12.5px;line-height:1.5;color:${T.mutedFg};overflow-wrap:anywhere}
[data-nurture-ui] .nn-side{flex-shrink:0;width:200px;text-align:right;font-size:12px;color:${T.mutedFg};line-height:1.5}
[data-nurture-ui] .nn-side b{color:${T.primary};font-weight:700}
[data-nurture-ui] .nn-chev{flex-shrink:0;color:${T.mutedFg}}
[data-nurture-ui] .nn-pager{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;margin-top:12px;border:1px solid ${T.border};border-radius:12px;background:${T.card}}
[data-nurture-ui] .nn-pager-summary{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:12.5px;color:${T.mutedFg}}
[data-nurture-ui] .nn-pager select{min-height:44px;min-width:66px;border:1px solid ${T.input};border-radius:6px;background:${T.card};color:${T.primary};padding:0 8px;font-family:inherit;font-size:13px!important;margin-left:6px}
[data-nurture-ui] .nn-pager-nav{display:flex;align-items:center;gap:2px}
[data-nurture-ui] .nn-pager-nav button{display:inline-grid;place-items:center;min-width:40px;min-height:44px;padding:0 6px;border-radius:10px;color:${T.mutedFg}}
[data-nurture-ui] .nn-pager-nav button:hover:not(:disabled){background:${T.muted};color:${T.primary}}
[data-nurture-ui] .nn-pos{min-width:104px;text-align:center;font-size:12.5px;font-variant-numeric:tabular-nums;color:${T.primary}}
[data-nurture-ui] .nn-empty{padding:32px 16px;text-align:center;font-size:14px;color:${T.mutedFg};margin:0}
[data-nurture-ui] .nn-empty button{margin-left:6px;font-weight:700;color:${T.primary};text-decoration:underline}
[data-nurture-ui] .nn-problem{margin-top:20px;padding:16px;border:1px solid ${NET.warn};border-radius:10px;background:${NET.warnSoft};font-size:14px}
[data-nurture-ui] .nn-busy{opacity:.55;transition:opacity .15s}
[data-nurture-ui] .nn-mobile-only{display:none}
@media (max-width:767px){
  [data-nurture-ui] .nn-wrap{padding:16px 16px 40px}
  [data-nurture-ui] .nn-title{font-size:26px}
  [data-nurture-ui] .nn-toolbar{flex-wrap:wrap}
  [data-nurture-ui] .nn-search{flex:1 1 100%}
  [data-nurture-ui] .nn-toolbar .nn-anchor{flex:1 1 0}
  [data-nurture-ui] .nn-toolbar .nn-trigger{flex:1}
  [data-nurture-ui] .nn-anchor[data-menu-side="left"] .nn-menu{left:0;right:auto}
  [data-nurture-ui] .nn-side{display:none}
  [data-nurture-ui] .nn-mobile-only{display:inline}
  [data-nurture-ui] .nn-row{gap:12px;align-items:flex-start}
  [data-nurture-ui] .nn-pager{justify-content:center}
  [data-nurture-ui] .nn-stat{flex:1 1 auto}
}
@media (prefers-reduced-motion:reduce){[data-nurture-ui] *{animation:none!important;transition:none!important}}
`

const IconCheck = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
const IconChevron = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
const Arrow = ({ d }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>

const n = (x) => Number(x || 0).toLocaleString('en-US')

/** A light menu: closes on a choice, its button, Escape, or a click outside. */
function Menu({ trigger, children, side = 'right' }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef(null)
  useClickAway(open, () => setOpen(false), insideRefs(anchor))
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div className="nn-anchor" ref={anchor} data-menu-side={side}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className="nn-menu" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

function rowSide(r) {
  if (r.lastActivity) return <><b>{r.lastActivity.kind === 'quote' ? 'Last quote' : 'Last assessment'}</b> {dayLabel(r.lastActivity.at)}</>
  return <>No assessment or quote</>
}

/**
 * props:
 *   locationId    a locations.id uuid, or null on All Locations
 *   locationName  for the title
 *   fetchImpl     tests hand in a fake fetch
 *   isMobile      picks the starting page size (10 on a phone, 25 otherwise)
 */
export default function NurturingScreen({ locationId, locationName = null, fetchImpl = null, isMobile = false, nowMs = undefined }) {
  const [q, setQ] = useState('')
  const [askedQ, setAskedQ] = useState('')
  const [needsOnly, setNeedsOnly] = useState(false)
  const [sort, setSort] = useState('az')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(defaultPageSize(isMobile))
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const [openId, setOpenId] = useState(null)
  const top = useRef(null)
  const asked = useRef(0)

  // Search asks after a pause in typing, not on every key.
  useEffect(() => {
    const t = setTimeout(() => { setAskedQ(q.trim()); setPage(0) }, 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    if (!locationId) return undefined
    const mine = ++asked.current
    setBusy(true); setProblem(null)
    const params = new URLSearchParams({ location_id: locationId, page: String(page), size: String(size), sort })
    if (askedQ) params.set('q', askedQ)
    if (needsOnly) params.set('needs_contact', '1')
    ;(async () => {
      try {
        const res = await (fetchImpl || fetch)(`/api/network/nurturing?${params}`)
        const json = await res.json().catch(() => ({}))
        if (mine !== asked.current) return // an older answer arriving late is dropped
        if (!res.ok) { setProblem(json?.error || `error ${res.status}`); return }
        setData(json)
        if (json.page !== page) setPage(json.page)
      } catch { if (mine === asked.current) setProblem('no connection') }
      finally { if (mine === asked.current) setBusy(false) }
    })()
    return undefined
  }, [locationId, page, size, sort, askedQ, needsOnly, fetchImpl])

  useEffect(() => { setData(null); setPage(0); setOpenId(null) }, [locationId])

  const goPage = (p) => { setPage(p); top.current?.scrollIntoView?.({ block: 'start' }) }
  const total = data?.total ?? 0
  const pages = pageCount(total, size)
  const current = data?.page ?? 0
  const counts = data?.counts
  const filterCount = needsOnly ? 1 : 0

  return (
    <div data-nurture-ui>
      <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
      <style>{CSS}</style>
      <div className="nn-wrap">
        <p className="nn-eyebrow">Network &amp; Nurture</p>
        <h1 className="nn-title">Nurturing{locationId && locationName ? ` · ${locationName}` : ''}</h1>
        {/* The days come from the server, which reads the rule's one setting (lib/network/nurturing.ts). Never a number typed here. */}
        <p className="nn-lede" data-lede>Clients who showed interest but never started a job{data ? <>, and haven&rsquo;t had an assessment or quote in {data.quietDays} days</> : null}.</p>
        <span className="nn-preview" data-preview-note>Preview, read only. Only super admins can see this; owners still see Network closed.</span>

        {!locationId && <p className="nn-empty" data-pick-location style={{ marginTop: 20, border: `1px dashed ${T.border}`, borderRadius: 14 }}>Pick one location to see its Nurturing clients. A client belongs to one location, so this list is never built across all of them at once.</p>}

        {locationId && problem && <div className="nn-problem" role="alert" data-problem>We couldn&rsquo;t load the Nurturing list ({problem}). Nothing has been changed. Reload the page to try again.</div>}
        {locationId && !problem && !data && <p className="nn-empty" data-loading>Loading Nurturing clients…</p>}

        {locationId && data && (
          <>
            <div className="nn-band" data-band>
              <span className="nn-stat" data-tone="nurture" data-stat="nurturing"><b>{n(counts.nurturing)}</b> nurturing</span>
              <span className="nn-stat" data-stat="quoted"><b>{n(counts.hadQuoteOrAssessment)}</b> had a quote or assessment</span>
              <button type="button" className="nn-stat" aria-pressed={needsOnly} onClick={() => { setNeedsOnly((v) => !v); setPage(0) }} data-stat="needs-contact"
                title={needsOnly ? 'Show everyone' : 'Show only people with no email and no phone'}>
                <b>{n(counts.needsContactInfo)}</b> need{counts.needsContactInfo === 1 ? 's' : ''} contact info
              </button>
            </div>

            <div className="nn-toolbar" ref={top}>
              <div className="nn-search">
                <input className="nn-input" type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name, email, phone, town or zip…" aria-label="Search nurturing" data-search />
              </div>
              {/* On a phone Filters sits in the left half, so its menu opens from its own left edge (found in the 390px picture: it ran off the screen). */}
              <Menu side="left" trigger={(open, toggle) => (
                <button type="button" className="nn-trigger" aria-expanded={open} aria-haspopup="menu" onClick={toggle} data-active={filterCount > 0 || undefined}
                  aria-label={filterCount ? `Filters, ${filterCount} on` : 'Filters'} data-filters-trigger>
                  Filters{filterCount > 0 && <span className="nn-count">{filterCount}</span>}
                </button>
              )}>{(close) => (<>
                <p className="nn-menu-title">Contact info</p>
                <button type="button" role="menuitemcheckbox" aria-checked={needsOnly} className="nn-option" data-filter="needs-contact"
                  onClick={() => { setNeedsOnly((v) => !v); setPage(0); close() }}>
                  <span className="nn-mark">{needsOnly && <IconCheck />}</span>Needs contact info<small>{n(counts.needsContactInfo)}</small>
                </button>
              </>)}</Menu>
              <Menu trigger={(open, toggle) => (
                <button type="button" className="nn-trigger" aria-expanded={open} aria-haspopup="menu" onClick={toggle} data-sort-trigger aria-label={`Sort: ${SORTS.find((s) => s.value === sort)?.label}`}>
                  Sort
                </button>
              )}>{(close) => (<>
                <p className="nn-menu-title">Sort by</p>
                {SORTS.map((s) => (
                  <button key={s.value} type="button" role="menuitemradio" aria-checked={sort === s.value} className="nn-option" data-sort={s.value}
                    onClick={() => { setSort(s.value); setPage(0); close() }}>
                    <span className="nn-mark" data-radio>{sort === s.value && <IconCheck />}</span>{s.label}
                  </button>
                ))}
              </>)}</Menu>
            </div>

            <Pager total={total} page={current} size={size} pages={pages} onPage={goPage} onSize={(s) => { setSize(s); setPage(0) }} needsOnly={needsOnly} q={askedQ} />

            <div className={`nn-list${busy ? ' nn-busy' : ''}`} aria-busy={busy || undefined} data-list>
              {data.rows.map((r, i) => (
                <button key={r.id} type="button" className="nn-row" data-even={i % 2 === 1 || undefined} onClick={() => setOpenId(r.id)}
                  aria-label={`Open ${r.name}`} aria-haspopup="dialog" data-row={r.id}>
                  <span className="nn-avatar" aria-hidden="true">{initials(r.name)}</span>
                  <span className="nn-main">
                    <span className="nn-line"><span className="nn-name">{r.name}</span>{r.needsContactInfo && <span className="nn-flag" data-flag="needs-contact">Needs contact info</span>}</span>
                    <span className="nn-sub" style={{ display: 'block' }}>{[r.email, r.phone, [r.city, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || 'No email, phone or address'}</span>
                    <span className="nn-sub" style={{ display: 'block' }}>Added {dayLabel(r.createdAt)}<span className="nn-mobile-only">{' · '}{rowSide(r)}</span></span>
                  </span>
                  <span className="nn-side">{rowSide(r)}</span>
                  <span className="nn-chev"><IconChevron /></span>
                </button>
              ))}
              {!data.rows.length && (
                <p className="nn-empty" data-empty>
                  {askedQ ? <>Nobody here matches &ldquo;{askedQ}&rdquo;{needsOnly ? ' among people who need contact info' : ''}.<button type="button" onClick={() => setQ('')} data-clear-search>Clear search</button></>
                    : data.excluded ? <>{locationName || 'This location'} is left out of Nurturing: it is Bee Hub&rsquo;s test location or the transfer queue.</>
                    : needsOnly ? <>Everyone here has an email or a phone.<button type="button" onClick={() => setNeedsOnly(false)} data-clear-filter>Show everyone</button></>
                      : <>Nobody at {locationName || 'this location'} is Nurturing right now.</>}
                </p>
              )}
            </div>

            {total > size && <Pager total={total} page={current} size={size} pages={pages} onPage={goPage} />}
          </>
        )}
      </div>
      {openId && <NurtureSheet personId={openId} onClose={() => setOpenId(null)} fetchImpl={fetchImpl} nowMs={nowMs} />}
    </div>
  )
}

function Pager({ total, page, size, pages, onPage, onSize = null, needsOnly = false, q = '' }) {
  const who = needsOnly ? 'needing contact info' : q ? 'matching' : 'nurturing'
  const summary = total <= size
    ? `${n(total)} ${total === 1 ? 'person' : 'people'} ${who}`
    : page * size + 1 === total ? `${n(total)} of ${n(total)} ${who}` // a last page holding one person
      : `${n(page * size + 1)}–${n(Math.min((page + 1) * size, total))} of ${n(total)} ${who}`
  return (
    <nav className="nn-pager" aria-label="Nurturing pages" data-pager>
      <div className="nn-pager-summary">
        <span role="status" data-pager-summary>{summary}</span>
        {onSize && total > PAGE_SIZES[0] && (
          <label>Per page
            <select aria-label="People per page" value={size} onChange={(e) => onSize(Number(e.target.value))} data-page-size>
              {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
      </div>
      {pages > 1 && (
        <div className="nn-pager-nav">
          <button type="button" aria-label="First page" disabled={page === 0} onClick={() => onPage(0)} data-page="first"><Arrow d="m11 17-5-5 5-5M18 17l-5-5 5-5" /></button>
          <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} data-page="prev"><Arrow d="m15 18-6-6 6-6" /></button>
          <span className="nn-pos" aria-live="polite" data-page-pos>Page {n(page + 1)} of {n(pages)}</span>
          <button type="button" aria-label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} data-page="next"><Arrow d="m9 18 6-6-6-6" /></button>
          <button type="button" aria-label="Last page" disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} data-page="last"><Arrow d="m13 17 5-5-5-5M6 17l5-5-5-5" /></button>
        </div>
      )}
    </nav>
  )
}
