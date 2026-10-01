// components/hive/TransferLeadModal.jsx
// ─────────────────────────────────────────────────────────────
// Corp/admin moves a lead to a REAL location. Built for a loc_other
// global-form lead (the unrouted queue); since 1 Oct 2026 it also moves a
// lead that ALREADY HAS A HOME, from the card's ··· menu. Same picker, same
// endpoint. What a lead with a home changes — all of it driven by one prop,
// `from` (its current location):
//   · that location is left out of the list (you cannot move a lead to where
//     it already is)
//   · a REASON is asked for and Transfer waits on it — the endpoint refuses
//     without one, and it is kept on the lead's timeline
//   · the note under the list also says what the lead LEAVES behind: its
//     assigned person and the old location's emails
// and `blocked`: when the card already knows the lead cannot move (it is in
// Jobber, or has an engagement — lib/lead-transfer-rule), the modal says why
// instead of offering a list. The endpoint refuses those regardless.
// Same modal system as TouchpointModal / SendToJobberModal: OverlayShell
// owns the backdrop / centered-vs-sheet geometry / scroll-lock / X; this
// file owns the Esc listener, role="dialog", padding, and (since it posts)
// the submitting / errorMsg pattern SendToJobberModal established.
//
// The picker is still a person's choice. Since 30 Sept 2026 it can OPEN on a
// suggestion: when exactly one location claims the lead's zip (the Inbox
// passes it as `preselectId`), that location is already selected — one press
// to confirm, or pick another. Nothing is pre-selected on a zip conflict.
//
// NON-ACTIVE DESTINATIONS are a real rule, not an edge case: 44 of 50
// locations are onboarding. Transfer is ALWAYS allowed; the confirm note
// must always reflect what will actually happen — an active destination
// starts the drip, a non-active one only notifies (amber warning). The
// endpoint enforces the same split; this UI just narrates it truthfully.
//
// Tokens: T.* only — the beta-hive-tokens sweep fails on any raw hex/rgba,
// comments included.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect, useMemo } from 'react'
import OverlayShell from './OverlayShell'
import useIsMobile from './shared/useIsMobile'
import { inp } from './shared/formKit'
import { T } from './shared/tokens'
import { IconSearch, IconMapPin, IconAlertTriangle, IconCheck } from '@/components/ui/icons'
import { transferErrorCopy, TRANSFER_BLOCK_COPY, TRANSFER_REASON_MAX } from '@/lib/lead-transfer-rule'

const MODAL_WIDTH = 440

// Compact button convention (copied from SendToJobberModal — there is no
// shared button module; the 8px 15px box is the standing preference).
const btnBase = {
  padding: '8px 15px', borderRadius: T.radius.control, border: 'none',
  fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
}
const ghostBtn = { ...btnBase, background: 'transparent', color: T.ink.muted, cursor: 'pointer' }
const primaryBtn = (enabled) => ({
  ...btnBase,
  background: enabled ? T.accent.fg : T.ink.disabled,
  color: enabled ? T.accent.onFill : T.ink.quiet,
  cursor: enabled ? 'pointer' : 'not-allowed',
})

const ownerLabel = (t) => (t && t.owner_name) ? t.owner_name : 'the owner'

// One selectable destination row.
function LocationRow({ t, selected, onPick }) {
  const active = t.lifecycle_status === 'active'
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      style={{
        display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
        padding: '9px 11px', textAlign: 'left', fontFamily: 'inherit',
        borderRadius: T.radius.control,
        border: selected ? `1px solid ${T.accent.fg}` : T.border.control,
        background: selected ? T.accent.soft : T.surface.raised,
        cursor: 'pointer',
      }}
    >
      <span style={{ flexShrink: 0, color: selected ? T.accent.deep : T.ink.quiet, display: 'inline-flex' }}>
        <IconMapPin size={15} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span title={t.name} style={{
          display: 'block', fontSize: '13px', fontWeight: 600,
          color: selected ? T.accent.deep : T.ink.primary,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {t.name}
        </span>
        <span style={{
          display: 'block', fontSize: '11px', color: T.ink.muted,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {t.slug}
        </span>
      </span>
      <span style={{
        flexShrink: 0, fontSize: '11px', fontWeight: 600,
        color: active ? T.state.success.fg : T.state.warning.fg,
      }}>
        {active ? 'Live' : 'Not live yet'}
      </span>
      {selected && (
        <span style={{ flexShrink: 0, color: T.accent.fg, display: 'inline-flex' }}>
          <IconCheck size={15} />
        </span>
      )}
    </button>
  )
}

// person: { id, name }; subline: pre-composed origin string; preselectId:
// optional destination to pre-select (the zip-suggestion seam);
// onDone(destination): success handler — the caller closes + removes the row.
// from: { id, name } — the lead's CURRENT location, when it has one (omit for
// an unrouted lead); blocked: 'in_jobber' | 'has_engagement' | null.
export default function TransferLeadModal({ person, subline = null, preselectId = null, from = null, blocked = null, onDone = () => {}, onClose = () => {} }) {
  const isMobile = useIsMobile()
  const needsReason = !!from
  const [reason, setReason] = useState('')
  const [targets, setTargets] = useState(null)   // null = loading
  const [loadError, setLoadError] = useState(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(preselectId)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState(null)

  // Esc closes — self-owned (OverlayShell doesn't).
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Fetch destination locations once on open.
  useEffect(() => {
    if (blocked) return
    let dead = false
    setTargets(null); setLoadError(null)
    fetch('/api/locations/transfer-targets')
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`)
        return r.json()
      })
      .then((j) => {
        if (dead) return
        const list = Array.isArray(j.targets) ? j.targets : []
        setTargets(from?.id ? list.filter((t) => t.id !== from.id) : list)
      })
      .catch((e) => { if (!dead) setLoadError(String(e.message || e)) })
    return () => { dead = true }
  }, [blocked, from?.id])

  const filtered = useMemo(() => {
    const list = targets || []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((t) =>
      (t.name || '').toLowerCase().includes(q) || (t.slug || '').toLowerCase().includes(q))
  }, [targets, query])

  const selected = useMemo(
    () => (targets || []).find((t) => t.id === selectedId) || null,
    [targets, selectedId],
  )

  const reasonText = reason.trim()
  const ready = !!selected && (!needsReason || reasonText.length > 0)

  async function confirm() {
    if (submitting || !ready) return
    setErrorMsg(null)
    setSubmitting(true)
    let json
    try {
      const res = await fetch(`/api/leads/${person.id}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          destination_location_id: selected.id,
          ...(needsReason ? { reason: reasonText } : {}),
        }),
      })
      json = await res.json().catch(() => ({}))
      if (!res.ok || !json || json.success !== true) {
        const msg = json && json.error
          ? transferErrorCopy(json.error)
          : `Transfer failed (HTTP ${res.status})`
        setErrorMsg(msg)
        setSubmitting(false)
        return
      }
    } catch (e) {
      setErrorMsg('Network error — please try again')
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    // Caller owns the close + optimistic row removal; hand up what happened.
    onDone(selected)
  }

  const head = [person?.name, subline].filter(Boolean).join(' · ')
  const selectedActive = selected && selected.lifecycle_status === 'active'
  // What the lead leaves behind — only a lead with a home has anything to leave.
  const leaves = from ? ` ${person?.name || 'This lead'} leaves ${from.name}: the person assigned there is cleared and ${from.name}'s emails stop.` : ''

  if (blocked) {
    return (
      <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={MODAL_WIDTH}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Transfer lead"
          style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          <div>
            <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
              This one can&apos;t be moved
            </h2>
            {head && (
              <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '3px' }}>{head}</p>
            )}
          </div>
          <p data-testid="transfer-blocked" style={{ fontSize: '13px', color: T.ink.secondary, lineHeight: 1.45 }}>
            {(TRANSFER_BLOCK_COPY[blocked] || TRANSFER_BLOCK_COPY.in_jobber).long}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" style={ghostBtn} onClick={onClose}>Close</button>
          </div>
        </div>
      </OverlayShell>
    )
  }

  return (
    <OverlayShell isMobile={isMobile} onClose={onClose} maxWidth={MODAL_WIDTH}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Transfer lead"
        style={{ padding: isMobile ? '0 16px 18px' : '0 24px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}
      >
        {/* Header */}
        <div>
          <h2 style={{ fontSize: '17px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>
            Transfer lead
          </h2>
          {head && (
            <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '3px' }}>{head}</p>
          )}
        </div>

        {/* Search */}
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', color: T.ink.quiet, display: 'inline-flex', pointerEvents: 'none' }}>
            <IconSearch size={15} />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search locations"
            aria-label="Search locations"
            style={{ ...inp, paddingLeft: '33px' }}
          />
        </div>

        {/* Destination list */}
        <div role="listbox" aria-label="Destination locations" style={{
          display: 'flex', flexDirection: 'column', gap: '6px',
          maxHeight: '260px', overflowY: 'auto',
        }}>
          {targets === null && !loadError && (
            <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '10px 2px' }}>Loading locations…</p>
          )}
          {loadError && (
            <p style={{ fontSize: '12px', color: T.state.danger.fg, padding: '10px 2px' }}>
              Couldn&apos;t load locations — {loadError}
            </p>
          )}
          {targets !== null && !loadError && filtered.length === 0 && (
            <p style={{ fontSize: '12px', color: T.ink.quiet, padding: '10px 2px' }}>No matching locations.</p>
          )}
          {filtered.map((t) => (
            <LocationRow key={t.id} t={t} selected={t.id === selectedId} onPick={() => setSelectedId(t.id)} />
          ))}
        </div>

        {/* Outcome note — always reflects what confirm will actually do. */}
        {selected && (
          selectedActive ? (
            <div style={{ display: 'flex', gap: '9px', padding: '10px 12px', background: T.accent.faint, border: `1px solid ${T.accent.soft}`, borderRadius: T.radius.control }}>
              <span style={{ color: T.accent.fg, flexShrink: 0, marginTop: '1px', display: 'inline-flex' }}><IconCheck size={15} /></span>
              <p style={{ fontSize: '12px', color: T.ink.secondary, lineHeight: 1.4 }}>
                Notifies {ownerLabel(selected)} and starts {selected.name}&apos;s drip.{leaves}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '9px', padding: '10px 12px', background: T.state.warning.bg, border: `1px solid ${T.state.warning.soft}`, borderRadius: T.radius.control }}>
              <span style={{ color: T.state.warning.fg, flexShrink: 0, marginTop: '1px', display: 'inline-flex' }}><IconAlertTriangle size={15} /></span>
              <p style={{ fontSize: '12px', color: T.state.warning.deep, lineHeight: 1.4 }}>
                {selected.name} isn&apos;t live yet — {ownerLabel(selected)} will be notified, but the drip won&apos;t start until they activate.{leaves}
              </p>
            </div>
          )
        )}

        {/* Why — only for a lead that already has a home. */}
        {needsReason && (
          <div>
            <label htmlFor="transfer-reason" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: T.ink.secondary, marginBottom: '5px' }}>
              Why is it moving?
            </label>
            <textarea
              id="transfer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={TRANSFER_REASON_MAX}
              rows={2}
              placeholder={`e.g. Their zip belongs to another location`}
              style={{ ...inp, resize: 'vertical', minHeight: '54px' }}
            />
            <p style={{ fontSize: '11px', color: T.ink.muted, marginTop: '4px' }}>
              Kept on the lead&apos;s timeline, with your name.
            </p>
          </div>
        )}

        {/* Error banner (mirrors SendToJobberModal) */}
        {errorMsg && (
          <div style={{ padding: '10px 12px', background: T.state.danger.soft, border: `1px solid ${T.state.danger.strong}`, borderRadius: T.radius.control }}>
            <p style={{ fontSize: '12px', fontWeight: 600, color: T.state.danger.strong, marginBottom: '2px' }}>Couldn&apos;t transfer</p>
            <p style={{ fontSize: '12px', color: T.state.danger.fg, wordBreak: 'break-word' }}>{errorMsg}</p>
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button type="button" style={ghostBtn} onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" style={primaryBtn(ready && !submitting)} onClick={confirm} disabled={!ready || submitting}>
            {submitting ? 'Transferring…' : selected ? `Transfer to ${selected.name}` : 'Transfer'}
          </button>
        </div>
      </div>
    </OverlayShell>
  )
}
