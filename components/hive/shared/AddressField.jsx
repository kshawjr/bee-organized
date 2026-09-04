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
// Apt/Suite is a DISCRETE field (issue 133, the NetworkAddSheet
// pattern): Google rarely returns a subpremise for a hand-typed unit,
// so a unit typed into the street line used to be silently replaced by
// the prediction. The discrete field is merge-safe on a pick — Google's
// real subpremise wins when present, the typed unit survives when it
// isn't, and the autocomplete-failure fallback parse never clobbers it.
// The unit rides the street line into storage (no new column), and we
// NEVER parse it back out of a stored street string (the issue 93
// lesson) — on edit-open the field starts empty and any embedded unit
// stays part of the street text.
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
import { T } from './tokens'
import { EditPencil, InlineEditControls } from './inlineEdit'
import { metaRowStyle, metaIconStyle, metaValueStyle, metaAddStyle, META_ICON } from './metaRow'
import AddressAutofill from './AddressAutofill'
import { composeLeadAddress, deriveStreet, formatLeadAddress, normalizeAddressKey } from '@/lib/lead-address'

// The whole-truth suffix from the per-target write-back outcomes.
// Exported for the toast-truth tests.
// Toast suffix for a MOVE's Jobber outcome (mirrors syncSuffix's honesty:
// what landed is said, what failed is said louder).
export function moveSuffix(mv) {
  if (!mv) return ''
  if (mv.created) {
    return mv.billing === 'failed'
      ? ' · new Jobber property added (billing update failed)'
      : ' · new Jobber property added — the old one and its history are untouched'
  }
  if (mv.error) return ' · saved here — Jobber property could not be added'
  return ''
}

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
  minWidth: 0, padding: '5px 8px', border: T.border.control,
  borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit',
  color: T.ink.primary, background: T.surface.raised, outline: 'none', boxSizing: 'border-box',
}

export default function AddressField({ leadId, value, onSaved = () => {}, setToast = () => {}, readOnly = false, jobberLinked = false, formerAddresses = [] }) {
  // value: { address, city, state, zip } — the lead's four address columns.
  // jobberLinked: the client exists in Jobber, so a REAL address change has
  // to ask move-or-correction before anything is pushed (the two cannot be
  // told apart mechanically — a move across the street diffs like a typo).
  // formerAddresses: addresses this client moved away from, rendered as
  // read-only history under the current one.
  const [editing, setEditing] = useState(false)
  // The move-or-correction question, armed with the cols the save built.
  const [choice, setChoice] = useState(null) // null | { cols }
  const [street, setStreet] = useState('')
  const [apt, setApt] = useState('')
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
    // Apt starts EMPTY on purpose — a unit already embedded in the
    // stored street line stays there; extracting it back out would be
    // the issue 93 combined-string parse we don't do.
    setApt('')
    setCity((value?.city || '').trim())
    setStateVal((value?.state || '').trim())
    setZip((value?.zip || '').trim())
    setErr(null)
    setEditing(true)
  }
  const cancel = () => { setErr(null); setChoice(null); setEditing(false) }

  async function save() {
    if (saving.current) return
    const s = street.trim(), a = apt.trim(), c = city.trim(), st = stateVal.trim(), z = zip.trim()
    if (!s && (a || c || st || z)) { setErr('Enter a street address'); return } // parts without a street is junk
    // The unit rides the street line into storage (issue 133) — same
    // convention as NetworkAddSheet; there is no apt column.
    const streetLine = [s, a].filter(Boolean).join(' ')
    const composed = composeLeadAddress({ street: streetLine, city: c, state: st, zip: z })
    if (normalizeAddressKey(composed) === normalizeAddressKey(display)) { cancel(); return } // no real change
    const cols = { address: composed || null, city: c || null, state: st || null, zip: z || null }
    // ASK ONLY WHEN IT MATTERS: a Jobber-linked client, a real change, and
    // an actual previous address being replaced by an actual new one. First
    // addresses, removals, unlinked clients and formatting-only edits (the
    // bail above) never see the question.
    if (jobberLinked && display && composed) {
      setChoice({ cols })
      return
    }
    await doSave(cols, null)
  }

  async function doSave(cols, mode) {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode ? { ...cols, address_change: mode } : cols),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setChoice(null)
      setEditing(false)
      onSaved(cols, j)
      if (mode === 'move') {
        setToast({ kind: 'success', msg: `Address updated — old address kept on file${moveSuffix(j?.address_move)}` })
      } else {
        const verb = !display ? 'added' : !cols.address ? 'removed' : 'updated'
        setToast({ kind: 'success', msg: `Address ${verb}${syncSuffix(j?.address_writeback)}` })
      }
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

  if (editing && choice) {
    // ── MOVE OR CORRECTION ─────────────────────────────────────────
    // Owner-facing, asked once per qualifying save. The two paths do
    // different things to Jobber history and cannot be told apart from
    // the text of the edit — so the person who knows says which it is.
    const btn = (primary) => ({
      display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
      padding: '9px 12px', borderRadius: '9px', fontFamily: 'inherit',
      border: primary ? `1.5px solid ${T.accent.fg}` : T.border.control,
      background: primary ? T.accent.soft : T.surface.raised,
    })
    return (
      <div onClick={e => e.stopPropagation()} style={{ border: T.border.thin, borderRadius: '10px', padding: '11px 12px', background: T.surface.raised }}>
        <p style={{ fontSize: '13.5px', fontWeight: 700, color: T.ink.primary, marginBottom: '2px' }}>Did they move?</p>
        <p style={{ fontSize: '12px', color: T.ink.secondary, lineHeight: 1.5, marginBottom: '9px' }}>
          This client is connected to Jobber, so it matters which kind of change this is.
        </p>
        <div style={{ display: 'grid', gap: '6px' }}>
          <button type="button" disabled={busy} onClick={() => doSave(choice.cols, 'move')} style={btn(true)}>
            <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: T.ink.primary }}>They moved</span>
            <span style={{ display: 'block', fontSize: '11.5px', color: T.ink.secondary, lineHeight: 1.45 }}>
              Keeps the old address and its job history in Jobber. The new address starts fresh.
            </span>
          </button>
          <button type="button" disabled={busy} onClick={() => doSave(choice.cols, 'correction')} style={btn(false)}>
            <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: T.ink.primary }}>Just fixing the address</span>
            <span style={{ display: 'block', fontSize: '11.5px', color: T.ink.secondary, lineHeight: 1.45 }}>
              Corrects it everywhere, including Jobber. Nothing extra is kept.
            </span>
          </button>
        </div>
        <button type="button" disabled={busy} onClick={() => setChoice(null)}
          style={{ marginTop: '8px', padding: 0, background: 'none', border: 'none', color: T.ink.muted, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' }}>
          Go back
        </button>
        {err && <p style={{ fontSize: '11px', color: T.state.danger.fg, marginTop: '6px' }}>{err}</p>}
      </div>
    )
  }

  if (editing) {
    return (
      <div onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
          <span style={{ color: T.ink.muted, display: 'inline-flex', flexShrink: 0, paddingTop: '6px' }}><IconMapPin size={13} /></span>
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: '5px' }}>
            <AddressAutofill
              value={street}
              onChange={v => { setStreet(v); if (err) setErr(null) }}
              onParsed={p => {
                // Autocomplete pick → parsed fields. The unit is merge-safe
                // (issue 133): Google's real subpremise wins; a typed unit
                // survives when the prediction has none (the common case) —
                // and the fallback parse carries no apt key, so it can
                // never clobber a typed unit either.
                setStreet(p.street || p.full || '')
                setApt(a => p.apt || a)
                setCity(p.city || '')
                setStateVal(p.state || '')
                setZip(p.zip || '')
              }}
              placeholder="Start typing a street address…"
              style={{ ...INPUT_STYLE, width: '100%' }}
              onKeyDown={keys}
            />
            <input aria-label="Apt" value={apt} disabled={busy} placeholder="Apt / Suite (optional)"
              onChange={e => { setApt(e.target.value); if (err) setErr(null) }} onKeyDown={keys}
              style={{ ...INPUT_STYLE, width: '100%' }} />
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
        {err && <p style={{ fontSize: '11px', color: T.state.danger.fg, marginTop: '3px', paddingLeft: '20px' }}>{err}</p>}
      </div>
    )
  }

  // The client's OTHER addresses. Read-only here, never editable from the
  // card, absent entirely in the common one-address case — the screen with
  // one address is unchanged.
  //
  // These arrive via the move flow, so the column is named former_addresses
  // and the first wording was "Previously: … · moved Sep 2026". That reads
  // as history, and history is exactly what it often isn't: Jobber keeps
  // every property live and bookable, so a client who moves can have work
  // running at both houses (Heather Popelka, North Pittsburgh, with an open
  // quote at the address filed as former). "Other address" is true either
  // way — moved out, or keeping both — and the "moved" date goes with it,
  // since it dated a departure that may not have happened.
  const formerBlock = Array.isArray(formerAddresses) && formerAddresses.length > 0 ? (
    <div data-meta-row="former-addresses" style={{ paddingLeft: '20px' }}>
      {formerAddresses.map((f, i) => (
        <p key={`${f.display}-${i}`} style={{ fontSize: '11.5px', color: T.ink.quiet, margin: '1px 0 0', lineHeight: 1.5 }}>
          Other address: <span title={f.display}>{f.display}</span>
        </p>
      ))}
    </div>
  ) : null

  return display ? (
    <>
    <p onClick={readOnly ? undefined : open} title={readOnly ? undefined : 'Edit address'}
      data-meta-row="address"
      style={{ ...metaRowStyle(), cursor: readOnly ? 'default' : 'text' }}>
      <span style={metaIconStyle}><IconMapPin size={META_ICON} /></span>
      {/* title on the VALUE span, not just the row: the child's title
          wins within its own box, so hovering the clipped text reveals
          the full address while the row keeps its edit affordance (issue 118). */}
      <span style={metaValueStyle} title={display}>{display}</span>
      {!readOnly && <EditPencil />}
    </p>
    {formerBlock}
    </>
  ) : readOnly ? null : (
    <p onClick={open} data-meta-row="address"
      style={{ ...metaRowStyle({ tone: 'faint' }), cursor: 'text' }}>
      <span style={{ ...metaIconStyle, color: 'inherit' }}><IconMapPin size={META_ICON} /></span>
      <span style={metaAddStyle}>add address</span>
    </p>
  )
}
