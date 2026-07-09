// components/hive/HiveShell.jsx
// ─────────────────────────────────────────────────────────────
// HIVE Phase 1 beta shell (doc §7) — the four-tab chrome around the
// step-4 screens: Inbox | Board | List | Clients. When the beta toggle
// is on, this REPLACES the legacy Clients content area entirely (the
// legacy header/tabs/search are hidden, not restyled).
//
// All four tabs are live (Tabler-style icons from ui/icons). Lives
// inside the beta dynamic chunk — BeeHub dynamic-imports THIS module
// (ssr:false) and this module statically owns every beta screen, so all
// beta code stays out of the main bundle (§8.5 bundle-isolation rules).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo } from 'react'
import EngagementBoard from './EngagementBoard'
import EngagementList from './EngagementList'
import EngagementPanel from './EngagementPanel'
import ClientDirectory from './ClientDirectory'
import InboxScreen from './InboxScreen'
import ClientProfile from './ClientProfile'
import PersonCard from './PersonCard'
import NewClientSheet from './NewClientSheet'
import { mapLeadToPerson } from '@/lib/people-mapper'
import { leadColsToPersonFields } from './shared/leadPatchMap'
import { deriveClientStatus } from './shared/clientStatus'
import { isTerminal, CLOSED_WON } from './shared/stageConfig'
import { ENGAGEMENT_FILTER_DEFAULTS, passesEngagementFilters, engagementFilterCount } from './shared/engagementStatus'
import { useStoredState } from './shared/useStoredControls'
import useIsMobile from './shared/useIsMobile'
import { IconInbox, IconLayoutKanban, IconList, IconUsers, IconPlus } from '@/components/ui/icons'
import { TEXT_TOKENS, BORDER_TOKENS, WARNING_TOKENS, HAIRLINE_BORDER } from '@/components/ui/tokens'
import { CHIP_STYLES } from './shared/stageConfig'

const TABS = [
  { key: 'inbox',   label: 'Inbox',   live: true, badge: true, Icon: IconInbox },
  { key: 'board',   label: 'Board',   live: true, Icon: IconLayoutKanban },
  { key: 'list',    label: 'List',    live: true, Icon: IconList },
  { key: 'clients', label: 'Clients', live: true, Icon: IconUsers },
]

// The preferred lens (Board/List) sticks across sessions.
const LENS_LS_KEY = 'bee_hive_beta_lens'

function TabPill({ tab, active, onSelect, badgeCount = null }) {
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
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '6px 14px', borderRadius: '20px',
        border: `0.5px solid ${active ? `var(--hairline-border, ${HAIRLINE_BORDER})` : 'transparent'}`,
        background: active ? '#fff' : 'transparent',
        fontSize: '13px', fontWeight: 500,
        color: active ? '#1a1a18' : '#8a8a84',
        cursor: active ? 'default' : 'pointer', whiteSpace: 'nowrap',
        fontFamily: 'inherit',
      }}
    >
      {tab.Icon && <tab.Icon size={14} />}
      {tab.label}
      {tab.badge && badgeCount != null && badgeCount > 0 && (
        // Badge metrics are its own role (10px/600 count pill); the COLOR
        // pair is the one CHIP_STYLES teal — the same pair StatusChip uses.
        <span style={{ marginLeft: '6px', padding: '0 6px', borderRadius: '8px', background: CHIP_STYLES.teal.bg, color: CHIP_STYLES.teal.text, fontSize: '10px', fontWeight: 600, lineHeight: 1.6 }}>
          {badgeCount}
        </span>
      )}
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
  closedWonCount = 0,
  people = [],
  locFilter = 'all',
  currentLocationUuid = null,
  currentUserId = null,
  onOpenClient = () => {},
  onSendToJobber = () => {},
  // The people-merge seam (§8.5 direction rule): BeeHub passes this
  // callback DOWN; after a confirmed create the shell hands the mapped
  // person UP through it. The shell never reaches into BeeHub state.
  onPersonCreated = null,
  // The people-PATCH seam — same direction rule, for edits: after a card
  // saves a lead field (source/type/referrer), the shell hands the
  // Person-shaped patch UP so Inbox rows / filters / reopened cards
  // reflect it without a reload.
  onPersonPatched = null,
  // The partner-create seam — same direction rule: ReferrerPicker's
  // inline create hands its CONFIRMED /api/partners row up so Classic's
  // partners state (PartnersScreen) shows it without a reload. The
  // picker never touches PartnersContext (§8.5).
  onPartnerCreated = null,
  setToast = () => {},
  onExitBeta = () => {},
}) {
  // Board/List/Clients lens — default 'board', hydrated from localStorage
  // after mount (SSR-safe, same pattern as the legacy view toggle).
  const [lens, setLens] = useState('board')
  const isMobile = useIsMobile()
  useEffect(() => {
    try { const v = localStorage.getItem(LENS_LS_KEY); if (['board', 'list', 'clients', 'inbox'].includes(v)) setLens(v) } catch {}
  }, [])
  const pickLens = (v) => { setLens(v); try { localStorage.setItem(LENS_LS_KEY, v) } catch {} }

  // ONE overlay slot: EngagementPanel or ClientProfile — they REPLACE
  // each other (no stacking): 'View profile' swaps panel→profile;
  // tapping an engagement card on the profile swaps back. rowPatches
  // mirror panel changes (title/stage) onto the board without a reload.
  // overlay: null | { type:'engagement', engagement } | { type:'client', clientId }
  //        | { type:'person', person }  ← pre-engagement card (Inbox rows)
  const [overlay, setOverlay] = useState(null)
  const [rowPatches, setRowPatches] = useState({})
  // Engagements founded THIS SESSION (NewClientSheet frames B/D — the
  // decoupled manual founding). Merged ahead of the server-hydrated set
  // so the founded row shows on the Board in Request without a reload,
  // and the person derives Active everywhere (openClientIds consumers).
  // Same real-row rule as onPersonCreated: only confirmed API returns
  // land here, never optimistic stubs.
  const [sessionEngagements, setSessionEngagements] = useState([])
  // Manual add-client sheet ("New"). The FAB must not stay live behind
  // ANY open sheet, so both overlay slots feed one flag.
  const [newClientOpen, setNewClientOpen] = useState(false)
  const anySheetOpen = overlay != null || newClientOpen

  // Admin-managed option lists (lookups: global, super-admin curated) —
  // fetched ONCE per shell mount and threaded to PersonCard +
  // EngagementPanel (lighter than per-card fetches).
  const [lookupOptions, setLookupOptions] = useState({ sources: [], projectTypes: [] })
  useEffect(() => {
    let dead = false
    fetch('/api/lookups')
      .then(r => r.json())
      .then(j => {
        if (dead) return
        const by = (cat) => (j.lookups || []).filter(l => l.category === cat).map(l => l.label)
        setLookupOptions({ sources: by('lead_sources'), projectTypes: by('project_types') })
      })
      .catch(() => {})
    return () => { dead = true }
  }, [])

  // Work-lens filters (board + list share ONE set — Kevin's call: switch
  // lenses mid-triage, keep the subset). Owned HERE so both lenses and
  // the open-count derive from a single instance; persisted per user.
  const [workFilters, setWorkFilters, clearWorkFilters] = useStoredState('bee_hive_list_filters', ENGAGEMENT_FILTER_DEFAULTS)
  // Board→List deep link ("view all in List" on the closed rail): a
  // one-shot seed the List consumes on mount, then hands back null.
  const [listInitialView, setListInitialView] = useState(null)
  const viewClosedInList = () => { setListInitialView('closed'); pickLens('list') }
  const openEngagement = (e) => setOverlay({ type: 'engagement', engagement: e })
  const openClient = (clientId) => setOverlay({ type: 'client', clientId })
  const openPerson = (person) => setOverlay({ type: 'person', person })

  // Cards emit lead-COLUMN patches after a confirmed PATCH; translate to
  // Person-shape fields and hand UP (onPersonPatched merges into BeeHub's
  // people state). Unknown columns are dropped by the translator.
  const handleLeadPatched = (leadId, cols) => {
    if (!onPersonPatched) return
    const fields = leadColsToPersonFields(cols)
    if (Object.keys(fields).length > 0) onPersonPatched(leadId, fields)
  }

  const allEngagements = sessionEngagements.length === 0
    ? engagements
    : [...sessionEngagements.filter(s => !engagements.some(e => e.id === s.id)), ...engagements]
  const patched = Object.keys(rowPatches).length === 0
    ? allEngagements
    : allEngagements.map(e => (rowPatches[e.id] ? { ...e, ...rowPatches[e.id] } : e))

  const filtered = locFilter === 'all'
    ? patched
    : patched.filter(e => e.location_uuid === locFilter)
  // Rows closed THIS SESSION (via the panel's close-out) carry a terminal
  // rowPatch — they leave the count and every open-set consumer. The
  // counter reflects the ACTIVE work filters (F: counts reconcile).
  const openFiltered = filtered.filter(e => !isTerminal(e.stage))
  const nowMs = Date.now()
  const openCount = openFiltered.filter(e => passesEngagementFilters(e, workFilters, nowMs)).length

  // Inbox badge: New + Attempting in the current location scope. The
  // won set (session-closed Won + hydrated person.wonEngagements inside
  // the derivation) keeps won clients out of the count — same inputs as
  // the Inbox worklist itself.
  const inboxCount = useMemo(() => {
    const scopedPeople = locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
    const openIds = new Set(openFiltered.map(e => e.client_id))
    const wonIds = new Set(filtered.filter(e => e.stage === CLOSED_WON).map(e => e.client_id))
    let n = 0
    for (const p of scopedPeople) {
      const s = deriveClientStatus(p, openIds, Date.now(), wonIds)
      if (s === 'New' || s === 'Attempting') n++
    }
    return n
  }, [people, locFilter, openFiltered, filtered])

  const tabPills = TABS.map(t => <TabPill key={t.key} tab={t} active={t.key === lens} onSelect={() => pickLens(t.key)} badgeCount={t.badge ? inboxCount : null} />)
  // Desktop "New" pill — the ONE solid chrome element, visible from all
  // four tabs, left of the counter. Mobile gets the FAB instead.
  const newPillEl = (
    <button
      onClick={() => setNewClientOpen(true)}
      aria-label="New client"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        height: '34px', padding: '0 14px', borderRadius: '20px',
        border: 'none', background: '#1a1a18', color: '#fff',
        fontSize: '13px', fontWeight: 500, cursor: 'pointer',
        fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0,
      }}
    >
      <IconPlus size={14} /> New
    </button>
  )
  const counterEl = (
    <span style={{ fontSize: isMobile ? '11px' : '12px', color: '#8a8a84', whiteSpace: 'nowrap' }}>
      Open engagements · {openCount}{engagementFilterCount(workFilters) > 0 ? ` of ${openFiltered.length}` : ''}
    </span>
  )
  const exitEl = (
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
  )

  return (
    // min-height fills the VISIBLE viewport (dvh where supported — iOS
    // vh is the large viewport; vh kept as the old-browser fallback).
    <div className="bee-hive-root" style={{ ...TEXT_TOKENS, ...BORDER_TOKENS, ...WARNING_TOKENS, background: '#fdfdfc', padding: '1rem 1rem 5rem', fontFamily: 'DM Sans,system-ui,sans-serif' }}>
      <style>{`.bee-hive-root { min-height: 100vh; min-height: 100dvh; }`}</style>
      {isMobile ? (
        /* Mobile chrome STACKS (nothing may overlap at 320–430px):
           row 1 = the four tab pills on ONE nowrap line, scrolling
           horizontally if tight; row 2 = compact meta line, counter
           left + escape hatch right, both 11px quiet. */
        <div style={{ marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', paddingBottom: '2px' }}>
            {tabPills}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '6px', padding: '0 4px' }}>
            {counterEl}
            {exitEl}
          </div>
        </div>
      ) : (
        /* Desktop top row: tab pills left, quiet counter + escape hatch right */
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flex: 1, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
            {tabPills}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
            {newPillEl}
            {counterEl}
            {exitEl}
          </div>
        </div>
      )}

      {lens === 'inbox' ? (
        <InboxScreen
          people={people}
          engagements={patched}
          locFilter={locFilter}
          onOpenPerson={openPerson}
          onSendToJobber={onSendToJobber}
          setToast={setToast}
        />
      ) : lens === 'clients' ? (
        <ClientDirectory
          people={people}
          engagements={patched}
          locFilter={locFilter}
          onOpenClient={openClient}
        />
      ) : lens === 'list' ? (
        <EngagementList
          engagements={filtered}
          closedCount={closedCount}
          closedWonCount={closedWonCount}
          locFilter={locFilter}
          workFilters={workFilters}
          setWorkFilters={setWorkFilters}
          clearWorkFilters={clearWorkFilters}
          onOpenEngagement={openEngagement}
          setToast={setToast}
          initialView={listInitialView}
          onInitialViewConsumed={() => setListInitialView(null)}
        />
      ) : (
        <EngagementBoard
          engagements={filtered}
          closedCount={closedCount}
          locFilter={locFilter}
          workFilters={workFilters}
          setWorkFilters={setWorkFilters}
          clearWorkFilters={clearWorkFilters}
          onOpenClient={openClient}
          onOpenEngagement={openEngagement}
          onViewClosedInList={viewClosedInList}
          setToast={setToast}
        />
      )}

      {/* Mobile FAB — classic FAB position (bottom-right, safe-area
          aware). Hidden whenever any sheet is open so it isn't live
          behind the sheet's actions row. */}
      {isMobile && !anySheetOpen && (
        <button
          onClick={() => setNewClientOpen(true)}
          aria-label="New client"
          style={{
            position: 'fixed',
            right: 'calc(16px + env(safe-area-inset-right, 0px))',
            bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
            width: '52px', height: '52px', borderRadius: '50%',
            border: 'none', background: '#1a1a18', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(26,26,24,0.3)', cursor: 'pointer',
            zIndex: 10000,
          }}
        >
          <IconPlus size={24} />
        </button>
      )}

      {newClientOpen && (
        <NewClientSheet
          people={people}
          onPartnerCreated={onPartnerCreated}
          engagements={filtered}
          locFilter={locFilter}
          currentLocationUuid={currentLocationUuid}
          currentUserId={currentUserId}
          lookupOptions={lookupOptions}
          setToast={setToast}
          onClose={() => setNewClientOpen(false)}
          onOpenClient={(clientId) => { setNewClientOpen(false); openClient(clientId) }}
          onOpenEngagement={(e) => { setNewClientOpen(false); openEngagement(e) }}
          onSendToJobber={onSendToJobber}
          onFounded={(engRow) => {
            // CONFIRMED founding only — the real returned engagement row
            // (board shape) merges into the session set; the sheet stays
            // open on frame F for the send-or-keep-local next step.
            setSessionEngagements(prev => prev.some(x => x.id === engRow.id) ? prev : [engRow, ...prev])
          }}
          onCreated={(leadRow) => {
            // CONFIRMED insert only — map the real returned row (never an
            // optimistic stub), hand it up through onPersonCreated so the
            // Inbox "New" row appears without a reload, then open the card.
            const person = mapLeadToPerson(leadRow, {})
            if (onPersonCreated) onPersonCreated(person)
            setNewClientOpen(false)
            setOverlay({ type: 'person', person })
          }}
        />
      )}

      {/* keys: any record change remounts the overlay, so OverlayShell's
          mount reset (scrollTop 0 + body lock) covers every open/swap */}
      {overlay?.type === 'engagement' && (
        <EngagementPanel
          key={overlay.engagement.id}
          engagementId={overlay.engagement.id}
          seed={overlay.engagement}
          people={people}
          onClose={() => setOverlay(null)}
          onOpenClient={openClient}
          onChanged={(id, patch) => setRowPatches(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }))}
          onLeadPatched={handleLeadPatched}
          onPartnerCreated={onPartnerCreated}
          onSendToJobber={(clientId, opts) => {
            // Founded-not-sent send (engagement-scoped): resolve the person
            // the popup needs — same lookup as ClientProfile below.
            const p = people.find(x => x.id === clientId)
            if (p) onSendToJobber(p, opts)
            else setToast({ kind: 'error', msg: 'Client record not loaded — try the classic view' })
          }}
          setToast={setToast}
          lookupOptions={lookupOptions}
        />
      )}
      {overlay?.type === 'person' && (
        <PersonCard
          key={overlay.person.id}
          person={overlay.person}
          people={people}
          onClose={() => setOverlay(null)}
          onSendToJobber={onSendToJobber}
          setToast={setToast}
          onLeadPatched={handleLeadPatched}
          onPartnerCreated={onPartnerCreated}
          lookupOptions={lookupOptions}
        />
      )}
      {overlay?.type === 'client' && (
        <ClientProfile
          key={overlay.clientId}
          clientId={overlay.clientId}
          people={people}
          onClose={() => setOverlay(null)}
          onOpenEngagement={openEngagement}
          onLeadPatched={handleLeadPatched}
          onPartnerCreated={onPartnerCreated}
          onSendToJobber={(clientId) => {
            const p = people.find(x => x.id === clientId)
            if (p) onSendToJobber(p)
            else setToast({ kind: 'error', msg: 'Client record not loaded — try the classic view' })
          }}
          setToast={setToast}
        />
      )}
    </div>
  )
}
