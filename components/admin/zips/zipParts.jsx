// components/admin/zips/zipParts.jsx
// ─────────────────────────────────────────────────────────────
// The pieces of zip-list editing, shared by BOTH places zips are shown:
//   • AdminZipCodesScreen — Admin → Zip codes, every location (corporate)
//   • LocationZipsPanel   — one location's Territory, on its own pages
//                           (corporate edits, the owner views)
// One set of actions, one set of rows, one set of words — so the two screens
// cannot drift apart. Every write goes to /api/admin/location-zips, which
// refuses anyone but corporate on the server; hiding a control here is
// presentation, never the permission.
//
// Tokens only (T.*), no color literal — swept by the zip screen tests.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from '@/components/hive/shared/tokens'

export const ZIPS_API = '/api/admin/location-zips'

export const zipStyles = {
  card: {
    background: T.surface.raised,
    border: T.border.card,
    borderRadius: T.radius.card,
    padding: '14px 16px',
    marginBottom: '12px',
  },
  input: {
    border: T.border.control,
    borderRadius: T.radius.control,
    padding: '7px 10px',
    fontSize: '13px',
    fontFamily: 'inherit',
    color: T.ink.primary,
    background: T.surface.raised,
  },
  btn: {
    border: T.border.control,
    borderRadius: T.radius.control,
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: 'inherit',
    cursor: 'pointer',
    background: T.surface.raised,
    color: T.ink.primary,
  },
  muted: { fontSize: '12px', color: T.ink.muted },
  zipText: { fontWeight: 600, fontVariantNumeric: T.type.tabular, minWidth: '52px' },
}
zipStyles.btnPrimary = { ...zipStyles.btn, border: 'none', background: T.accent.fg, color: T.accent.onFill }
const { card, input, btn, btnPrimary, muted, zipText } = zipStyles

export async function zipSend(method, url, body) {
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
export function sayZipError(code) {
  switch (code) {
    case 'invalid_zip': return 'That isn’t a five-digit zip.'
    case 'already_assigned': return 'That location already has this zip.'
    case 'cannot_assign_to_loc_other': return 'Zips can’t be given to Other — leave the zip off the list instead.'
    case 'location_not_found': return 'That location no longer exists.'
    case 'not_in_conflict': return 'That zip is no longer in conflict — refresh to see the current list.'
    case 'forbidden': return 'Only corporate can change a territory.'
    default: return `Couldn’t save (${code}).`
  }
}

// add / move / remove / resolve, with the busy flag and the result message.
// `reload` refetches whichever list the caller shows; `locName` names a
// location id for the confirm and result sentences.
export function useZipActions({ reload, locName }) {
  const [msg, setMsg] = useState(null) // { kind: 'ok' | 'warn' | 'error', text }
  const [busy, setBusy] = useState(false)

  const run = async (fn, okText) => {
    setBusy(true); setMsg(null)
    try {
      const res = await fn()
      await reload()
      setMsg(res?.conflict
        ? { kind: 'warn', text: `${okText} Another location also has this zip, so it will go to Other until one of them is removed.` }
        : { kind: 'ok', text: okText })
      return true
    } catch (e) {
      setMsg({ kind: 'error', text: sayZipError(e.message) })
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    msg, busy,
    add: (zip, locationId) =>
      run(() => zipSend('POST', ZIPS_API, { zip, location_uuid: locationId }), `Added ${zip} to ${locName(locationId)}.`),
    move: (row, toId) =>
      run(() => zipSend('PATCH', ZIPS_API, { id: row.id, location_uuid: toId }), `Moved ${row.zip} to ${locName(toId)}.`),
    remove: (row) => {
      if (!window.confirm(`Remove ${row.zip} from ${locName(row.location_uuid)}?`)) return Promise.resolve(false)
      return run(() => zipSend('DELETE', `${ZIPS_API}?id=${encodeURIComponent(row.id)}`), `Removed ${row.zip} from ${locName(row.location_uuid)}.`)
    },
    resolve: (zip, keepId) => {
      if (!window.confirm(`Give ${zip} to ${locName(keepId)} only? The other location loses it.`)) return Promise.resolve(false)
      return run(() => zipSend('POST', `${ZIPS_API}/resolve`, { zip, location_uuid: keepId }), `${zip} now goes to ${locName(keepId)}.`)
    },
  }
}

export function ZipMessage({ msg }) {
  if (!msg) return null
  const color = msg.kind === 'error' ? T.state.danger.fg : msg.kind === 'warn' ? T.state.warning.fg : T.state.success.fg
  return <div role="status" style={{ ...card, color, padding: '10px 16px' }}>{msg.text}</div>
}

const locLabel = (l) => `${l.name}${l.lifecycle_status !== 'active' ? ' (not live)' : ''}`

// One conflicted zip: who claims it, and (corporate only) a Give-to button
// per claimant. `claimants` = [{ location_uuid, name, row_id? }].
export function ZipConflictRow({ zip, claimants, canEdit, busy, onResolve }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '8px 0', borderTop: T.border.divider }}>
      <span style={zipText}>{zip}</span>
      <span style={muted}>{claimants.map((c) => c.name).join(' vs ')}</span>
      <span style={{ flex: 1 }} />
      {canEdit && claimants.map((c) => (
        <button key={c.location_uuid} style={btn} disabled={busy} onClick={() => onResolve(zip, c.location_uuid)}>
          Give to {c.name}
        </button>
      ))}
    </div>
  )
}

// Zip box + Add. With `locations`, a location picker; with `fixedLocationId`,
// the zip goes to that one location and there is no picker.
export function ZipAddForm({ locations = [], fixedLocationId = null, busy, onAdd }) {
  const [zip, setZip] = useState('')
  const [loc, setLoc] = useState('')
  const target = fixedLocationId || loc
  const submit = async () => {
    const z = zip.trim()
    if (!z || !target) return
    const ok = await onAdd(z, target)
    if (ok) setZip('')
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
      <input
        aria-label="Zip code"
        placeholder="Zip"
        inputMode="numeric"
        maxLength={10}
        value={zip}
        onChange={(e) => setZip(e.target.value)}
        style={{ ...input, width: '90px' }}
      />
      {!fixedLocationId && (
        <select aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)} style={{ ...input, minWidth: '200px' }}>
          <option value="">Choose a location…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
        </select>
      )}
      <button style={btnPrimary} disabled={busy || !zip.trim() || !target} onClick={submit}>Add</button>
    </div>
  )
}

// A found zip row: move it (location picker) or remove it.
export function ZipEditRow({ row, locations, inConflict, busy, onMove, onRemove }) {
  const known = locations.some((l) => l.id === row.location_uuid)
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '6px 0', borderTop: T.border.divider }}>
      <span style={zipText}>{row.zip}</span>
      <select
        aria-label={`Location for ${row.zip}`}
        value={row.location_uuid}
        disabled={busy}
        onChange={(e) => onMove(row, e.target.value)}
        style={{ ...input, minWidth: '200px' }}
      >
        {!known && <option value={row.location_uuid}>Unknown location</option>}
        {locations.map((l) => <option key={l.id} value={l.id}>{locLabel(l)}</option>)}
      </select>
      {inConflict && <span style={{ ...muted, color: T.state.warning.fg }}>in conflict</span>}
      <span style={{ flex: 1 }} />
      <button style={btn} disabled={busy} onClick={() => onRemove(row)}>Remove</button>
    </div>
  )
}

// A location's zips as chips, sorted. `onRemove` present → an × per chip
// (corporate); absent → read-only. `conflicted` marks chips in conflict.
export function ZipChips({ rows, locationName, conflicted = new Set(), busy, onRemove = null }) {
  const sorted = rows.slice().sort((a, b) => a.zip.localeCompare(b.zip))
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }} data-testid="zip-chips">
      {sorted.map((row) => {
        const hot = conflicted.has(row.zip)
        return (
          <span
            key={row.id}
            data-conflict={hot ? 'true' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              border: hot ? `1px solid ${T.state.warning.fg}` : T.border.thin,
              background: hot ? T.state.warning.soft : 'transparent',
              borderRadius: T.radius.pill,
              padding: onRemove ? '2px 4px 2px 10px' : '2px 10px',
              fontSize: '12px', fontVariantNumeric: T.type.tabular,
            }}
          >
            {row.zip}
            {onRemove && (
              <button
                aria-label={`Remove ${row.zip} from ${locationName}`}
                disabled={busy}
                onClick={() => onRemove(row)}
                style={{ ...btn, border: 'none', padding: '0 6px', background: 'transparent', color: T.ink.muted }}
              >×</button>
            )}
          </span>
        )
      })}
      {sorted.length === 0 && <span style={muted}>No zips.</span>}
    </div>
  )
}
