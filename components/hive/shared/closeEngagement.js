// components/hive/shared/closeEngagement.js
// ─────────────────────────────────────────────────────────────
// THE single engagement-close write path (§4). Every HUMAN close intent
// — the board's drag-to-close (CloseEngagementConfirm), the panel ···
// menu's Close-Lost wizard, and the Close-Won wizard — commits through
// commitEngagementClose(). One helper, one PATCH body shape, so the
// three UIs can never drift what a close actually writes.
//
// The beta-stage-control source pin keeps the 'closed_reason' literal OUT
// of EngagementPanel.jsx / EngagementBoard.jsx (those host files must
// never fork the write); it lives HERE and in the wizard/confirm bodies,
// all routed through this one fetch. AUTOMATED closes (import backfill,
// webhook derivation, drift recovery, reopen re-derive) write stage
// directly server-side and must NEVER import this — it binds to human UI
// intent, not to the Won/Lost value.
//
// PURE-ish: only stageConfig (itself pure). Safe in the beta chunk.
// ─────────────────────────────────────────────────────────────

import { CLOSED_WON, CLOSED_LOST } from './stageConfig'

// Close-LOST reasons are ADMIN-CONFIGURED (lookups category
// 'closed_lost_reasons'): the wizard renders those labels and stores the
// raw label string in engagements.closed_reason (free text — no DB CHECK/FK;
// the PATCH route stores it verbatim). The admin picklist is the source of
// truth; this const is only the code-level FALLBACK the wizard shows when
// that category is unconfigured in an env (mirrors DEFAULT_CLOSE_REASONS in
// BeeHub.jsx). These are the human labels of the original close-out
// vocabulary. 'Other' still REQUIRES a note (the wizard enforces it).
export const DEFAULT_CLOSE_LOST_REASONS = [
  'No response',
  'Went with someone else',
  'Not a fit',
  'Written off',
  'Other',
]
export const OTHER_LOST_REASON = 'Other'

// Won gate — every invoice paid or zero balance (no invoices = clear).
// The one settled-check both the confirm and the Won wizard's invoice
// step read, so "Won gates on settled invoices" can't drift per surface.
export function invoicesSettled(invoices = []) {
  return invoices.length === 0 ||
    invoices.every(i => i.status === 'paid' || Number(i.balance_owing) === 0)
}

// Commit a terminal close. Returns the route's JSON on success; throws on
// any non-2xx so callers surface the message. closedNote is trimmed;
// empty → omitted (the route leaves the column untouched).
export async function commitEngagementClose(engagementId, { closeAs, closedReason, closedNote }) {
  const note = (closedNote || '').trim()
  const body = closeAs === CLOSED_WON
    ? { stage: CLOSED_WON, closed_reason: 'won', ...(note ? { closed_note: note } : {}) }
    : { stage: CLOSED_LOST, closed_reason: closedReason, ...(note ? { closed_note: note } : {}) }
  const res = await fetch(`/api/engagements/${engagementId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
  return j
}

// Real, persisted follow-up / flag / re-engage MARKER (not the old
// client-side mock). There is no reminder/nurture scheduler table yet
// (schema-only nurture_started_at, no cron), so the honest primitive is
// a touchpoints row the future step-5 machinery can pick up: a future
// occurred_at + status 'pending' carries the intent, the label carries
// the reason. Fire-and-forget from the caller's perspective; throws on a
// hard failure so the wizard can surface it, but a failed marker never
// unwinds the already-committed close.
export async function writeEngagementMarker({ leadId, engagementId, kind = 'system', label, notes, occurredAt, method = null }) {
  const res = await fetch('/api/touchpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lead_id: leadId,
      engagement_id: engagementId,
      kind,
      label,
      method,
      status: 'pending',
      ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
  return j?.touchpoint ?? null
}
