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
import { composeLeadAddress, deriveStreet, formatLeadAddress, normalizeAddressKey, isRetiredAddress } from '@/lib/lead-address'
import { ADDRESS_LABELS, addressLabelText, DEFAULT_ADDRESS_LABEL, LABEL_NOTE_MAX } from '@/lib/address-labels'

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
  minWidth: 0, padding: '5px 8px', border: T.border.control,
  borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit',
  color: T.ink.primary, background: T.surface.raised, outline: 'none', boxSizing: 'border-box',
}

export default function AddressField({ leadId, value, onSaved = () => {}, setToast = () => {}, readOnly = false, jobberLinked = false, formerAddresses = [], addressLabel = null, addressLabelNote = null, onAddressesChanged = () => {} }) {
  // value: { address, city, state, zip } — the lead's four address columns,
  // the client's PRIMARY address.
  // jobberLinked: the client exists in Jobber, so a real change is pushed on
  // save. Unlinked, the save still lands here and the toast says plainly that
  // it went nowhere else.
  // formerAddresses: the client's OTHER addresses (see lib/lead-address) —
  // each live unless retired, each with its own label.
  //
  // THE PENCIL IS ALWAYS A CORRECTION. "Did they move?" is gone: three
  // intents now have three controls — pencil corrects, "+ Add address" adds,
  // "Stop using" retires. A move is add-then-retire.
  const [editing, setEditing] = useState(false)
  const [street, setStreet] = useState('')
  const [apt, setApt] = useState('')
  const [city, setCity] = useState('')
  const [stateVal, setStateVal] = useState('')
  const [zip, setZip] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)

  // ── the ADD form ───────────────────────────────────────────────
  const [adding, setAdding] = useState(false)
  const [aStreet, setAStreet] = useState('')
  const [aCity, setACity] = useState('')
  const [aState, setAState] = useState('')
  const [aZip, setAZip] = useState('')
  const [aLabel, setALabel] = useState(DEFAULT_ADDRESS_LABEL)
  const [aNote, setANote] = useState('')
  const [addErr, setAddErr] = useState(null)

  const openAdd = () => {
    setAStreet(''); setACity(''); setAState(''); setAZip('')
    setALabel(DEFAULT_ADDRESS_LABEL); setANote(''); setAddErr(null)
    setAdding(true)
  }
  const closeAdd = () => { setAddErr(null); setAdding(false) }

  // One endpoint for add / retire / restore / relabel. Retire and restore
  // are Bee Hub only — no Jobber call is made, by design: Jobber has no
  // archive, and its only alternative (delete) would take the property's
  // quotes and jobs with it.
  async function post(body) {
    const res = await fetch(`/api/leads/${leadId}/addresses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
    return j
  }

  async function saveAdd() {
    if (saving.current) return
    const st = aStreet.trim()
    if (!st) { setAddErr('Enter a street address'); return }
    if (aLabel === 'other' && !aNote.trim()) { setAddErr('Say what this address is'); return }
    saving.current = true; setBusy(true)
    try {
      const j = await post({
        action: 'add', street: st, city: aCity.trim(), state: aState.trim(), zip: aZip.trim(),
        label: aLabel, label_note: aLabel === 'other' ? aNote.trim() : null,
      })
      setAdding(false)
      onAddressesChanged(j.former_addresses || [])
      // Say what actually happened in Jobber — created, failed, or never
      // attempted because the client isn't there yet.
      const tail = j.jobber === 'created'
        ? ' \u00b7 added in Jobber too'
        : j.jobber === 'failed'
          ? ' \u00b7 saved here \u2014 Jobber didn\u2019t accept it'
          : ' \u00b7 saved here \u2014 this client isn\u2019t in Jobber yet'
      setToast({ kind: j.jobber === 'failed' ? 'error' : 'success', msg: `Address added${tail}` })
    } catch (e) {
      const msg = e.message === 'address_already_on_client'
        ? 'They already have that address'
        : e.message === 'other_label_requires_a_note'
          ? 'Say what this address is'
          : `Couldn\u2019t add: ${e.message}`
      setAddErr(msg)
      setToast({ kind: 'error', msg })
    } finally { saving.current = false; setBusy(false) }
  }

  async function entryAction(action, index) {
    if (saving.current) return
    saving.current = true; setBusy(true)
    try {
      const j = await post({ action, index })
      onAddressesChanged(j.former_addresses || [])
      setToast({
        kind: 'success',
        msg: action === 'retire'
          // Honest about the asymmetry: Jobber keeps it, we stop offering it.
          ? 'Address retired here \u2014 it stays in Jobber with its history'
          : 'Address back in use',
      })
    } catch (e) {
      setToast({ kind: 'error', msg: `Couldn\u2019t update: ${e.message}` })
    } finally { saving.current = false; setBusy(false) }
  }

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
  const cancel = () => { setErr(null); setEditing(false) }

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
    // Straight to the save. The push to Jobber happens server-side ON SAVE
    // (never while typing) for a linked client, and the toast reports what
    // actually landed.
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
      setEditing(false)
      onSaved(cols, j)
      const verb = !display ? 'added' : !cols.address ? 'removed' : 'updated'
      // An edit on a client who isn't in Jobber yet saved HERE and nowhere
      // else. Say it, rather than letting a bare "Address updated" imply a
      // sync that never happened — that silence is the desync owners have
      // been living with.
      // A CLEAR never pushes (we don't erase Jobber-side data), so it makes
      // no claim either way. Otherwise: a linked client reports what actually
      // landed; an unlinked one says plainly that the save stopped here —
      // that silence was the desync owners have been living with.
      const suffix = !cols.address
        ? ''
        : jobberLinked
          ? syncSuffix(j?.address_writeback)
          : ' · saved here — this client isn\u2019t in Jobber yet'
      setToast({ kind: 'success', msg: `Address ${verb}${suffix}` })
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

  // ── THE CLIENT'S OTHER ADDRESSES ────────────────────────────────
  // A live list, not history. Each row carries its label so an owner can
  // tell which house is which, and each can be retired — which hides it
  // HERE and changes nothing in Jobber. Absent entirely for a client with
  // one address: that screen is exactly as it was.
  const labelPill = (text) => text ? (
    <span style={{
      fontSize: '10px', fontWeight: 600, color: T.ink.muted, background: T.surface.sunken,
      padding: '1px 6px', borderRadius: T.radius.pill, marginLeft: '6px', whiteSpace: 'nowrap',
    }}>{text}</span>
  ) : null

  const primaryLabelText = addressLabelText(addressLabel, addressLabelNote)

  const otherRows = (Array.isArray(formerAddresses) ? formerAddresses : []).map((f, i) => {
    const retired = isRetiredAddress(f)
    const text = addressLabelText(f.label, f.label_note)
    return (
      <div key={`${f.display}-${i}`} data-address-entry={i} data-address-retired={retired ? '1' : '0'}
        style={{ display: 'flex', alignItems: 'baseline', gap: '4px', margin: '2px 0 0' }}>
        <span title={f.display} style={{
          fontSize: '11.5px', lineHeight: 1.5, minWidth: 0,
          color: retired ? T.ink.disabled : T.ink.quiet,
          textDecoration: retired ? 'line-through' : 'none',
        }}>{f.display}</span>
        {labelPill(text)}
        {retired && <span style={{ fontSize: '10px', color: T.ink.disabled }}>No longer used</span>}
        {!readOnly && (
          <button type="button" disabled={busy} data-address-action={retired ? 'restore' : 'retire'}
            onClick={() => entryAction(retired ? 'restore' : 'retire', i)}
            style={{
              marginLeft: 'auto', padding: 0, background: 'none', border: 'none', flexShrink: 0,
              color: T.ink.muted, fontFamily: 'inherit', fontSize: '11px',
              cursor: busy ? 'not-allowed' : 'pointer', textDecoration: 'underline',
            }}>
            {retired ? 'Use again' : 'Stop using'}
          </button>
        )}
      </div>
    )
  })

  // One quiet heading rather than repeating "Other address:" on every row —
  // the rows now carry their own labels, and the heading still gives an
  // UNLABELLED entry (anything written before the five labels existed) the
  // context the old per-row prefix carried.
  const othersBlock = otherRows.length > 0 ? (
    <div data-meta-row="former-addresses" style={{ paddingLeft: '20px', marginTop: '3px' }}>
      <p style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase', color: T.ink.muted, margin: '0 0 1px' }}>
        Other addresses
      </p>
      {otherRows}
    </div>
  ) : null

  // ── THE ADD FORM ────────────────────────────────────────────────
  // Explicit. No question about intent, and no inference from the shape of
  // an edit. A second address becomes its own Jobber property on save.
  const addBlock = adding ? (
    <div data-address-add="1" onClick={e => e.stopPropagation()}
      style={{ marginLeft: '20px', marginTop: '6px', border: T.border.thin, borderRadius: '10px', padding: '10px 11px', background: T.surface.raised }}>
      <p style={{ fontSize: '12px', fontWeight: 600, color: T.ink.primary, marginBottom: '7px' }}>Add another address</p>
      <div style={{ display: 'grid', gap: '5px' }}>
        <AddressAutofill
          value={aStreet}
          onChange={v => { setAStreet(v); if (addErr) setAddErr(null) }}
          onParsed={p => {
            setAStreet(p.street || p.full || '')
            setACity(p.city || ''); setAState(p.state || ''); setAZip(p.zip || '')
          }}
          placeholder="Start typing a street address…"
          style={{ ...INPUT_STYLE, width: '100%' }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '5px' }}>
          <input aria-label="City" value={aCity} disabled={busy} placeholder="City"
            onChange={e => setACity(e.target.value)} style={INPUT_STYLE} />
          <input aria-label="State" value={aState} disabled={busy} placeholder="ST"
            onChange={e => setAState(e.target.value)} style={INPUT_STYLE} />
          <input aria-label="ZIP" value={aZip} disabled={busy} placeholder="ZIP"
            onChange={e => setAZip(e.target.value)} style={INPUT_STYLE} />
        </div>
        {/* The fixed five. Not free text — see lib/address-labels. */}
        <div role="radiogroup" aria-label="What is this address?" data-address-labels="1"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
          {ADDRESS_LABELS.map(opt => (
            <button key={opt.value} type="button" role="radio" aria-checked={aLabel === opt.value}
              data-address-label={opt.value} disabled={busy}
              onClick={() => setALabel(opt.value)}
              style={{
                padding: '4px 9px', borderRadius: T.radius.pill, fontFamily: 'inherit', fontSize: '11.5px',
                cursor: busy ? 'not-allowed' : 'pointer',
                border: aLabel === opt.value ? `1px solid ${T.accent.fg}` : T.border.control,
                background: aLabel === opt.value ? T.accent.soft : T.surface.raised,
                color: aLabel === opt.value ? T.accent.deep : T.ink.muted,
                fontWeight: aLabel === opt.value ? 600 : 400,
              }}>{opt.text}</button>
          ))}
        </div>
        {aLabel === 'other' && (
          <input aria-label="What is this address?" value={aNote} disabled={busy}
            placeholder="What is it? e.g. Mum&#39;s house" maxLength={LABEL_NOTE_MAX}
            onChange={e => { setANote(e.target.value); if (addErr) setAddErr(null) }}
            style={{ ...INPUT_STYLE, width: '100%' }} />
        )}
      </div>
      {addErr && <p style={{ fontSize: '11px', color: T.state.danger.fg, marginTop: '5px' }}>{addErr}</p>}
      <div style={{ display: 'flex', gap: '7px', justifyContent: 'flex-end', marginTop: '8px' }}>
        <button type="button" disabled={busy} onClick={closeAdd}
          style={{ padding: '5px 10px', background: 'none', border: 'none', color: T.ink.muted, fontFamily: 'inherit', fontSize: '12px', cursor: 'pointer' }}>Cancel</button>
        <button type="button" disabled={busy} onClick={saveAdd}
          style={{
            padding: '5px 12px', borderRadius: T.radius.control, border: 'none', fontFamily: 'inherit',
            fontSize: '12px', fontWeight: 500, background: T.accent.fg, color: T.accent.onFill,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}>{busy ? 'Adding…' : 'Add address'}</button>
      </div>
    </div>
  ) : null

  const addLink = (!readOnly && !adding && display) ? (
    <p style={{ paddingLeft: '20px', margin: '3px 0 0' }}>
      <button type="button" data-address-add-open="1" onClick={openAdd}
        style={{ padding: 0, background: 'none', border: 'none', color: T.ink.muted, fontFamily: 'inherit', fontSize: '11.5px', cursor: 'pointer' }}>
        + Add address
      </button>
    </p>
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
      {labelPill(primaryLabelText)}
      {!readOnly && <EditPencil />}
    </p>
    {othersBlock}
    {addLink}
    {addBlock}
    </>
  ) : readOnly ? null : (
    <p onClick={open} data-meta-row="address"
      style={{ ...metaRowStyle({ tone: 'faint' }), cursor: 'text' }}>
      <span style={{ ...metaIconStyle, color: 'inherit' }}><IconMapPin size={META_ICON} /></span>
      <span style={metaAddStyle}>add address</span>
    </p>
  )
}
