// components/hive/TransferLeadModal.jsx
// ─────────────────────────────────────────────────────────────
// Corp/admin routes a loc_other global-form lead to a REAL location.
// Same modal system as TouchpointModal / SendToJobberModal: OverlayShell
// owns the backdrop / centered-vs-sheet geometry / scroll-lock / X; this
// file owns the Esc listener, role="dialog", padding, and (since it posts)
// the submitting / errorMsg pattern SendToJobberModal established.
//
// The picker is MANUAL by design. ZIP-based suggestion is out of scope for
// this build (location_zips isn't synced from Zoho yet). The `preselectId`
// prop is the clean seam a future suggested-location pre-select drops into —
// nothing else changes.
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
        <span style={{
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
export default function TransferLeadModal({ person, subline = null, preselectId = null, onDone = () => {}, onClose = () => {} }) {
  const isMobile = useIsMobile()
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
    let dead = false
    setTargets(null); setLoadError(null)
    fetch('/api/locations/transfer-targets')
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`)
        return r.json()
      })
      .then((j) => { if (!dead) setTargets(Array.isArray(j.targets) ? j.targets : []) })
      .catch((e) => { if (!dead) setLoadError(String(e.message || e)) })
    return () => { dead = true }
  }, [])

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

  async function confirm() {
    if (submitting || !selected) return
    setErrorMsg(null)
    setSubmitting(true)
    let json
    try {
      const res = await fetch(`/api/leads/${person.id}/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination_location_id: selected.id }),
      })
      json = await res.json().catch(() => ({}))
      if (!res.ok || !json || json.success !== true) {
        const msg = json && json.error
          ? json.error
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
                Notifies {ownerLabel(selected)} and starts {selected.name}&apos;s drip.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '9px', padding: '10px 12px', background: T.state.warning.bg, border: `1px solid ${T.state.warning.soft}`, borderRadius: T.radius.control }}>
              <span style={{ color: T.state.warning.fg, flexShrink: 0, marginTop: '1px', display: 'inline-flex' }}><IconAlertTriangle size={15} /></span>
              <p style={{ fontSize: '12px', color: T.state.warning.deep, lineHeight: 1.4 }}>
                {selected.name} isn&apos;t live yet — {ownerLabel(selected)} will be notified, but the drip won&apos;t start until they activate.
              </p>
            </div>
          )
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
          <button type="button" style={primaryBtn(!!selected && !submitting)} onClick={confirm} disabled={!selected || submitting}>
            {submitting ? 'Transferring…' : selected ? `Transfer to ${selected.name}` : 'Transfer'}
          </button>
        </div>
      </div>
    </OverlayShell>
  )
}
