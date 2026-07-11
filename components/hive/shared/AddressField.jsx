// components/hive/shared/AddressField.jsx
// ─────────────────────────────────────────────────────────────
// THE editable address row — one implementation, two mounts:
// ClientProfile Key Facts + EngagementPanel Key Facts (the ContactField
// pattern, applied to the four address columns). Affordances follow the
// shared inline-edit standard (shared/inlineEdit.jsx): always-visible
// readable ✎ in view mode; edit mode gains the green-✓ / muted-✗ pair;
// in-flight disables everything; a failed save keeps the edit open with
// the inline error and the draft intact.
//
// View mode renders formatLeadAddress — the normalized display (the
// stored `address` string usually already contains city/state/zip; only
// missing parts are appended, never duplicates).
//
// Edit mode is the SAME Places autocomplete the classic side uses
// (shared/AddressAutofill) on the street line: pick a prediction and
// the parsed {street, city, state, zip} fills the part fields;
// manual typing stays a first-class fallback (Places errors and a
// missing GOOGLE_PLACES_API_KEY degrade to a plain text input).
//
// DELIBERATE deviation from ContactField: NO blur-save. This editor is
// multi-field — focus hops between street/city/state/zip and onto the
// autocomplete dropdown, so a blur-commit would fire mid-edit. Save is
// explicit: ✓ or Enter; Esc or ✗ cancels.
//
// Save path: PATCH /api/leads/:id { address, city, state, zip } —
// `address` is composeLeadAddress's full string (the import's storage
// convention). The route writes the audit touchpoint, keeps the
// addresses jsonb coherent, and — for Jobber-linked leads — pushes the
// BILLING address AND (managed blast radius: exactly-one-property
// clients only) the PROPERTY/service address. The toast tells the
// whole truth from address_writeback { billing, property }:
//   both/either synced   → '· synced to Jobber'
//   multiple properties  → '· synced to Jobber billing — client has
//                           multiple properties, service address not
//                           changed' (deliberate skip, said out loud)
//   one target failed    → '· Jobber sync partial — …'
//   nothing landed       → '· Jobber sync failed — saved in Bee Hub only'
//   not linked/all no-op → plain 'Address updated'
// Clearing all fields is allowed ('Address removed') — Bee Hub only;
// the write-back never deletes Jobber-side data by design.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef } from 'react'
import { IconMapPin } from '@/components/ui/icons'
import { EditPencil, InlineEditControls } from './inlineEdit'
import AddressAutofill from './AddressAutofill'
import { composeLeadAddress, deriveStreet, formatLeadAddress, normalizeAddressKey } from '@/lib/lead-address'

// The whole-truth suffix from the per-target write-back outcomes.
// Exported for the toast-truth tests.
export function syncSuffix(wb) {
  if (!wb) return ''
  const bOk = wb.billing === 'updated' || wb.billing === 'added'
  const bFail = wb.billing === 'failed'
  const pOk = wb.property === 'updated'
  const pFail = wb.property === 'failed'
  if (wb.property === 'skipped_multiple') {
    // The deliberate skip is said out loud (policy) — unless billing
    // ALSO failed, in which case nothing landed at all.
    return bFail
      ? ' · Jobber sync failed — saved in Bee Hub only'
      : ' · synced to Jobber billing — client has multiple properties, service address not changed'
  }
  if (bFail && pFail) return ' · Jobber sync failed — saved in Bee Hub only'
  if (pFail) return ' · Jobber sync partial — billing synced, service address failed'
  if (bFail) {
    return pOk
      ? ' · Jobber sync partial — service address synced, billing failed'
      : ' · Jobber sync failed — saved in Bee Hub only'
  }
  if (bOk || pOk) return ' · synced to Jobber'
  return '' // everything already converged — no claim to make
}

const INPUT_STYLE = {
  minWidth: 0, padding: '5px 8px', border: '0.5px solid rgba(0,0,0,0.15)',
  borderRadius: '6px', fontSize: '12px', fontFamily: 'inherit',
  color: '#1a1a18', background: '#fff', outline: 'none', boxSizing: 'border-box',
}

export default function AddressField({ leadId, value, onSaved = () => {}, setToast = () => {} }) {
  // value: { address, city, state, zip } — the lead's four address columns.
  const [editing, setEditing] = useState(false)
  const [street, setStreet] = useState('')
  const [city, setCity] = useState('')
  const [stateVal, setStateVal] = useState('')
  const [zip, setZip] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)

  const display = formatLeadAddress(value)

  const open = () => {
    // Prefill the parts: street is the stored full string minus the part
    // columns (deriveStreet) — a legacy street-only row lands unchanged.
    setStreet(deriveStreet(value?.address, value || {}))
    setCity((value?.city || '').trim())
    setStateVal((value?.state || '').trim())
    setZip((value?.zip || '').trim())
    setErr(null)
    setEditing(true)
  }
  const cancel = () => { setErr(null); setEditing(false) }

  async function save() {
    if (saving.current) return
    const s = street.trim(), c = city.trim(), st = stateVal.trim(), z = zip.trim()
    if (!s && (c || st || z)) { setErr('Enter a street address'); return } // parts without a street is junk
    const composed = composeLeadAddress({ street: s, city: c, state: st, zip: z })
    if (normalizeAddressKey(composed) === normalizeAddressKey(display)) { cancel(); return } // no real change
    saving.current = true
    setBusy(true)
    try {
      const cols = { address: composed || null, city: c || null, state: st || null, zip: z || null }
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cols),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setEditing(false)
      onSaved(cols, j)
      const verb = !display ? 'added' : !composed ? 'removed' : 'updated'
      setToast({ kind: 'success', msg: `Address ${verb}${syncSuffix(j?.address_writeback)}` })
    } catch (e) {
      // The standard: never silently drop a draft — stay open with the error.
      setErr(`Save failed: ${e.message}`)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  const keys = (e) => {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') cancel()
  }

  if (editing) {
    return (
      <div onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
          <span style={{ color: '#8a8a84', display: 'inline-flex', flexShrink: 0, paddingTop: '6px' }}><IconMapPin size={13} /></span>
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: '5px' }}>
            <AddressAutofill
              value={street}
              onChange={v => { setStreet(v); if (err) setErr(null) }}
              onParsed={p => {
                // Autocomplete pick → parsed fields. Unit rides the street line.
                setStreet([p.street, p.apt].filter(Boolean).join(' ') || p.full || '')
                setCity(p.city || '')
                setStateVal(p.state || '')
                setZip(p.zip || '')
              }}
              placeholder="Start typing a street address…"
              style={{ ...INPUT_STYLE, width: '100%' }}
              onKeyDown={keys}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '5px' }}>
              <input aria-label="City" value={city} disabled={busy} placeholder="City"
                onChange={e => { setCity(e.target.value); if (err) setErr(null) }} onKeyDown={keys} style={INPUT_STYLE} />
              <input aria-label="State" value={stateVal} disabled={busy} placeholder="ST"
                onChange={e => { setStateVal(e.target.value); if (err) setErr(null) }} onKeyDown={keys} style={INPUT_STYLE} />
              <input aria-label="ZIP" value={zip} disabled={busy} placeholder="ZIP"
                onChange={e => { setZip(e.target.value); if (err) setErr(null) }} onKeyDown={keys} style={INPUT_STYLE} />
            </div>
          </div>
          <span style={{ paddingTop: '3px' }}>
            <InlineEditControls busy={busy} onSave={save} onCancel={cancel} />
          </span>
        </div>
        {err && <p style={{ fontSize: '11px', color: '#791F1F', marginTop: '3px', paddingLeft: '20px' }}>{err}</p>}
      </div>
    )
  }

  return display ? (
    <p onClick={open} title="Edit address"
      style={{ fontSize: '12px', color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, cursor: 'text' }}>
      <span style={{ color: '#8a8a84', display: 'inline-flex', flexShrink: 0 }}><IconMapPin size={13} /></span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{display}</span>
      <EditPencil />
    </p>
  ) : (
    <p onClick={open} style={{ fontSize: '12px', color: '#c9c7c0', display: 'flex', alignItems: 'center', gap: '7px', cursor: 'text' }}>
      <span style={{ display: 'inline-flex' }}><IconMapPin size={13} /></span>
      <span style={{ borderBottom: '1px dashed rgba(0,0,0,0.15)' }}>add address</span>
    </p>
  )
}
