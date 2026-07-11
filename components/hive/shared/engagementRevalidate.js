// components/hive/shared/engagementRevalidate.js
// ─────────────────────────────────────────────────────────────
// PURE helpers for the board's engagement REVALIDATION (doc §7 refresh
// gap). Working-stage advances (Request → Estimate → Job in Progress →
// Final Processing) happen entirely server-side — webhook
// maybeAdvanceEngagementStage / import derivation — with NO client event
// to hang optimism on. The board's engagement set is fetched ONCE at page
// load, so those moves used to need a full reload to surface.
//
// HiveShell hangs a focus/visibility trigger on top of THESE functions:
// it re-fetches the open set and folds the diff in. Keeping the merge here
// (out of the component, zero React) means:
//   1. it is unit-testable in isolation, and
//   2. a later Supabase realtime subscription can feed reconcileServerRows
//      the SAME changed rows without touching the merge — the trigger is
//      the only replaceable part.
//
// Zero imports — safe in any bundle (§8.5 pure-module rule).
// ─────────────────────────────────────────────────────────────

// Board-relevant projection of a row — the exact fields the board/list
// read for columns, chips, value and sort (deriveStatusChip /
// engagementValue / lastActivityTs inputs). Two rows with the same
// signature render identically, so a refetch that returns an unchanged row
// is a no-op (no state churn, no re-render). Deliberately excludes
// updated_at: import/backfill bumps it uniformly and it drives nothing the
// board shows.
export function boardSignature(e) {
  if (!e) return ''
  const child = (arr, keys) => (arr || []).map(r => keys.map(k => r?.[k]).join('')).join('')
  return JSON.stringify([
    e.stage, e.client_name, e.client_phone, e.client_email, e.title,
    e.total_invoiced, e.total_paid, e.balance_owing, e.repeat_count,
    e.nurture_started_at, e.closed_at, e.stage_entered_at, e.founded_by,
    child(e.quotes, ['status', 'total', 'sent_at', 'approved_at']),
    child(e.jobs, ['status', 'scheduled_start', 'completed_at']),
    child(e.invoices, ['status', 'total', 'balance_owing']),
    child(e.assessments, ['scheduled_at', 'completed_at']),
    (e.service_requests || []).length,
  ])
}

// Fold a freshly-fetched OPEN set into the serverRevalidated map (id →
// fresh row). ONLY rows already known — present in the page-load prop or
// the session set (baseById) — reconcile; brand-new engagements and
// server-side disappearance stay reload-only (out of scope for the
// focus-refresh fix, which targets open→open stage moves of visible
// cards). Returns the SAME `prev` reference when nothing board-relevant
// changed, so the caller can setState(prev) and skip a re-render.
//
// This layer sits BELOW rowPatches (see mergeEngagements): it is freely
// overwritten by each newer fetch, and never holds local intent — so a
// stale reconciled value can't get "stuck" winning over a fresher one.
export function reconcileServerRows(prev, freshRows, baseById) {
  if (!Array.isArray(freshRows) || freshRows.length === 0) return prev
  let changed = false
  const next = { ...prev }
  for (const fresh of freshRows) {
    if (!fresh || !fresh.id || !baseById.has(fresh.id)) continue
    const known = prev[fresh.id] || baseById.get(fresh.id)
    if (boardSignature(known) !== boardSignature(fresh)) {
      next[fresh.id] = fresh
      changed = true
    }
  }
  return changed ? next : prev
}

// Three-layer merge, precedence LOW → HIGH:
//   base              — the page-load / session engagement set
//   serverRevalidated — fresh server truth from a refetch (open→open moves)
//   rowPatches        — LOCAL hand-ups: session closes, panel title/stage
//                       edits, reopen-cleared entries
// rowPatches win LAST, so a concurrent refetch can never clobber pending
// optimistic state — a just-closed row keeps its terminal patch even if
// the (pre-close) fetch still lists it open; a title edit isn't reverted
// by a stale fetch. Local hand-ups are confirmed writes the server will
// echo, so "local always wins" converges rather than drifts.
export function mergeEngagements(base, serverRevalidated, rowPatches) {
  const hasSrv = serverRevalidated && Object.keys(serverRevalidated).length > 0
  const hasPatch = rowPatches && Object.keys(rowPatches).length > 0
  if (!hasSrv && !hasPatch) return base
  return base.map(e => {
    let out = e
    if (hasSrv && serverRevalidated[e.id]) out = { ...out, ...serverRevalidated[e.id] }
    if (hasPatch && rowPatches[e.id]) out = { ...out, ...rowPatches[e.id] }
    return out
  })
}
