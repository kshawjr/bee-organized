// lib/import-estimate.ts
// ─────────────────────────────────────────────────────────────
// Pre-flight time estimate for the Jobber client import prompt.
// Shown BEFORE the user clicks Start Import (onboarding step +
// Settings card) so they can decide to import now or later.
// Not a during-import progress/ETA — that's importEtaText in
// BeeHub.jsx, driven by live processed_records samples.
//
// The count comes from /api/import/active (client_count field,
// a { clients { totalCount } } Jobber query). When the count is
// unavailable — query failed, schema doesn't expose totalCount,
// no token — importEstimateLine falls back to a static line so
// the prompt still supports the now-or-later decision.
// ─────────────────────────────────────────────────────────────

// Calibrated from real import_jobs runs (completed_at − started_at over
// total_records): clean runs measured 0.29–0.53 sec/client; the resumed/
// stalled outlier excluded. 0.5 chosen to err high — an import that
// finishes early is good; one that runs past the estimate feels broken.
export const SEC_PER_CLIENT = 0.5

// Below this, a numeric range reads as false precision — say "a few
// minutes" instead. (200 clients ≈ 100s of write time.)
const FEW_MINUTES_CUTOFF = 200

// Estimates render as minute values from this ladder, so ranges look
// human ("3–7", "10–20") rather than computed ("5.4–8.1").
const NICE_MINUTES = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240]

// Nearest rung; ties round DOWN so the bracket widens rather than narrows.
function nearestNice(v: number): number {
  let best = NICE_MINUTES[0]
  for (const n of NICE_MINUTES) {
    if (Math.abs(n - v) < Math.abs(best - v)) best = n
  }
  return best
}

// Smallest rung ≥ v, with ~5% snap-down grace: a raw ceiling barely above
// a rung uses it instead of jumping a whole rung (1,616 clients stays
// "10–20", not "10–30"), while a genuinely-between value still rounds up
// (430 clients → ceiling 7, not 5).
function niceCeil(v: number): number {
  const graced = v * 0.95
  for (const n of NICE_MINUTES) if (n >= graced) return n
  return Math.ceil(v / 60) * 60
}

// Padded range around the point estimate: floor ≈ 0.8×, ceil ≈ 1.5×,
// both snapped to the ladder. Generous by design — see SEC_PER_CLIENT.
export function importEstimateRange(count: number): { floor: number; ceil: number } {
  const minutes = (count * SEC_PER_CLIENT) / 60
  const ceil = niceCeil(minutes * 1.5)
  let floor = nearestNice(minutes * 0.8)
  if (floor >= ceil) floor = Math.max(1, ...NICE_MINUTES.filter((n) => n < ceil))
  return { floor, ceil }
}

// "1,616" → "about 1,600" — the live count is exact but the sentence
// hedges, so a spuriously-precise number would read oddly.
function friendlyCount(count: number): string {
  const rounded =
    count >= 1000 ? Math.round(count / 100) * 100
    : count >= 100 ? Math.round(count / 10) * 10
    : count
  return rounded.toLocaleString('en-US')
}

const FALLBACK_LINE =
  'Importing usually takes 5–20 minutes, depending on how many clients you have.'

// The one line both import prompts render pre-start. Count unknown
// (null/undefined/non-positive) → static fallback; a failed count fetch
// must never block or break the prompt.
export function importEstimateLine(count?: number | null): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return FALLBACK_LINE
  }
  const n = Math.round(count)
  const who = `You have about ${friendlyCount(n)} ${n === 1 ? 'client' : 'clients'}`
  const tail = 'You can do this now or come back to it later.'
  if (n < FEW_MINUTES_CUTOFF) {
    return `${who} — importing takes a few minutes. ${tail}`
  }
  const { floor, ceil } = importEstimateRange(n)
  return `${who} — importing takes about ${floor}–${ceil} minutes. ${tail}`
}
