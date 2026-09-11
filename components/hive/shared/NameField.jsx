// components/hive/shared/NameField.jsx
// ─────────────────────────────────────────────────────────────
// THE editable client name — one implementation, two mounts, both
// RECORD HEADERS: ClientProfile's header and EngagementPanel's
// masthead. Same person, different screen.
//
// Deliberately NOT mounted in the Inbox rows or the client-list rows
// (Kevin's ruling): those are dense worklists where a pencil per row is
// noise and a mis-click risk. And never anywhere the name is HISTORICAL
// — touchpoints, the audit trail — because those record what was true
// then, not what is true now.
//
// WHY IT EXISTS: Linda Dibias (North Jersey) asked how to update a
// client's name. She couldn't. Address, phone, email and description
// all had the inline pencil; the name never got one, so the only answer
// was "rename it in Jobber and the webhook will refresh it here" —
// which does nothing at all for a website lead that was never sent to
// Jobber and has no jobber_client_id.
//
// ── THREE FIELDS, NOT ONE ────────────────────────────────────────────
// The editor edits first / last / company — the three that map onto a
// Jobber client. The display name is DERIVED from them, server-side
// (lib/lead-name), so the two can't drift. Editing the single display
// string would mean splitting it back into first/last by guessing, and
// production is full of real records that guessing mangles: "Jerry &
// Carri Lamb", "Sue (Jason - House Manager) Loncar", "Deck Construction
// Group LLC". The preview line under the inputs shows exactly what the
// header will read, so nothing about the derivation is a surprise.
//
// ── AFFORDANCES ──────────────────────────────────────────────────────
// The shared inline-edit standard (shared/inlineEdit.jsx): always-
// visible readable ✎ in view mode, green-✓ / muted-✗ pair in edit mode,
// Enter saves, Esc cancels, in-flight disables both, a failed save keeps
// the edit OPEN with the draft and the inline error.
//
// DELIBERATE deviation from ContactField, matching AddressField: NO
// blur-save. This editor is multi-field — focus hops between first,
// last and company — so a blur-commit would fire mid-edit.
//
// NO WARNING BEFORE. There is no "this will also change it in Jobber"
// confirm, on purpose: a modal in front of a typo correction makes
// people hesitate over a typo. What happened is reported AFTER, in the
// toast and in the timeline, exactly the way the address does it.
//
// ── SAVE PATH, AND THE HONESTY RULE ──────────────────────────────────
// PATCH /api/leads/:id { first_name, last_name, company }. The route
// derives `name`, pushes to Jobber when there is a Jobber client to push
// to, and returns name_writeback. The toast tells the whole truth via
// nameSyncSuffix:
//   not linked        → 'Name updated · saved here — this client isn’t
//                        in Jobber yet'
//   linked + synced   → 'Name updated · synced to Jobber'
//   linked + rejected → 'Name updated · Jobber sync failed — saved in
//                        Bee Hub only', AND the toast is an ERROR toast.
//
// That last line is the point of the whole file. A Jobber rejection is
// never dressed as a success: nameSyncFailed picks the toast KIND, so
// the owner cannot see a green tick over a change that only half
// happened. beta-client-name-edit.test.ts mutation-tests exactly this —
// flipping the kind to 'success' fails the suite.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef } from 'react'
import { T } from './tokens'
import { EditPencil, InlineEditControls } from './inlineEdit'
import { composeLeadName, nameValidationError, nameSyncSuffix, nameSyncFailed } from '@/lib/lead-name'

const INPUT_STYLE = {
  minWidth: 0, padding: '5px 8px', border: T.border.control,
  borderRadius: T.radius.control, fontSize: '13px', fontFamily: 'inherit',
  color: T.ink.primary, background: T.surface.raised, outline: 'none',
  boxSizing: 'border-box', width: '100%',
}

export default function NameField({
  leadId,
  value,            // { name, first_name, last_name, company }
  onSaved = () => {},
  setToast = () => {},
  readOnly = false,
  jobberLinked = false,
  titleStyle = {},  // the host header's own type — see the mounts
  wrapAs = 'span',  // the host's own element: 'h2' on the engagement masthead
}) {
  const [editing, setEditing] = useState(false)
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')
  const [company, setCompany] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)

  const display = value?.name || composeLeadName(value || {})

  const open = () => {
    setFirst((value?.first_name || '').trim())
    setLast((value?.last_name || '').trim())
    setCompany((value?.company || '').trim())
    setErr(null)
    setEditing(true)
  }
  const cancel = () => { setErr(null); setEditing(false) }

  async function save() {
    if (saving.current) return
    const parts = { first_name: first.trim(), last_name: last.trim(), company: company.trim() }
    // A client must be CALLED something — the same check the route
    // enforces, run here so the owner gets it without a round trip.
    const invalid = nameValidationError(parts)
    if (invalid) { setErr(invalid); return }
    const next = composeLeadName(parts)
    const unchanged =
      parts.first_name === (value?.first_name || '').trim() &&
      parts.last_name === (value?.last_name || '').trim() &&
      parts.company === (value?.company || '').trim()
    if (unchanged) { cancel(); return } // no real change — no PATCH, no touchpoint

    saving.current = true
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parts),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.detail || j?.error || `HTTP ${res.status}`)
      setEditing(false)
      // The derived name comes BACK from the route (it owns the
      // derivation); compose locally only as a fallback so the optimistic
      // header never blanks.
      const cols = {
        first_name: parts.first_name || null,
        last_name: parts.last_name || null,
        company: parts.company || null,
        name: j?.lead?.name || next,
      }
      onSaved(cols, j)

      const wb = j?.name_writeback || null
      const suffix = jobberLinked
        ? nameSyncSuffix(wb)
        : ' · saved here — this client isn’t in Jobber yet'
      // THE HONESTY RULE. A Jobber rejection is an ERROR toast, never a
      // green tick over a half-applied change.
      setToast({ kind: nameSyncFailed(wb) ? 'error' : 'success', msg: `Name updated${suffix}` })
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
    // The preview says what the header will read, in the header's own
    // type — so the derivation ("first last", or the company when there
    // is no person) is visible before the save, not explained in prose.
    const preview = composeLeadName({ first_name: first, last_name: last, company })
    return (
      <div data-name-edit="1" onClick={e => e.stopPropagation()} style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: '5px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px' }}>
              <input autoFocus aria-label="First name" value={first} disabled={busy} placeholder="First name"
                onChange={e => { setFirst(e.target.value); if (err) setErr(null) }} onKeyDown={keys}
                style={INPUT_STYLE} />
              <input aria-label="Last name" value={last} disabled={busy} placeholder="Last name"
                onChange={e => { setLast(e.target.value); if (err) setErr(null) }} onKeyDown={keys}
                style={INPUT_STYLE} />
            </div>
            <input aria-label="Company" value={company} disabled={busy} placeholder="Company (optional)"
              onChange={e => { setCompany(e.target.value); if (err) setErr(null) }} onKeyDown={keys}
              style={INPUT_STYLE} />
            {preview && (
              <p data-name-preview="1" style={{ fontSize: T.badge.actionFont, color: T.ink.muted, margin: 0 }}>
                Shows as <span style={{ color: T.ink.primary, fontWeight: 600 }}>{preview}</span>
              </p>
            )}
          </div>
          <span style={{ paddingTop: '3px' }}>
            <InlineEditControls busy={busy} onSave={save} onCancel={cancel} />
          </span>
        </div>
        {err && <p style={{ fontSize: '11px', color: T.state.danger.fg, marginTop: '3px' }}>{err}</p>}
      </div>
    )
  }

  // View mode. The name keeps the host header's exact type — titleStyle
  // lands on the WRAPPER, and wrapAs lets the host keep its own element
  // (the EngagementPanel masthead is an <h2> and stays one, carrying its
  // 19px/600 inline exactly as before). This component supplies the
  // affordance, never a second type scale and never a second heading.
  //
  // The pencil is sized up from the 12px meta default: beside a 19px
  // title the meta size reads as dropped in from another row. 14px is
  // the step that sits with the headline — matched to the title it
  // stands next to, not to the address/phone rows further down the card.
  const Wrap = wrapAs
  return (
    <Wrap
      onClick={readOnly ? undefined : open}
      title={readOnly ? display : 'Edit name'}
      data-name-row="1"
      style={{
        minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: '7px',
        overflow: 'hidden', cursor: readOnly ? 'default' : 'text',
        ...titleStyle,
      }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {display}
      </span>
      {!readOnly && <EditPencil size={14} />}
    </Wrap>
  )
}
