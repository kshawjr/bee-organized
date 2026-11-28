// components/network/NetworkTabs.jsx
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 7: the two tabs, as in Kevin's design
// ("Network & Partners" and "Nurturing Clients"). The Network tab is the
// slice 3–6 list, unchanged and handed exactly the props it had. The
// Nurturing tab is NurturingScreen.jsx (read-only).
//
// 2026-11-25, Kevin's Lovable design (kshawjr/brief-and-current, routes/
// index.tsx), look and placement only:
//   · COUNTS ON THE TABS: "Network & Partners (100)", "Nurturing Clients
//     (5,037)". Counted on the server (/api/network/counts), never the
//     length of rows a screen loaded: a Supabase read stops at 1,000 rows.
//     No number is shown until the count answers, or if it fails; never a
//     made-up zero.
//   · ADD and the round THREE DOTS (Export) sit at the top right of this
//     bar, ON THE NETWORK TAB ONLY. They are the Network list's own buttons,
//     menus and boxes (NetworkListScreen.jsx), drawn into the spot below.
//
// ADD ON NURTURING IS BACK (FL-135, Kevin 2026-11-28; it was taken off on
// 2026-11-25). An owner can now put someone in Nurturing by hand, straight
// away (NurtureAddDialog.jsx). It sits in the same top-right spot, on the
// Nurturing tab, inside one location only. The three dots stay Network-only,
// and the Network list is still not mounted while Nurturing is showing.
//
// Mounted by components/BeeHub.jsx only where the new Network list was
// already mounted: for a viewer lib/network/access.ts says yes to (super
// admins). Owners, managers, read-only users and corporate still see
// Network greyed and closed; this file never runs for them.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useRef, useState } from 'react'
import { T, NET, FONT } from '@/components/design/tokens'
import NetworkListScreen from './NetworkListScreen'
import NurturingScreen from './NurturingScreen'
import NetworkOverview from './NetworkOverview'
import NurtureAddDialog from './NurtureAddDialog'

const CSS = `
[data-network-tabs]{background:${T.background};font-family:${FONT.ui}}
[data-network-tabs] .nt-bar{width:100%;max-width:1152px;margin:0 auto;padding:20px 32px 0;display:flex;align-items:center;justify-content:space-between;gap:12px}
[data-network-tabs] .nt-tabs{display:inline-flex;gap:4px;padding:4px;border:1px solid ${T.border};border-radius:999px;background:${T.card};min-width:0}
[data-network-tabs] .nt-tab{min-height:40px;padding:0 16px;border:0;border-radius:999px;background:none;font-family:inherit;font-size:14px;font-weight:700;color:${T.primary};cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:4px}
[data-network-tabs] .nt-count{font-size:11px;font-weight:700;opacity:.75;font-variant-numeric:tabular-nums}
[data-network-tabs] .nt-tab:hover{background:${T.muted}}
[data-network-tabs] .nt-tab[aria-selected="true"]{background:${T.primary};color:${T.primaryFg}}
[data-network-tabs] .nt-tab:focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
[data-network-tabs] .nt-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
[data-network-tabs] .nt-actions:empty{display:none}
[data-network-tabs] .nt-add{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border:0;border-radius:10px;background:${T.primary};color:${T.primaryFg};font-family:inherit;font-size:14px!important;font-weight:700;white-space:nowrap;cursor:pointer}
[data-network-tabs] .nt-add:hover{background:color-mix(in oklab,${T.primary} 88%,${T.card})}
[data-network-tabs] .nt-add:focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
@media (max-width:767px){ [data-network-tabs] .nt-bar{padding:12px 16px 0;gap:8px} [data-network-tabs] .nt-tabs{display:flex;flex:1 1 auto;max-width:100%} [data-network-tabs] .nt-tab{flex:1 1 0;min-width:0;padding:4px 8px;font-size:13px;line-height:1.2;white-space:normal;flex-direction:column;gap:1px} }
/* Three tabs on a phone (All locations, slice 9) must never push the page sideways: they shrink and wrap their words. */
`

const mobileNow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches

/** "(5,037)", or nothing until the server has counted. */
const countWords = (n) => (typeof n === 'number' ? `(${n.toLocaleString('en-US')})` : '')

export default function NetworkTabs({ locationId, locationName, fetchImpl = null, onOpenClient = null, startOnNurturing = false, onStartConsumed = () => {}, ...networkProps }) {
  // Clients' "Open Nurturing clients" lands here on the Nurturing tab (slice 9).
  // On All locations (no single location picked) an "All locations" tab sits
  // beside the list (slice 9). The list stays where Network opens, as it always
  // has; picking a location takes the overview tab away, since it is about
  // every location.
  const [tab, setTab] = useState(startOnNurturing ? 'nurture' : 'network')
  useEffect(() => { if (startOnNurturing) { setTab('nurture'); onStartConsumed() } }, [startOnNurturing]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (locationId && tab === 'overview') setTab('network') }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The spot at the top right where the list draws Add and the three dots.
  const [actionsSpot, setActionsSpot] = useState(null)

  // The two tab counts, from the server. A failed read shows no numbers.
  const [counts, setCounts] = useState(null) // { network, nurturing } | null
  const [countsKey, setCountsKey] = useState(0)
  // Right after a Nurturing Add the count is asked for afresh (fresh=1): the
  // server keeps each count for a minute, and the Add ran on another server.
  const freshCounts = useRef(false)
  const { refreshKey = 0 } = networkProps
  useEffect(() => {
    let alive = true
    setCounts(null)
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
    if (!doFetch) return undefined
    const fresh = freshCounts.current; freshCounts.current = false
    const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}${fresh ? '&fresh=1' : ''}` : ''
    Promise.resolve(doFetch(`/api/network/counts${qs}`))
      .then(async (res) => {
        const json = res && res.ok ? await res.json().catch(() => null) : null
        if (alive) setCounts(json && typeof json.network === 'number' ? { network: json.network, nurturing: typeof json.nurturing === 'number' ? json.nurturing : null } : null)
      })
      .catch(() => { if (alive) setCounts(null) })
    return () => { alive = false }
  }, [locationId, fetchImpl, refreshKey, countsKey])

  // Something was added or imported: count again.
  const onContactsChanged = () => { setCountsKey((n) => n + 1) }
  // FL-135: the Nurturing Add, and the list read again after one.
  const [adding, setAdding] = useState(false)
  const [nurtureReload, setNurtureReload] = useState(0)

  // The Network list, and its Add and three dots, live on the Network tab only.
  const listShown = tab === 'network' || (tab === 'overview' && !!locationId)
  return (
    <div data-network-tabs>
      <style>{CSS}</style>
      <div className="nt-bar">
        <div className="nt-tabs" role="tablist" aria-label="Network and Nurturing">
          <button type="button" role="tab" className="nt-tab" aria-selected={tab === 'network'} onClick={() => setTab('network')} data-tab="network">
            <span>Network &amp; Partners</span>{counts && <span className="nt-count" data-tab-count="network">{countWords(counts.network)}</span>}
          </button>
          <button type="button" role="tab" className="nt-tab" aria-selected={tab === 'nurture'} onClick={() => setTab('nurture')} data-tab="nurture">
            <span>Nurturing Clients</span>{counts && counts.nurturing !== null && <span className="nt-count" data-tab-count="nurture">{countWords(counts.nurturing)}</span>}
          </button>
          {!locationId && <button type="button" role="tab" className="nt-tab" aria-selected={tab === 'overview'} onClick={() => setTab('overview')} data-tab="overview">All locations</button>}
        </div>
        {listShown && <div className="nt-actions" ref={setActionsSpot} data-network-tab-actions />}
        {tab === 'nurture' && locationId && (
          <div className="nt-actions" data-nurture-tab-actions>
            <button type="button" className="nt-add" onClick={() => setAdding(true)} data-act="nurture-add">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Add
            </button>
          </div>
        )}
      </div>
      {tab === 'overview' && !locationId && <NetworkOverview fetchImpl={fetchImpl} />}
      {listShown && (
        <NetworkListScreen locationId={locationId} locationName={locationName} {...(fetchImpl ? { fetchImpl } : {})} {...networkProps}
          actionsTarget={actionsSpot} onContactsChanged={onContactsChanged} />
      )}
      {tab === 'nurture' && <NurturingScreen key={nurtureReload} freshFirst={nurtureReload > 0} locationId={locationId} locationName={locationName} fetchImpl={fetchImpl} isMobile={mobileNow()} onOpenClient={onOpenClient} />}
      {adding && tab === 'nurture' && locationId && (
        <NurtureAddDialog locationId={locationId} locationName={locationName} fetchImpl={fetchImpl}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); freshCounts.current = true; setNurtureReload((n) => n + 1); setCountsKey((n) => n + 1) }} />
      )}
    </div>
  )
}
