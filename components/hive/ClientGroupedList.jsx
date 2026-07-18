// components/hive/ClientGroupedList.jsx
// ─────────────────────────────────────────────────────────────
// HIVE — the Client List lens (nav restructure 2026-07-18), the grouped
// color-band presentation (approved mockup). Clients grouped by STATUS
// (New · Attempting · Nurturing · Active · Client · Past client · No
// contact), each group a tinted band whose colored header carries a status
// dot + label + count, with the client rows on white cards inside.
//
// SAME data, SAME source as the directory — NOT a divergent lens:
//   · status + its color come from shared/clientStatus (deriveClientStatus
//     + CLIENT_STATUS_META) mapped through CHIP_STYLES — the one status
//     color source the directory chips already read.
//   · the row avatar is tinted to the group color (InitialsAvatar with the
//     family's bg/text), name + location beside it.
//   · a row click opens the SAME ClientProfile the directory opens
//     (onOpenClient), threaded up through HiveShell.
//   · location names resolve from the `locations` roster already loaded for
//     the app switcher — no new query.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useMemo } from 'react'
import { CHIP_STYLES, CLOSED_WON, isTerminal } from './shared/stageConfig'
import { T } from './shared/tokens'
import { deriveClientStatus, CLIENT_STATUS_ORDER, CLIENT_STATUS_META } from './shared/clientStatus'
import { HAIRLINE_BORDER } from '@/components/ui/tokens'
import InitialsAvatar from './shared/InitialsAvatar'

// A small filled dot in the status's dark stop — sourced from CHIP_STYLES
// (the same status color source the directory chip reads), never a literal.
function StatusDot({ color }) {
  return <span aria-hidden style={{ width: '9px', height: '9px', borderRadius: T.radius.round, background: color, display: 'inline-block', flexShrink: 0 }} />
}

export default function ClientGroupedList({ people = [], engagements = [], locFilter = 'all', onOpenClient = () => {}, locations = [] }) {
  const [search, setSearch] = useState('')
  const nowMs = Date.now()

  const scoped = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  // Open / won client-id sets — same derivation inputs the directory uses,
  // so a just-closed engagement leaves the open set and a just-won one flips
  // its person to Client without a reload.
  const openClientIds = useMemo(() => {
    const s = new Set()
    for (const e of engagements) if (!isTerminal(e.stage)) s.add(e.client_id)
    return s
  }, [engagements])
  const wonClientIds = useMemo(() => new Set(
    engagements.filter(e => e.stage === CLOSED_WON).map(e => e.client_id)
  ), [engagements])

  const locName = (id) => (locations.find(l => l.id === id) || {}).name || null

  // Classify once, then search-filter. Grouping is by STATUS (present on the
  // shape via the shared derivation) — search is name/email/phone.
  const classified = useMemo(() => scoped.map(p => ({
    p, status: deriveClientStatus(p, openClientIds, nowMs, wonClientIds),
  })), [scoped, openClientIds, wonClientIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const q = search.trim().toLowerCase()
  const visible = q
    ? classified.filter(({ p }) =>
        (p.name || '').toLowerCase().includes(q)
        || (p.email || '').toLowerCase().includes(q)
        || (p.phone || '').toLowerCase().includes(q))
    : classified

  // The full visible id order powers the ClientProfile prev/next chevrons.
  const orderedIds = visible.map(({ p }) => p.id)

  // Bucket into status → rows, name-sorted within each group.
  const groups = useMemo(() => {
    const by = new Map()
    for (const cs of visible) {
      if (!by.has(cs.status)) by.set(cs.status, [])
      by.get(cs.status).push(cs.p)
    }
    for (const arr of by.values()) arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    return by
  }, [visible])

  const totalShown = visible.length

  return (
    <div>
      <style>{`.bee-grp-row:hover { border-color:${T.hairline.strong} }`}</style>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search name, email, phone…"
        style={{
          width: '100%', boxSizing: 'border-box', marginBottom: '12px',
          padding: '9px 14px', borderRadius: T.radius.control,
          border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`, background: T.surface.raised,
          fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none',
        }}
      />

      {totalShown === 0 && (
        <div style={{ padding: '32px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>
          {q ? 'No clients match that search' : 'No clients in this view'}
        </div>
      )}

      {CLIENT_STATUS_ORDER.map(statusKey => {
        const rows = groups.get(statusKey)
        if (!rows || rows.length === 0) return null
        const meta = CLIENT_STATUS_META[statusKey]
        const fam = CHIP_STYLES[meta.styleKey] || CHIP_STYLES.gray
        return (
          <div key={statusKey} style={{ background: fam.bg, borderRadius: T.radius.card, padding: '10px 10px 12px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px 8px' }}>
              <StatusDot color={fam.text} />
              <span style={{ fontSize: '13px', fontWeight: 600, color: fam.text, whiteSpace: 'nowrap' }}>{meta.label}</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: fam.text, opacity: 0.7, fontVariantNumeric: T.type.tabular }}>· {rows.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {rows.map(p => {
                const loc = locName(p.locationId)
                return (
                  <div key={p.id} className="bee-grp-row" onClick={() => onOpenClient(p.id, orderedIds)}
                    style={{ display: 'flex', alignItems: 'center', gap: '12px', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, padding: '11px 14px', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                    <InitialsAvatar name={p.name} bg={fam.bg} text={fam.text} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontSize: '14px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                      {loc && <p style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>{loc}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
