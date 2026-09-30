// components/admin/LocationZipsPanel.jsx
// ─────────────────────────────────────────────────────────────
// One location's TERRITORY — its zips — on that location's own pages:
//   • Admin → a location's detail sheet (corporate), under Quick info
//   • Settings → Location (the owner), under Location Details
//
// CORPORATE EDITS, OWNERS VIEW (Kevin, 30 Sep 2026). The panel asks
// GET /api/locations/[id]/zips, and the server answers `can_edit`. Controls
// appear only when it is true; every write still goes to
// /api/admin/location-zips, which refuses non-corporate callers on its own.
// A 403 on the read (someone the page shows, but who may not see territory)
// renders nothing — the rest of the page treats them as it already does.
//
// WHAT AN OWNER GETS, and why each line is there:
//   • the count and the zips, sorted — their territory
//   • CONFLICTS, first and in words: a zip another location also claims
//     routes to Leslie, not to them. That is the one thing an owner needs to
//     act on (by asking corporate), and the reason to show them the list.
//   • NOT LIVE: an onboarding location's zips route to Leslie until it is.
//
// Built from ./zips/zipParts.jsx — the same rows and actions as Admin → Zip
// codes, scoped to one location.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_LABEL } from '@/components/ui/tokens'
import {
  zipStyles, zipSend, useZipActions,
  ZipMessage, ZipConflictRow, ZipAddForm, ZipEditRow, ZipChips,
} from './zips/zipParts'

const { card, input, muted } = zipStyles
const warnBox = {
  ...card,
  background: T.state.warning.soft,
  border: `1px solid ${T.state.warning.fg}`,
  color: T.state.warning.fg,
}
const plural = (n, one, many) => (n === 1 ? one : many)
// Real locations only. Demo / view-as paths carry mock ids like 'loc_kc'.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function LocationZipsPanel({ locationId }) {
  const [data, setData] = useState(null) // null = loading
  const [hidden, setHidden] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [query, setQuery] = useState('')

  const real = !!locationId && UUID_RE.test(locationId)
  const load = useCallback(async () => {
    if (!real) return
    setLoadError(null)
    try {
      const j = await zipSend('GET', `/api/locations/${encodeURIComponent(locationId)}/zips`)
      // Never trust the shape: this panel sits inside other pages (Settings,
      // the admin sheet) with no error boundary, so a malformed reply must
      // become one line of text here — not a crash that blanks the page.
      if (!j || !j.location || !Array.isArray(j.zips) || !Array.isArray(j.conflicts)) {
        setLoadError('unexpected response')
        return
      }
      setData({ ...j, count: typeof j.count === 'number' ? j.count : new Set(j.zips.map((z) => z.zip)).size })
    } catch (e) {
      if (e.message === 'forbidden' || e.message === 'unauthorized') setHidden(true)
      else setLoadError(e.message)
    }
  }, [locationId, real])
  useEffect(() => { load() }, [load])

  const names = useMemo(() => {
    const m = new Map()
    for (const l of data?.locations || []) m.set(l.id, l.name)
    for (const c of data?.conflicts || []) for (const x of c.claimants) m.set(x.location_uuid, x.name)
    if (data?.location) m.set(data.location.id, data.location.name)
    return m
  }, [data])
  const actions = useZipActions({ reload: load, locName: (id) => names.get(id) || 'Unknown location' })

  if (!real || hidden) return null
  if (loadError) return <div style={{ ...card, color: T.state.danger.fg }}>Couldn’t load this location’s zips ({loadError}).</div>
  if (!data) return <div style={{ ...card, ...muted }}>Loading territory…</div>

  const { location, zips, count, conflicts, not_live_routes_to_other: notLive, can_edit: canEdit } = data
  const conflicted = new Set(conflicts.map((c) => c.zip))
  const q = query.trim()
  const hits = canEdit && /^\d{1,5}$/.test(q) ? zips.filter((z) => z.zip.startsWith(q)).slice(0, 50) : []

  return (
    <div data-testid="location-territory" style={{ margin: '0 0 12px' }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <div style={SECTION_LABEL}>Territory</div>
          <div style={muted} data-testid="territory-count">{count.toLocaleString()} {plural(count, 'zip', 'zips')}</div>
        </div>
        <div style={{ ...muted, marginTop: '4px' }}>
          Website leads from these zips come to {location.name}.
          {!canEdit && ' Territory changes go through corporate.'}
        </div>

        {notLive && (
          <div role="note" data-testid="territory-not-live" style={{ ...warnBox, marginTop: '10px', marginBottom: 0 }}>
            {location.name} isn’t live yet, so leads from these zips go to Leslie at corporate until it is.
          </div>
        )}

        {conflicts.length > 0 && (
          <div data-testid="territory-conflicts" style={{ ...warnBox, marginTop: '10px', marginBottom: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {conflicts.length} {plural(conflicts.length, 'zip is', 'zips are')} also claimed by another location.
            </div>
            <div style={{ marginTop: '2px' }}>
              Leads from {plural(conflicts.length, 'it', 'them')} go to Leslie at corporate, not to {location.name},
              until corporate decides who covers {plural(conflicts.length, 'it', 'them')}.
            </div>
            <div style={{ color: T.ink.primary }}>
              {conflicts.map((c) => (
                <ZipConflictRow
                  key={c.zip}
                  zip={c.zip}
                  claimants={c.claimants}
                  canEdit={canEdit}
                  busy={actions.busy}
                  onResolve={actions.resolve}
                />
              ))}
            </div>
          </div>
        )}

        <ZipChips
          rows={zips}
          locationName={location.name}
          conflicted={conflicted}
          busy={actions.busy}
          onRemove={canEdit ? actions.remove : null}
        />
        {count === 0 && (
          <div style={{ ...muted, marginTop: '6px' }}>No website leads route to {location.name} by zip yet.</div>
        )}
      </div>

      {canEdit && (
        <div style={card} data-testid="territory-controls">
          <ZipMessage msg={actions.msg} />
          <div style={SECTION_LABEL}>Add a zip to {location.name}</div>
          <ZipAddForm fixedLocationId={location.id} busy={actions.busy} onAdd={actions.add} />
          <div style={{ ...SECTION_LABEL, marginTop: '12px' }}>Move a zip</div>
          <input
            aria-label="Find one of these zips"
            placeholder="Type one of these zips"
            inputMode="numeric"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ ...input, width: '100%', boxSizing: 'border-box', marginTop: '8px' }}
          />
          {hits.length > 0 && (
            <div style={{ marginTop: '8px' }} data-testid="zip-hits">
              {hits.map((row) => (
                <ZipEditRow
                  key={row.id}
                  row={row}
                  locations={data.locations || []}
                  inConflict={conflicted.has(row.zip)}
                  busy={actions.busy}
                  onMove={actions.move}
                  onRemove={actions.remove}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
