// components/network/NetworkTabs.jsx
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 7: the two tabs, as in Kevin's design
// ("Network & Partners" and "Nurturing clients"). The Network tab is the
// slice 3–6 list, unchanged and handed exactly the props it had. The
// Nurturing tab is NurturingScreen.jsx (read-only).
//
// Mounted by components/BeeHub.jsx only where the new Network list was
// already mounted: for a viewer lib/network/access.ts says yes to (super
// admins). Owners, managers, read-only users and corporate still see
// Network greyed and closed; this file never runs for them.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T, NET, FONT } from '@/components/design/tokens'
import NetworkListScreen from './NetworkListScreen'
import NurturingScreen from './NurturingScreen'

const CSS = `
[data-network-tabs]{background:${T.background};font-family:${FONT.ui}}
[data-network-tabs] .nt-bar{width:100%;max-width:1152px;margin:0 auto;padding:20px 32px 0}
[data-network-tabs] .nt-tabs{display:inline-flex;gap:4px;padding:4px;border:1px solid ${T.border};border-radius:999px;background:${T.card}}
[data-network-tabs] .nt-tab{min-height:40px;padding:0 16px;border:0;border-radius:999px;background:none;font-family:inherit;font-size:14px;font-weight:700;color:${T.primary};cursor:pointer;white-space:nowrap}
[data-network-tabs] .nt-tab:hover{background:${T.muted}}
[data-network-tabs] .nt-tab[aria-selected="true"]{background:${T.primary};color:${T.primaryFg}}
[data-network-tabs] .nt-tab:focus-visible{outline:2px solid ${NET.partner};outline-offset:2px}
@media (max-width:767px){ [data-network-tabs] .nt-bar{padding:12px 16px 0} [data-network-tabs] .nt-tabs{display:flex} [data-network-tabs] .nt-tab{flex:1;padding:0 10px;font-size:13.5px} }
`

const mobileNow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches

export default function NetworkTabs({ locationId, locationName, fetchImpl = null, onOpenClient = null, ...networkProps }) {
  const [tab, setTab] = useState('network')
  return (
    <div data-network-tabs>
      <style>{CSS}</style>
      <div className="nt-bar">
        <div className="nt-tabs" role="tablist" aria-label="Network and Nurturing">
          <button type="button" role="tab" className="nt-tab" aria-selected={tab === 'network'} onClick={() => setTab('network')} data-tab="network">Network &amp; Partners</button>
          <button type="button" role="tab" className="nt-tab" aria-selected={tab === 'nurture'} onClick={() => setTab('nurture')} data-tab="nurture">Nurturing clients</button>
        </div>
      </div>
      {tab === 'network'
        ? <NetworkListScreen locationId={locationId} locationName={locationName} {...(fetchImpl ? { fetchImpl } : {})} {...networkProps} />
        : <NurturingScreen locationId={locationId} locationName={locationName} fetchImpl={fetchImpl} isMobile={mobileNow()} onOpenClient={onOpenClient} />}
    </div>
  )
}
