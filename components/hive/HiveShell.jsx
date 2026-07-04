// components/hive/HiveShell.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 beta shell (doc §7) — the four-tab chrome around the
// step-4 screens: Inbox | Board | List | Clients. When the beta toggle
// is on, this REPLACES the legacy Clients content area entirely (the
// legacy header/tabs/search are hidden, not restyled).
//
// Board is the only live tab; Inbox/List/Clients are disabled 'soon'
// placeholders until their screens land. Lives inside the beta dynamic
// chunk — BeeHub dynamic-imports THIS module (ssr:false) and this
// module imports EngagementBoard statically, so all beta code stays
// out of the main bundle (§8.5 bundle-isolation rules).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import EngagementBoard from './EngagementBoard'
import EngagementList from './EngagementList'
import EngagementPanel from './EngagementPanel'

const TABS = [
  { key: 'inbox',   label: 'Inbox',   live: false, badge: true },
  { key: 'board',   label: 'Board',   live: true },
  { key: 'list',    label: 'List',    live: true },
  { key: 'clients', label: 'Clients', live: false },
]

// The preferred lens (Board/List) sticks across sessions.
const LENS_LS_KEY = 'bee_hive_beta_lens'

function TabPill({ tab, active, onSelect }) {
  if (!tab.live) {
    return (
      <span
        title="Coming soon"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          padding: '6px 14px', borderRadius: '20px',
          border: '0.5px solid transparent',
          fontSize: '13px', fontWeight: 400, color: '#b5b3ac',
          cursor: 'default', userSelect: 'none', whiteSpace: 'nowrap',
        }}
      >
        {tab.label}
        {tab.badge && (
          <span style={{ padding: '0 6px', borderRadius: '8px', background: '#F1EFE8', color: '#b5b3ac', fontSize: '10px', lineHeight: 1.6 }}>–</span>
        )}
        <span style={{ fontSize: '9px', color: '#c9c7c0', fontWeight: 400 }}>soon</span>
      </span>
    )
  }
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '6px 14px', borderRadius: '20px',
        border: `0.5px solid ${active ? 'rgba(0,0,0,0.15)' : 'transparent'}`,
        background: active ? '#fff' : 'transparent',
        fontSize: '13px', fontWeight: 500,
        color: active ? '#1a1a18' : '#8a8a84',
        cursor: active ? 'default' : 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {tab.label}
    </button>
  )
}

// Location scoping: the beta view follows the EXISTING app-level location
// switcher (App top bar — visible above the shell), exactly like the legacy
// board: HiveScreen passes its locFilter prop through and the engagement
// set filters client-side on location_uuid (locFilter holds 'all' or the
// location uuid — the same vocabulary people-mapper documents).
export default function HiveShell({
  engagements = [],
  closedCount = 0,
  locFilter = 'all',
  onOpenClient = () => {},
  setToast = () => {},
  onExitBeta = () => {},
}) {
  // Board/List lens — default 'board', hydrated from localStorage after
  // mount (SSR-safe, same pattern as the legacy view toggle).
  const [lens, setLens] = useState('board')
  useEffect(() => {
    try { const v = localStorage.getItem(LENS_LS_KEY); if (v === 'board' || v === 'list') setLens(v) } catch {}
  }, [])
  const pickLens = (v) => { setLens(v); try { localStorage.setItem(LENS_LS_KEY, v) } catch {} }

  // Engagement panel (card click-through) + patches the panel makes
  // (title rename, stage advance) — applied over the server rows so the
  // board reflects them immediately without a reload.
  const [panelEngagement, setPanelEngagement] = useState(null)
  const [rowPatches, setRowPatches] = useState({})

  const patched = Object.keys(rowPatches).length === 0
    ? engagements
    : engagements.map(e => (rowPatches[e.id] ? { ...e, ...rowPatches[e.id] } : e))

  const filtered = locFilter === 'all'
    ? patched
    : patched.filter(e => e.location_uuid === locFilter)
  const openCount = filtered.length

  return (
    <div style={{ background: '#fdfdfc', minHeight: '100vh', padding: '1rem 1rem 5rem', fontFamily: 'DM Sans,system-ui,sans-serif' }}>
      {/* Top row: tab pills left, quiet counter + escape hatch right */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flex: 1, minWidth: 0 }}>
          {TABS.map(t => <TabPill key={t.key} tab={t} active={t.key === lens} onSelect={() => pickLens(t.key)} />)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
          <span style={{ fontSize: '12px', color: '#8a8a84', whiteSpace: 'nowrap' }}>Open engagements · {openCount}</span>
          <button
            onClick={onExitBeta}
            style={{
              border: 'none', background: 'transparent', padding: 0,
              fontSize: '11px', color: '#b5b3ac', cursor: 'pointer',
              fontFamily: 'inherit', textDecoration: 'underline',
              textUnderlineOffset: '2px', whiteSpace: 'nowrap',
            }}
          >
            Back to classic
          </button>
        </div>
      </div>

      {lens === 'list' ? (
        <EngagementList
          engagements={filtered}
          closedCount={closedCount}
          locFilter={locFilter}
          onOpenEngagement={(e) => setPanelEngagement(e)}
          setToast={setToast}
        />
      ) : (
        <EngagementBoard
          engagements={filtered}
          onOpenClient={onOpenClient}
          onOpenEngagement={(e) => setPanelEngagement(e)}
          setToast={setToast}
        />
      )}

      {panelEngagement && (
        <EngagementPanel
          engagementId={panelEngagement.id}
          seed={panelEngagement}
          onClose={() => setPanelEngagement(null)}
          onOpenClient={(clientId) => { setPanelEngagement(null); onOpenClient(clientId) }}
          onChanged={(id, patch) => setRowPatches(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))}
          setToast={setToast}
        />
      )}
    </div>
  )
}
