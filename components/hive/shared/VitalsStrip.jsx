// components/hive/shared/VitalsStrip.jsx
// ─────────────────────────────────────────────────────────────
// The four-cell deal-health strip riding every lead-detail card header —
// BELOW the identity row, ABOVE the tabs, so the vitals stay visible on
// every tab. Money-tile idiom (MetricCard's quiet surface): sunken
// surface, inset radius, hairline cell dividers; labels 10px uppercase
// muted, values 14px/500 tabular. ONE grid row always — cells truncate, never wrap, so four
// fit the narrow mobile sheet. Absent values render '—', never a
// blank or a fabricated zero.
//
// Per-surface cells (the host card decides):
//   EngagementPanel — Stage / Value / Last touch / Next
//   ClientProfile   — Status / Lifetime / Last touch / Open
//   PersonCard      — Status / Inquired / Last touch / Next
//
// §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { formatInboxAgeParts, formatInboxFutureParts } from './engagementStatus'
import { T } from './tokens'

export const EM_DASH = '—'

// Compact strip rendering of the Inbox age idiom — a cell is ~70px on a
// narrow card, so '2d', not 'Jul 7 · 2d ago'. Relative inside 30 days
// ('now' / '45m' / '3h' / '2d'), the bare date anchor beyond ('Apr 21',
// 'Dec 12, 2025'). Built ON formatInboxAgeParts so the tiers can never
// drift from the Inbox row's.
export function vitalsAge(when, nowMs = Date.now()) {
  if (!when) return EM_DASH
  const { anchor, hint } = formatInboxAgeParts(when, nowMs)
  if (hint) return hint.replace(' ago', '') // 'Jun 5 · 29d ago' → '29d'
  if (anchor === 'just now') return 'now'
  const rel = anchor.match(/^(\d+) (min|hour)s? ago$/)
  if (rel) return `${rel[1]}${rel[2] === 'min' ? 'm' : 'h'}`
  return anchor // date-only tiers pass through
}

// The FUTURE mirror — 'Jul 9' inside the month (formatInboxFutureParts'
// anchor), '45m' / '3h' when it's same-day.
export function vitalsFuture(when, nowMs = Date.now()) {
  if (!when) return EM_DASH
  const { anchor } = formatInboxFutureParts(when, nowMs)
  const rel = anchor.match(/^in (\d+) (min|hour)s?$/)
  if (rel) return `${rel[1]}${rel[2] === 'min' ? 'm' : 'h'}`
  return anchor
}

// Soonest not-yet-done schedulable among an engagement's children —
// future assessments + future job starts, the future types the
// engagement/profile payloads ALREADY carry (no new queries; lead-level
// drip projections stay with the Timeline tab's own fetch). Returns
// epoch ms or null.
export function nextFromChildren({ assessments = [], jobs = [] } = {}, nowMs = Date.now()) {
  const toTs = (v) => {
    const t = v ? new Date(v).getTime() : NaN
    return Number.isFinite(t) ? t : null
  }
  const cands = [
    ...assessments.filter(a => !a.completed_at).map(a => toTs(a.scheduled_at)),
    ...jobs.filter(j => !j.completed_at && !(j.status || '').includes('complet')).map(j => toTs(j.scheduled_start)),
  ].filter(t => t != null && t > nowMs)
  return cands.length ? Math.min(...cands) : null
}

// cells: exactly four { label, value, color? }. color tints the value
// only (status/stage colors, the Next accent) — labels stay muted.
export default function VitalsStrip({ cells = [] }) {
  return (
    <div aria-label="Vitals" style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cells.length || 4}, minmax(0, 1fr))`,
      background: T.surface.sunken, borderRadius: T.radius.inset,
    }}>
      {cells.map((c, i) => (
        <div key={c.label} style={{
          minWidth: 0, padding: '8px 10px',
          borderLeft: i === 0 ? 'none' : T.border.divider,
        }}>
          <p style={{ fontSize: '10px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.5px', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.label}
          </p>
          <p style={{ fontSize: '14px', fontWeight: 500, fontVariantNumeric: T.type.tabular, letterSpacing: T.type.trackNum, color: (c.value != null && c.color) || T.ink.primary, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.value ?? EM_DASH}
          </p>
        </div>
      ))}
    </div>
  )
}
