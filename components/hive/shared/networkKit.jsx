// components/hive/shared/networkKit.jsx
// ─────────────────────────────────────────────────────────────
// Shared pieces for the two Network record views (person + company),
// Phase 3. Pure derivations exported separately so tests hit logic
// without a mount.
//
// BADGES ARE DERIVED FROM FACTS, never from a type field:
//   Refers us          — they have actually sent leads (referral count>0)
//   Client             — is_customer + a customer_lead_id link (deep-links
//                        to the client record; a legacy flag with no link
//                        still shows, unlinked)
//   Potential customer — the same signal the Phase 2 band uses (stage
//                        'Customer', isCustomer, or the warm tag)
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from './tokens'
import { EditPencil, InlineEditControls } from './inlineEdit'

// ── pure: badge derivation ───────────────────────────────────
// referralCount: null = unknown (rollup still loading) — the Refers-us
// badge only renders on a KNOWN count, never on a guess.
export function deriveNetworkBadges({ partner, referralCount = null }) {
  const badges = []
  if (referralCount != null && referralCount > 0) {
    badges.push({ key: 'refers', label: 'Refers us', family: 'green' })
  }
  if (partner?.isCustomer) {
    badges.push({
      key: 'client', label: 'Client', family: 'gold',
      clientLeadId: partner.customerLeadId || null, // null → badge without a link
    })
  } else if (partner?.stage === 'Customer' || (partner?.tags || []).includes('warm')) {
    badges.push({ key: 'potential', label: 'Potential customer', family: 'purple' })
  }
  return badges
}

// The relationship pipeline — the partner's OWN vocabulary. NEVER crossed
// with engagement stages (different lifecycle, different table).
export const PARTNER_STAGE_RAIL = ['New Contact', 'Reaching Out', 'Building', 'Active Partner', 'Dormant']

// ── chips + tiles ────────────────────────────────────────────
const FAMILY_STYLE = (family) => {
  if (family === 'gold') return { bg: T.brand.goldSoft, text: T.brand.goldText }
  return T.family[family] || T.family.gray
}

export function BadgeChip({ badge }) {
  const fam = FAMILY_STYLE(badge.family)
  const style = {
    fontSize: T.badge.font, fontWeight: 500, color: fam.text, background: fam.bg,
    borderRadius: T.radius.chip, padding: '2px 8px', whiteSpace: 'nowrap',
    textDecoration: 'none', display: 'inline-block',
  }
  // Client badge deep-links to the client record when the link exists.
  if (badge.clientLeadId) {
    return <a data-badge={badge.key} href={`/clients/${badge.clientLeadId}`} style={style}>{badge.label} ↗</a>
  }
  return <span data-badge={badge.key} style={style}>{badge.label}</span>
}

export function StatTile({ label, value, danger = false }) {
  return (
    <div style={{ flex: 1, minWidth: '80px', background: T.surface.sunken, borderRadius: T.radius.control, padding: '8px 10px' }}>
      <p style={{ fontSize: '16px', fontWeight: 600, color: danger ? T.state.danger.fg : T.ink.primary, letterSpacing: T.type.trackNum, fontVariantNumeric: T.type.tabular }}>{value}</p>
      <p style={{ fontSize: '10px', color: T.ink.muted, marginTop: '1px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{label}</p>
    </div>
  )
}

export function SectionLabel({ children, action = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
      <p style={{ fontSize: '10px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px', textTransform: 'uppercase' }}>{children}</p>
      {action}
    </div>
  )
}

// ── the relationship stage rail ──────────────────────────────
// Segments left→right; the current stage and everything before it fill.
// Click a segment to move the relationship there (readOnly hides the
// affordance). 'Customer'/legacy values outside the rail render every
// segment unfilled with the raw value beside it — never coerced.
export function StageRail({ stage, onChange = () => {}, readOnly = false }) {
  const idx = PARTNER_STAGE_RAIL.indexOf(stage)
  return (
    <div data-testid="stage-rail">
      <div style={{ display: 'flex', gap: '4px' }}>
        {PARTNER_STAGE_RAIL.map((s, i) => {
          const filled = idx >= 0 && i <= idx
          const current = i === idx
          return (
            <button key={s} type="button" disabled={readOnly}
              data-stage-seg={s} data-filled={filled ? 'true' : 'false'}
              onClick={() => onChange(s)}
              aria-label={`Set stage ${s}`} aria-pressed={current}
              style={{
                flex: 1, border: 'none', cursor: readOnly ? 'default' : 'pointer', padding: 0,
                background: 'transparent', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: '4px',
              }}>
              <span aria-hidden style={{ display: 'block', width: '100%', height: '5px', borderRadius: '3px', background: filled ? T.accent.fg : T.hairline.line }} />
              <span style={{ fontSize: '9px', fontWeight: current ? 600 : 400, color: current ? T.accent.deep : T.ink.quiet, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{s}</span>
            </button>
          )
        })}
      </div>
      {idx < 0 && stage && (
        <p style={{ fontSize: '10px', color: T.ink.quiet, marginTop: '4px' }}>Current: {stage}</p>
      )}
    </div>
  )
}

// ── inline-editable text row (the shared inline-edit standard:
// always-visible ✎, green-✓/✗ pair, Esc cancels) ─────────────
export function InlineText({ label, value, onSave, href = null, placeholder = 'add', readOnly = false, multiline = false }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const start = () => { if (readOnly) return; setDraft(value || ''); setEditing(true) }
  const save = async () => {
    setBusy(true)
    try { await onSave(draft.trim()); setEditing(false) } finally { setBusy(false) }
  }

  if (editing) {
    const Input = multiline ? 'textarea' : 'input'
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '11px', color: T.ink.muted, fontWeight: 500, width: '72px', flexShrink: 0 }}>{label}</span>
        <Input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !multiline) save(); if (e.key === 'Escape') setEditing(false) }}
          style={{ flex: 1, padding: '5px 9px', border: T.border.control, borderRadius: T.radius.control, fontSize: '16px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none', minWidth: 0 }} />
        <InlineEditControls onSave={save} onCancel={() => setEditing(false)} busy={busy} />
      </div>
    )
  }
  return (
    <div role="button" tabIndex={readOnly ? -1 : 0} onClick={start}
      onKeyDown={e => { if (e.key === 'Enter') start() }}
      style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: readOnly ? 'default' : 'pointer', minHeight: '26px' }}>
      <span style={{ fontSize: '11px', color: T.ink.muted, fontWeight: 500, width: '72px', flexShrink: 0 }}>{label}</span>
      {value
        ? (href
          ? <a href={href} onClick={e => e.stopPropagation()} style={{ fontSize: '12px', color: T.ink.primary, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</a>
          : <span style={{ fontSize: '12px', color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>)
        : <span style={{ fontSize: '12px', color: T.ink.faint }}>{placeholder}</span>}
      {!readOnly && <EditPencil />}
    </div>
  )
}

// ── last-talked formatting (mirrors the Phase 2 list) ────────
const DAY_MS = 86400000
export function fmtLastTalk(iso, nowMs) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const days = Math.floor((nowMs - t) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days}d ago`
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date(nowMs).getFullYear() ? undefined : 'numeric' })
}
