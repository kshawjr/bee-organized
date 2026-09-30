// components/admin/AdminZipCodesScreen.jsx
// ─────────────────────────────────────────────────────────────
// Admin → Zip codes. The list that decides where a website global-form lead
// goes (lib/zip-routing.ts). Corporate views, adds, moves and removes zips
// here, and settles a zip two locations both claim.
//
// WHAT A CONFLICT MEANS. A zip held by two locations routes to Other
// (loc_other, Leslie) — nothing picks a winner automatically. The Conflicts
// card is first on the screen because every zip in it is a lead that will
// need routing by hand until someone decides.
//
// The rows, actions and words are the shared pieces in ./zips/zipParts.jsx —
// the same ones a location's own Territory panel uses (LocationZipsPanel), so
// the two cannot drift. Built on the design tokens (T), no color literal of
// its own; lib/beta-admin-zip-codes.test.tsx sweeps for one.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_LABEL } from '@/components/ui/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'
import {
  ZIPS_API, zipStyles, zipSend, useZipActions,
  ZipMessage, ZipConflictRow, ZipAddForm, ZipEditRow, ZipChips,
} from './zips/zipParts'

const { card, input, btn, muted } = zipStyles

export default function AdminZipCodesScreen() {
  const [zips, setZips] = useState(null) // null = loading
  const [locations, setLocations] = useState([])
  // Rows in the table per the server's exact count. If the list we hold is
  // shorter, the screen says so instead of showing a quiet subset.
  const [total, setTotal] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [query, setQuery] = useState('')
  const [openLoc, setOpenLoc] = useState(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const j = await zipSend('GET', ZIPS_API)
      setZips(Array.isArray(j.zips) ? j.zips : [])
      setLocations(Array.isArray(j.locations) ? j.locations : [])
      setTotal(typeof j.total === 'number' ? j.total : null)
    } catch (e) {
      setLoadError(e.message)
      setZips([])
    }
  }, [])
  useEffect(() => { load() }, [load])

  const locById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations])
  const locName = (id) => locById.get(id)?.name || 'Unknown location'
  const actions = useZipActions({ reload: load, locName })
  const { busy } = actions

  const byZip = useMemo(() => {
    const m = new Map()
    for (const z of zips || []) {
      if (!m.has(z.zip)) m.set(z.zip, [])
      m.get(z.zip).push(z)
    }
    return m
  }, [zips])

  const conflicts = useMemo(
    () => Array.from(byZip.entries()).filter(([, rows]) => rows.length > 1).sort(([a], [b]) => a.localeCompare(b)),
    [byZip],
  )
  const conflictedZips = useMemo(() => new Set(conflicts.map(([z]) => z)), [conflicts])

  const byLoc = useMemo(() => {
    const m = new Map()
    for (const z of zips || []) {
      if (!m.has(z.location_uuid)) m.set(z.location_uuid, [])
      m.get(z.location_uuid).push(z)
    }
    return m
  }, [zips])

  if (zips === null) return <BeeLoader />

  const q = query.trim().toLowerCase()
  const zipHits = /^\d{1,5}$/.test(q) ? (zips || []).filter((z) => z.zip.startsWith(q)).slice(0, 100) : []
  const locRows = q ? locations.filter((l) => l.name.toLowerCase().includes(q)) : locations

  return (
    <div style={{ maxWidth: '860px' }}>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ fontSize: '20px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>Zip codes</div>
        <div style={muted}>
          {byZip.size.toLocaleString()} zips · {byLoc.size} locations · {conflicts.length} in conflict
        </div>
        <div style={{ ...muted, marginTop: '6px' }}>
          A lead from the website’s global form goes to the location that holds its zip. A zip no one holds —
          or two locations hold — goes to Other for Leslie to route. A zip held only by a location that isn’t
          live yet also goes to Other.
        </div>
      </div>

      {loadError && <div style={{ ...card, color: T.state.danger.fg }}>Couldn’t load the zip list ({loadError}).</div>}
      {total !== null && (zips || []).length < total && (
        <div role="alert" style={{ ...card, color: T.state.danger.fg }}>
          Only {(zips || []).length.toLocaleString()} of {total.toLocaleString()} zip rows loaded — counts and conflicts below are incomplete. Refresh to try again.
        </div>
      )}
      <ZipMessage msg={actions.msg} />

      {conflicts.length > 0 && (
        <div style={card} data-testid="zip-conflicts">
          <div style={SECTION_LABEL}>In conflict — these go to Other until one location is picked</div>
          {conflicts.map(([zip, rows]) => (
            <ZipConflictRow
              key={zip}
              zip={zip}
              claimants={rows.map((r) => ({ location_uuid: r.location_uuid, name: locName(r.location_uuid) }))}
              canEdit
              busy={busy}
              onResolve={actions.resolve}
            />
          ))}
        </div>
      )}

      <div style={card}>
        <div style={SECTION_LABEL}>Add a zip</div>
        <ZipAddForm locations={locations} busy={busy} onAdd={actions.add} />
      </div>

      <div style={card}>
        <div style={SECTION_LABEL}>Find</div>
        <input
          aria-label="Find a zip or location"
          placeholder="Type a zip or a location name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...input, width: '100%', boxSizing: 'border-box', marginTop: '8px' }}
        />

        {zipHits.length > 0 && (
          <div style={{ marginTop: '8px' }} data-testid="zip-hits">
            {zipHits.map((row) => (
              <ZipEditRow
                key={row.id}
                row={row}
                locations={locations}
                inConflict={conflictedZips.has(row.zip)}
                busy={busy}
                onMove={actions.move}
                onRemove={actions.remove}
              />
            ))}
          </div>
        )}
        {/^\d{1,5}$/.test(q) && zipHits.length === 0 && (
          <div style={{ ...muted, marginTop: '8px' }}>No location holds a zip starting {q} — a lead from it goes to Other.</div>
        )}
      </div>

      {!/^\d/.test(q) && (
        <div style={card}>
          <div style={SECTION_LABEL}>By location</div>
          {locRows.length === 0 && <div style={{ ...muted, marginTop: '8px' }}>No location matches.</div>}
          {locRows.map((l) => {
            const rows = byLoc.get(l.id) || []
            const open = openLoc === l.id
            return (
              <div key={l.id} style={{ borderTop: T.border.divider, padding: '8px 0' }}>
                <button
                  onClick={() => setOpenLoc(open ? null : l.id)}
                  style={{ ...btn, border: 'none', padding: 0, background: 'transparent', display: 'flex', gap: '8px', width: '100%', textAlign: 'left' }}
                  aria-expanded={open}
                >
                  <span style={{ fontWeight: 500 }}>{l.name}</span>
                  <span style={muted}>{rows.length} zips{l.lifecycle_status !== 'active' ? ' · not live — its zips go to Other' : ''}</span>
                </button>
                {open && (
                  <ZipChips rows={rows} locationName={l.name} conflicted={conflictedZips} busy={busy} onRemove={actions.remove} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
