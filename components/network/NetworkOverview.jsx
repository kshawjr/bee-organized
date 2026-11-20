// components/network/NetworkOverview.jsx
// ─────────────────────────────────────────────────────────────
// THE CORPORATE OVERVIEW (Network & Nurture slice 9): how every location uses
// Network, one row each, from the design's Corporate.tsx on real data.
// READ-ONLY: it reads GET /api/network/overview and has nothing that writes.
//
// Shown on Network & Nurture when no single location is picked (All
// locations), to whoever the Network gate lets in: super admins now, corporate
// at the un-grey. It never shows for one location, and an owner never gets it
// (the route answers them 403): it holds every location's numbers.
//
// What Kevin wants from it (2026-11-20): which locations have not started,
// and who has a backlog of contacts nobody has typed yet ("Not sure yet").
// So those lead: the not-started list sits above the table, and the table is
// ordered by the backlog.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T, NET, FONT, FONT_STYLESHEET_HREF } from '@/components/design/tokens'

const CSS = `
[data-network-overview]{font-family:${FONT.ui};color:${T.foreground};background:${T.background};min-height:60vh}
[data-network-overview] *{box-sizing:border-box}
[data-network-overview] .no-wrap{width:100%;max-width:1152px;margin:0 auto;padding:24px 32px 40px}
[data-network-overview] .no-eyebrow{font-size:11.2px;font-weight:700;text-transform:uppercase;color:${T.mutedFg};margin:0}
[data-network-overview] h1{font-family:${FONT.heading};font-size:30px;font-weight:300;line-height:1.2;color:${T.primary};margin:6px 0 0}
[data-network-overview] .no-lede{font-family:${FONT.body};font-size:14px;line-height:1.6;color:${T.mutedFg};margin:6px 0 0}
[data-network-overview] .no-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}
[data-network-overview] .no-tile{background:${T.card};border:1px solid ${T.border};border-radius:12px;padding:12px 14px}
[data-network-overview] .no-tile b{display:block;font-family:${FONT.heading};font-size:22px;color:${T.primary};font-variant-numeric:tabular-nums}
[data-network-overview] .no-tile span{font-size:12.5px;color:${T.mutedFg}}
[data-network-overview] .no-notstarted{margin-top:14px;padding:12px 14px;border-radius:12px;border:1px solid ${NET.warn};background:${NET.warnSoft};font-size:13.5px;line-height:1.5}
[data-network-overview] .no-notstarted b{font-weight:700}
[data-network-overview] table{width:100%;margin-top:16px;border-collapse:collapse;background:${T.card};border:1px solid ${T.border};border-radius:12px;overflow:hidden;font-size:13.5px}
[data-network-overview] th{padding:10px 12px;text-align:right;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${T.mutedFg};border-bottom:1px solid ${T.border};white-space:nowrap}
[data-network-overview] th:first-child,[data-network-overview] td:first-child{text-align:left}
[data-network-overview] td{padding:10px 12px;text-align:right;border-bottom:1px solid ${T.border};font-variant-numeric:tabular-nums}
[data-network-overview] tr:last-child td{border-bottom:0}
[data-network-overview] td b{font-family:${FONT.heading};font-weight:700;color:${T.primary}}
[data-network-overview] .no-warn{color:${NET.warn};font-weight:700}
[data-network-overview] .no-quiet{color:${T.mutedFg}}
[data-network-overview] .no-note{margin-top:10px;font-size:12.5px;color:${T.mutedFg}}
[data-network-overview] .no-problem{margin-top:20px;padding:14px;border:1px solid ${NET.warn};border-radius:10px;background:${NET.warnSoft};font-size:14px}
@media (max-width:767px){
  [data-network-overview] .no-wrap{padding:16px 16px 40px}
  [data-network-overview] h1{font-size:26px}
  [data-network-overview] .no-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
  [data-network-overview] table,[data-network-overview] tbody{display:block;border:0;background:none}
  [data-network-overview] thead{display:none}
  [data-network-overview] tr{display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:10px;padding:12px;background:${T.card};border:1px solid ${T.border};border-radius:12px}
  [data-network-overview] td{padding:0;border:0;text-align:left;display:flex;justify-content:space-between;gap:8px}
  [data-network-overview] td:first-child{grid-column:1 / -1;margin-bottom:4px}
  [data-network-overview] td[data-label]::before{content:attr(data-label);color:${T.mutedFg};font-size:12px}
}
`

const n = (x) => Number(x || 0).toLocaleString('en-US')
const money = (x) => `$${Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export default function NetworkOverview({ fetchImpl = null }) {
  const [data, setData] = useState(null)
  const [problem, setProblem] = useState(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const res = await (fetchImpl || fetch)('/api/network/overview')
        const json = await res.json().catch(() => ({}))
        if (!live) return
        if (!res.ok) { setProblem(json?.error || `error ${res.status}`); return }
        setData(json)
      } catch { if (live) setProblem('no connection') }
    })()
    return () => { live = false }
  }, [fetchImpl])

  const t = data?.totals
  return (
    <div data-network-overview>
      <link rel="stylesheet" href={FONT_STYLESHEET_HREF} />
      <style>{CSS}</style>
      <div className="no-wrap">
        <p className="no-eyebrow">Network · All locations</p>
        <h1>How every location uses Network</h1>
        <p className="no-lede">Read only. Pick one location from the location menu to see its people.</p>
        {problem && <div className="no-problem" role="alert" data-problem>We couldn&rsquo;t load the overview ({problem}). Nothing has been changed.</div>}
        {!problem && !data && <p className="no-lede" data-loading>Loading every location…</p>}
        {data && (
          <>
            <div className="no-tiles" data-tiles>
              <div className="no-tile" data-tile="started"><b>{n(t.started)} of {n(t.locations)}</b><span>locations have started</span></div>
              <div className="no-tile" data-tile="contacts"><b>{n(t.contacts)}</b><span>contacts · {n(t.partners)} Referral partners</span></div>
              <div className="no-tile" data-tile="not-sure"><b>{n(t.notSure)}</b><span>not typed yet (Not sure yet)</span></div>
              <div className="no-tile" data-tile="referred"><b>{n(t.referred)}</b><span>leads referred · {n(t.won)} won · {money(t.revenue)}</span></div>
            </div>
            {data.notStarted.length > 0 && (
              <p className="no-notstarted" data-not-started><b>Not started ({n(data.notStarted.length)}):</b> {data.notStarted.join(', ')}.</p>
            )}
            <table data-overview-table>
              <thead><tr><th>Location</th><th>Contacts</th><th>Not sure yet</th><th>Referral partners</th><th>Gone quiet</th><th>Leads referred</th><th>Won</th><th>Revenue</th></tr></thead>
              <tbody>
                {data.rows.filter((r) => r.started).map((r) => (
                  <tr key={r.id} data-row={r.id}>
                    <td><b>{r.name}</b></td>
                    <td data-label="Contacts">{n(r.contacts)}</td>
                    <td data-label="Not sure yet" className={r.notSure > 5 ? 'no-warn' : undefined}>{n(r.notSure)}</td>
                    <td data-label="Referral partners">{n(r.partners)}</td>
                    <td data-label="Gone quiet" className={r.goneQuiet > 5 ? 'no-warn' : r.goneQuiet ? undefined : 'no-quiet'}>{n(r.goneQuiet)}</td>
                    <td data-label="Leads referred">{n(r.referred)}</td>
                    <td data-label="Won">{n(r.won)}</td>
                    <td data-label="Revenue">{r.revenue ? money(r.revenue) : <span className="no-quiet">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="no-note">Ordered by how many contacts are still not typed. Test Location and the transfer queue are left out.</p>
          </>
        )}
      </div>
    </div>
  )
}
