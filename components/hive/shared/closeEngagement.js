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
import { WRITTEN_OFF } from './writtenOff'
import { invoicesForReasoning } from './invoiceDeleted'

// Close-LOST reasons are ADMIN-CONFIGURED (lookups category
// 'closed_lost_reasons'): the wizard renders those labels and stores the
// raw label string in engagements.closed_reason (free text — no DB CHECK/FK;
// the PATCH route stores it verbatim). The admin picklist is the source of
// truth; this const is only the code-level FALLBACK the wizard shows when
// that category is unconfigured in an env (mirrors DEFAULT_CLOSE_REASONS in
// BeeHub.jsx). These are the human labels of the original close-out
// vocabulary. 'Other' still REQUIRES a note (the wizard enforces it).
// 'Written off' USED to be here. It is its own close now (writtenOff.js):
// it records the amount and never reads as lost, so offering it as a Lost
// reason as well would give an owner two doors to the same outcome, one of
// which records nothing. (No location has a configured list and no
// engagement ever used the label — checked 2026-09-27.)
export const DEFAULT_CLOSE_LOST_REASONS = [
  'No response',
  'Went with someone else',
  'Not a fit',
  'Other',
]
export const OTHER_LOST_REASON = 'Other'

// Won gate — every invoice paid or zero balance (no invoices = clear).
// The one settled-check both the confirm and the Won wizard's invoice
// step read, so "Won gates on settled invoices" can't drift per surface.
//
// A BAD-DEBT invoice is never settled, whatever its balance says: once
// Jobber's real balance is read, a written-off invoice shows $0, and "$0
// owing" there means "we gave up", not "we were paid". Letting it through
// would put Mark won on a deal that was written off. Those deals close as
// Written off instead (writtenOff.js).
//
// Invoices DELETED in Jobber are not there (invoiceDeleted.js); a paid one
// that was later deleted still reads as paid.
export function invoicesSettled(all = []) {
  const invoices = invoicesForReasoning(all)
  return invoices.length === 0 ||
    invoices.every(i => i.status === 'paid' || (i.status !== 'bad_debt' && Number(i.balance_owing) === 0))
}

// The closed_reason stamped by an OWNER OVERRIDE close (issue 119): the
// owner says the deal is settled in Jobber, Bee Hub still shows a
// balance, and Kevin's ruling is that the owner wins. A distinct value
// — never plain 'won' — so a future reader can tell "closed with $340
// still showing as owed" from "closed, fully paid" in the row itself,
// not by inference. The ROUTE holds the matching literal (the server
// close vocabulary lives beside 'won' / 'stale_on_import' in
// lib/engagements.ts, which client code must never import — it drags
// the Supabase service client into the browser bundle). The two are
// pinned equal by beta-final-processing-explains.
export const WON_OVER_BALANCE = 'won_balance_owing'

// Commit a terminal close. Returns the route's JSON on success; throws on
// any non-2xx so callers surface the message. closedNote is trimmed;
// empty → omitted (the route leaves the column untouched).
//
// overBalance: the owner-override Won described above. It sends the
// WON_OVER_BALANCE reason and REQUIRES a note — the route refuses an
// empty one (that refusal is the floor; this check only saves a
// round-trip). The balance itself is never written: the number stays
// true and the close explains itself. Nothing here reaches Jobber —
// Bee Hub's stage is Bee Hub's.

//
// closeAs WRITTEN_OFF: the written-off close (writtenOff.js). Stored as
// Closed Lost + 'written_off'; the note is REQUIRED (the route refuses an
// empty one) and the amount is computed by the route from the invoices —
// never sent from here.
export async function commitEngagementClose(engagementId, { closeAs, closedReason, closedNote, overBalance = false }) {
  const note = (closedNote || '').trim()
  const wonOverBalance = closeAs === CLOSED_WON && overBalance
  if (wonOverBalance && !note) throw new Error('A reason is required to close this with a balance showing')
  if (closeAs === WRITTEN_OFF && !note) throw new Error('A reason is required to write this off')
  const body = closeAs === CLOSED_WON
    ? { stage: CLOSED_WON, closed_reason: wonOverBalance ? WON_OVER_BALANCE : 'won', ...(note ? { closed_note: note } : {}) }
    : closeAs === WRITTEN_OFF
      ? { stage: CLOSED_LOST, closed_reason: WRITTEN_OFF, closed_note: note }
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

// The fields a close just wrote, from the route's response — for hosts
// that reflect the outcome locally before any refetch (the panel). Lives
// HERE so the host files stay free of the close vocabulary (the
// beta-stage-control source pin).
export function closedFieldsFrom(j = {}) {
  const out = { stage: j.stage }
  for (const k of ['closed_reason', 'closed_note', 'closed_at', 'written_off_amount']) {
    if (j[k] !== undefined) out[k] = j[k]
  }
  return out
}

// Real, persisted flag / re-engage MARKER on the timeline. A future
// occurred_at + status 'pending' carries an intent, the label carries the
// reason. Fire-and-forget from the caller's perspective; throws on a hard
// failure so the wizard can surface it, but a failed marker never unwinds
// the already-committed close.
//
// A follow-up the OWNER wants to be reminded of is no longer one of these
// (2026-09-30): the lost-lead wizard sets a real Reminder instead, and only
// writes a plain history line here (status null, dated now, attributed to
// the person via actor 'session').
export async function writeEngagementMarker({ leadId, engagementId, kind = 'system', label, notes, occurredAt, method = null, status = 'pending', actor = null }) {
  const res = await fetch('/api/touchpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lead_id: leadId,
      engagement_id: engagementId,
      kind,
      label,
      method,
      status,
      ...(actor ? { actor } : {}),
      ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
  return j?.touchpoint ?? null
}
