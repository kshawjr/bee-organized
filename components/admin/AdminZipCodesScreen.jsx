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
// Built on the design tokens (T) like AdminNotificationsScreen — no color
// literal of its own; lib/beta-admin-zip-codes.test.tsx sweeps for one.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { T } from '@/components/hive/shared/tokens'
import { SECTION_LABEL } from '@/components/ui/tokens'
import BeeLoader from '@/components/hive/shared/BeeLoader'

const API = '/api/admin/location-zips'

const card = {
  background: T.surface.raised,
  border: T.border.card,
  borderRadius: T.radius.card,
  padding: '14px 16px',
  marginBottom: '12px',
}
const input = {
  border: T.border.control,
  borderRadius: T.radius.control,
  padding: '7px 10px',
  fontSize: '13px',
  fontFamily: 'inherit',
  color: T.ink.primary,
  background: T.surface.raised,
}
const btn = {
  border: T.border.control,
  borderRadius: T.radius.control,
  padding: '6px 10px',
  fontSize: '12px',
  fontFamily: 'inherit',
  cursor: 'pointer',
  background: T.surface.raised,
  color: T.ink.primary,
}
const btnPrimary = { ...btn, border: 'none', background: T.accent.fg, color: T.accent.onFill }
const muted = { fontSize: '12px', color: T.ink.muted }

async function send(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`)
  return j
}

// Error codes → a sentence corporate can act on.
function sayError(code) {
  switch (code) {
    case 'invalid_zip': return 'That isn’t a five-digit zip.'
    case 'already_assigned': return 'That location already has this zip.'
    case 'cannot_assign_to_loc_other': return 'Zips can’t be given to Other — leave the zip off the list instead.'
    case 'location_not_found': return 'That location no longer exists.'
    case 'not_in_conflict': return 'That zip is no longer in conflict — refresh to see the current list.'
    default: return `Couldn’t save (${code}).`
  }
}

export default function AdminZipCodesScreen() {
  const [zips, setZips] = useState(null) // null = loading
  const [locations, setLocations] = useState([])
  // Rows in the table per the server's exact count. If the list we hold is
  // shorter, the screen says so instead of showing a quiet subset.
  const [total, setTotal] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [msg, setMsg] = useState(null) // { kind: 'ok' | 'warn' | 'error', text }
  const [busy, setBusy] = useState(false)
  const [newZip, setNewZip] = useState('')
  const [newLoc, setNewLoc] = useState('')
  const [query, setQuery] = useState('')
  const [openLoc, setOpenLoc] = useState(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const j = await send('GET', API)
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

  const byLoc = useMemo(() => {
    const m = new Map()
    for (const z of zips || []) {
      if (!m.has(z.location_uuid)) m.set(z.location_uuid, [])
      m.get(z.location_uuid).push(z)
    }
    return m
  }, [zips])

  const run = async (fn, okText) => {
    setBusy(true); setMsg(null)
    try {
      const res = await fn()
      await load()
      setMsg(res?.conflict
        ? { kind: 'warn', text: `${okText} Another location also has this zip, so it will go to Other until one of them is removed.` }
        : { kind: 'ok', text: okText })
      return true
    } catch (e) {
      setMsg({ kind: 'error', text: sayError(e.message) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const addZip = () => {
    const zip = newZip.trim()
    if (!zip || !newLoc) return
    run(() => send('POST', API, { zip, location_uuid: newLoc }), `Added ${zip} to ${locName(newLoc)}.`)
      .then((ok) => { if (ok) setNewZip('') })
  }
  const moveRow = (row, toId) =>
    run(() => send('PATCH', API, { id: row.id, location_uuid: toId }), `Moved ${row.zip} to ${locName(toId)}.`)
  const removeRow = (row) => {
    if (!window.confirm(`Remove ${row.zip} from ${locName(row.location_uuid)}?`)) return
    run(() => send('DELETE', `${API}?id=${encodeURIComponent(row.id)}`), `Removed ${row.zip} from ${locName(row.location_uuid)}.`)
  }
  const resolve = (zip, keepId) => {
    if (!window.confirm(`Give ${zip} to ${locName(keepId)} only? The other location loses it.`)) return
    run(() => send('POST', `${API}/resolve`, { zip, location_uuid: keepId }), `${zip} now goes to ${locName(keepId)}.`)
  }

  if (zips === null) return <BeeLoader />

  const q = query.trim().toLowerCase()
  const zipHits = /^\d{1,5}$/.test(q) ? (zips || []).filter((z) => z.zip.startsWith(q)).slice(0, 100) : []
  const locRows = q ? locations.filter((l) => l.name.toLowerCase().includes(q)) : locations

  const msgColor = msg?.kind === 'error' ? T.state.danger.fg : msg?.kind === 'warn' ? T.state.warning.fg : T.state.success.fg

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
      {msg && <div role="status" style={{ ...card, color: msgColor, padding: '10px 16px' }}>{msg.text}</div>}

      {conflicts.length > 0 && (
        <div style={card} data-testid="zip-conflicts">
          <div style={SECTION_LABEL}>In conflict — these go to Other until one location is picked</div>
          {conflicts.map(([zip, rows]) => (
            <div key={zip} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px 0', borderTop: T.border.divider }}>
              <span style={{ fontWeight: 600, fontVariantNumeric: T.type.tabular, minWidth: '52px' }}>{zip}</span>
              <span style={muted}>{rows.map((r) => locName(r.location_uuid)).join(' vs ')}</span>
              <span style={{ flex: 1 }} />
              {rows.map((r) => (
                <button key={r.id} style={btn} disabled={busy} onClick={() => resolve(zip, r.location_uuid)}>
                  Give to {locName(r.location_uuid)}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={card}>
        <div style={SECTION_LABEL}>Add a zip</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
          <input
            aria-label="Zip code"
            placeholder="Zip"
            inputMode="numeric"
            maxLength={10}
            value={newZip}
            onChange={(e) => setNewZip(e.target.value)}
            style={{ ...input, width: '90px' }}
          />
          <select aria-label="Location" value={newLoc} onChange={(e) => setNewLoc(e.target.value)} style={{ ...input, minWidth: '200px' }}>
            <option value="">Choose a location…</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.name}{l.lifecycle_status !== 'active' ? ' (not live)' : ''}</option>
            ))}
          </select>
          <button style={btnPrimary} disabled={busy || !newZip.trim() || !newLoc} onClick={addZip}>Add</button>
        </div>
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
              <div key={row.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '6px 0', borderTop: T.border.divider }}>
                <span style={{ fontWeight: 600, fontVariantNumeric: T.type.tabular, minWidth: '52px' }}>{row.zip}</span>
                <select
                  aria-label={`Location for ${row.zip}`}
                  value={row.location_uuid}
                  disabled={busy}
                  onChange={(e) => moveRow(row, e.target.value)}
                  style={{ ...input, minWidth: '200px' }}
                >
                  {!locById.has(row.location_uuid) && <option value={row.location_uuid}>Unknown location</option>}
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}{l.lifecycle_status !== 'active' ? ' (not live)' : ''}</option>
                  ))}
                </select>
                {(byZip.get(row.zip)?.length || 0) > 1 && <span style={{ ...muted, color: T.state.warning.fg }}>in conflict</span>}
                <span style={{ flex: 1 }} />
                <button style={btn} disabled={busy} onClick={() => removeRow(row)}>Remove</button>
              </div>
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
            const rows = (byLoc.get(l.id) || []).slice().sort((a, b) => a.zip.localeCompare(b.zip))
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
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                    {rows.map((row) => (
                      <span key={row.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', border: T.border.thin, borderRadius: T.radius.pill, padding: '2px 4px 2px 10px', fontSize: '12px', fontVariantNumeric: T.type.tabular }}>
                        {row.zip}
                        <button aria-label={`Remove ${row.zip} from ${l.name}`} disabled={busy} onClick={() => removeRow(row)} style={{ ...btn, border: 'none', padding: '0 6px', background: 'transparent', color: T.ink.muted }}>×</button>
                      </span>
                    ))}
                    {rows.length === 0 && <span style={muted}>No zips.</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
