// components/hive/shared/ClosedSummary.jsx
// ─────────────────────────────────────────────────────────────
// The closed-engagement outcome line — reason + optional note, rendered
// where the drip banner would sit on an open engagement (card-restore
// build 1: the data was fetched all along, never rendered).
//
// DELIBERATELY the only hive component beside CloseEngagementConfirm
// that touches engagements.closed_reason: the beta-stage-control source
// pin keeps the literal OUT of EngagementPanel/EngagementBoard so the
// close WRITE path can never fork — this component reads the whole
// engagement row and keeps the panel literal-free. Display only; the
// column is asymmetric (won/stale_on_import machine values) so labels
// come from closedReasonLabel's tolerant map.
//
// Renders null for open stages — hosts can mount it unconditionally.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { IconCheck, IconX } from '@/components/ui/icons'
import { closedReasonLabel, formatFullDate } from './engagementStatus'
import { WON_OVER_BALANCE, OWING_CLOSED_LABEL, owingClosedLine } from './finalProcessing'
import { T } from './tokens'

export default function ClosedSummary({ engagement }) {
  const e = engagement
  if (!e || (e.stage !== 'Closed Won' && e.stage !== 'Closed Lost')) return null
  const won = e.stage === 'Closed Won'
  // An OWNER OVERRIDE close (issue 119) — won while Bee Hub still showed
  // money owing. Kevin's ruling: the fact stays and is LEGIBLE, not
  // buried in an audit table nobody opens. So it gets its own verdict
  // line, the balance beside it, and the owner's reason rendered IN FULL
  // — never the one-line ellipsis the optional completion note gets,
  // because this note is the whole justification for the close.
  const overBalance = won && e.closed_reason === WON_OVER_BALANCE
  // 'won' as a reason is redundant beside the 'Closed won' verdict —
  // suppress it; every other reason (including machine stamps) shows.
  const reason = overBalance
    ? OWING_CLOSED_LABEL
    : (e.closed_reason === 'won' ? null : closedReasonLabel(e.closed_reason))
  const note = (e.closed_note || '').trim()
  return (
    <div style={{ padding: '10px 14px', background: T.surface.sunken, borderRadius: T.radius.inset, display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <p style={{ fontSize: '12px', fontWeight: 500, color: won ? T.accent.deep : T.ink.secondary, display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
        <span style={{ color: won ? T.accent.fg : T.ink.quiet, display: 'inline-flex', flexShrink: 0 }}>
          {won ? <IconCheck size={13} /> : <IconX size={13} />}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Closed {won ? 'won' : 'lost'}
          {reason ? ` · ${reason}` : ''}
          {formatFullDate(e.closed_at) ? ` · ${formatFullDate(e.closed_at)}` : ''}
        </span>
      </p>
      {overBalance && (
        <p data-bee-over-balance-line style={{ fontSize: '11px', color: T.ink.secondary, paddingLeft: '20px' }}>
          {owingClosedLine(e)}
        </p>
      )}
      {note && (overBalance ? (
        // Full text, wrapped — the reason a balance was overridden has to
        // be readable without hovering for a tooltip.
        <p data-bee-over-balance-reason style={{ fontSize: '11px', fontStyle: 'italic', color: T.ink.muted, paddingLeft: '20px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          “{note}”
        </p>
      ) : (
        <p title={note} style={{ fontSize: '11px', fontStyle: 'italic', color: T.ink.muted, paddingLeft: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          “{note}”
        </p>
      ))}
    </div>
  )
}
