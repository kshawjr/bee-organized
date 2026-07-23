// lib/import-continuation.ts
//
// The continuation handoff for the segmented Jobber import — the mechanism
// that picks a job back up after a segment yields gracefully.
//
// WHY THIS EXISTS (the loc_kc stall, 2026-07-22):
// A 3,352-record import needs ~9 segments (WRITE_BATCH_CAP=400). Every segment
// ends in a clean graceful yield: progress persisted, both mutexes released
// (segment_started_at + location_claim_at → NULL), phase message written. Two
// separate defects meant nothing reliably picked the job back up:
//
//   1. THE FAIL-OUT CLOCK MEASURED JOB AGE, NOT STALL AGE.  The sweeper aged a
//      job as `now - (location_claim_at || started_at)`. After a clean yield
//      location_claim_at is NULL by design, so it fell back to started_at — the
//      time the WHOLE JOB began. Past the 15-min ceiling, every subsequent
//      clean yield was classified "hopeless" and marked failed WITHOUT EVER
//      BEING RE-POKED. Prod evidence: loc_kc job 20:29:26 → failed 20:57:26
//      with "no progress for 28m" where 28m == exactly (completed_at −
//      started_at). The fail-out was therefore not a last resort — it was a
//      HARD 15-MINUTE CEILING ON TOTAL IMPORT DURATION. Small locations
//      (263–1,616 records, 0.5–8.5 min) never hit it; a territory-sized
//      import cannot survive it.
//
//   2. selfContinue() FIRED INTO A DYING FUNCTION.  It wrapped its POST in a
//      NESTED waitUntil() called from inside the already-detached runImport(),
//      minutes after the HTTP response was sent. @vercel/functions resolves
//      waitUntil as `getContext().waitUntil?.(promise)` — optional-chained, so
//      with no live request context it is a SILENT NO-OP that never registers
//      the promise and never keeps the function alive for it. Paired with
//      `.catch(() => {})`, every failure mode was unobservable.
//
// The fixes this module supports:
//   • stall age is measured from real signals only — a live claim, or the age
//     of the CONSECUTIVE BOUNCE RUN. started_at is never a stall reference.
//   • a cleanly-yielded job (null claim, no recorded bounces) is ALWAYS
//     re-poked, never failed out.
//   • every continuation attempt records its OUTCOME to sync_log, so a
//     bounce is readable rather than a console.warn nobody sees.
//   • landing is verified against DB STATE (did a new segment actually claim?),
//     not against the HTTP status alone.

import { writeSyncLog } from './sync-log'

// Which mechanism made the attempt. selfContinue is the fast path (fires
// within milliseconds of the yield); the sweeper is the every-minute net.
export type ContinuationSource = 'self_chain' | 'sweeper'

// What actually happened. Anything that is not 'landed' leaves the job for
// the next sweeper pass and counts toward the bounce run.
//   landed    — the POST succeeded AND a new segment holds the claim
//               (or the job already left status='running', i.e. it finished).
//   no_claim  — the POST returned 2xx but nobody claimed. The resume did not
//               take. This is the silent-failure class; it must be loud.
//   bounced   — redirect (SSO gate), 401, 5xx — the POST never reached the
//               route's own logic.
//   errored   — the fetch threw (DNS, connection reset, timeout).
export type ContinuationOutcome = 'landed' | 'no_claim' | 'bounced' | 'errored'

/** Outcomes that mean the handoff did not visibly complete. Drives how the
 *  attempt is recorded + reported — NOT whether the job is failed out. */
export const isFailedOutcome = (o: ContinuationOutcome): boolean => o !== 'landed'

/**
 * Outcomes that age a job toward the max-lifetime fail-out. ONLY hard
 * transport rejections qualify.
 *
 * WHY THIS IS NARROWER THAN isFailedOutcome (observed in prod, 2026-07-22):
 * the receiving function is a cold-startable 800s route, and it was measured
 * taking >9 SECONDS between entering the handler and writing its claim. So:
 *   • 'no_claim' — an immediate claim re-read can lose that race and report
 *     "nobody took it" about a handoff that lands moments later. Two of the
 *     first two sweeper attempts on loc_kc were exactly this false positive.
 *   • 'errored'  — a POST that times out waiting for the ack may still have
 *     been received and acted on (loc_kc: claim written at 01:14:50, our
 *     10s abort fired at 01:14:53, and the segment ran fine).
 * Both are ambiguous, and aging a job on ambiguous evidence would kill healthy
 * imports on a different clock — the exact failure this whole change removes.
 * They stay RECORDED and visible; they just never pull the trigger.
 *
 * 'bounced' is unambiguous: a redirect, 401, or 5xx means the request did not
 * reach the route's own logic at all. A sustained run of those is a genuinely
 * broken handoff and is worth giving up on.
 */
export const agesBounceRun = (o: ContinuationOutcome): boolean => o === 'bounced'

// Stable, greppable prefix. Kevin can find every continuation attempt with
// a single sync_log message filter; the parser below reads it back.
export const CONTINUATION_LOG_PREFIX = '[continuation]'

// How long a POST may hang before we give up waiting for the ACK.
//
// A warm receiver claims and returns in well under a second (it defers the
// real work to its own waitUntil). A COLD one does not: this is a Next.js
// route with maxDuration 800s, and prod showed >9s between handler entry and
// the claim write. 10s produced false timeouts on handoffs that had actually
// landed, so give the cold path real headroom. Still bounded — a hung
// connection must never pin the yielding function open indefinitely.
export const CONTINUATION_TIMEOUT_MS = 30_000

// After a 2xx, how many times to re-check for the receiving segment's claim
// before concluding nobody took the job (≈15s of cover). Attempt-bounded
// rather than clock-bounded so the loop is deterministic and testable. Must
// comfortably exceed the observed cold-start-to-claim latency, or 'no_claim'
// is just a race report rather than a finding.
export const CLAIM_VERIFY_ATTEMPTS = 6
export const CLAIM_VERIFY_INTERVAL_MS = 3_000

// ─── outcome classification ──────────────────────────────────────

/**
 * Classify the HTTP result of a continuation POST. A redirect is a FAILURE:
 * Vercel Deployment Protection redirects an SSO-gated origin to a login page
 * before the route runs, and `redirect: 'manual'` surfaces that through undici
 * as an opaqueredirect (type='opaqueredirect', status=0) rather than a real
 * 3xx — so status 0 must read as blocked, never as an ambiguous "ok:false".
 */
export function classifyContinuationResponse(res: {
  status: number
  type?: string
}): { outcome: Extract<ContinuationOutcome, 'landed' | 'bounced'>; redirect: boolean } {
  const redirect =
    (res as any).type === 'opaqueredirect' ||
    res.status === 0 ||
    (res.status >= 300 && res.status < 400)
  const ok = !redirect && res.status >= 200 && res.status < 300
  return { outcome: ok ? 'landed' : 'bounced', redirect }
}

// ─── sync_log message format ─────────────────────────────────────

export type ContinuationAttempt = {
  source: ContinuationSource
  outcome: ContinuationOutcome
  at: string          // ISO timestamp (sync_log.created_at)
}

/**
 * Render a continuation attempt as a sync_log message. Machine-parseable
 * `key=value` pairs after the prefix, then free-text detail for a human.
 */
export function formatContinuationLogMessage(a: {
  source: ContinuationSource
  outcome: ContinuationOutcome
  jobId: string
  status?: number
  detail?: string
}): string {
  const parts = [
    CONTINUATION_LOG_PREFIX,
    `source=${a.source}`,
    `outcome=${a.outcome}`,
    `job=${a.jobId}`,
  ]
  if (a.status !== undefined) parts.push(`status=${a.status}`)
  const line = parts.join(' ')
  return a.detail ? `${line} — ${a.detail}` : line
}

/**
 * Read a continuation attempt back out of a sync_log message. Returns null for
 * any row that isn't a continuation record (sync_log is shared with the
 * import summary + webhook rows), so callers can filter safely.
 */
export function parseContinuationLogMessage(
  message: string | null | undefined,
): { source: ContinuationSource; outcome: ContinuationOutcome } | null {
  if (!message || !message.startsWith(CONTINUATION_LOG_PREFIX)) return null
  const source = /\bsource=(\w+)/.exec(message)?.[1]
  const outcome = /\boutcome=(\w+)/.exec(message)?.[1]
  if (source !== 'self_chain' && source !== 'sweeper') return null
  if (
    outcome !== 'landed' &&
    outcome !== 'no_claim' &&
    outcome !== 'bounced' &&
    outcome !== 'errored'
  ) {
    return null
  }
  return { source, outcome }
}

// ─── consecutive-bounce run ──────────────────────────────────────

/**
 * Given this job's continuation attempts NEWEST-FIRST, return the timestamp
 * (ms) of the OLDEST hard bounce in the current consecutive run — i.e. the
 * moment the handoff last stopped working. Walking stops at any attempt that
 * does NOT age the run (see agesBounceRun), so an earlier already-recovered
 * stall — and any ambiguous no_claim/timeout — never ages a healthy job.
 *
 * Returns null when the newest attempt isn't a hard bounce, or when there are
 * no attempts at all — a job we have never tried to continue is not "stuck",
 * it is simply waiting for its first re-poke, and must never be failed out on
 * that basis.
 */
export function consecutiveBounceStartMs(
  attempts: Array<{ at: string; outcome: ContinuationOutcome }>,
): number | null {
  let oldest: number | null = null
  for (const a of attempts) {
    if (!agesBounceRun(a.outcome)) break     // landing, or ambiguous — run ends
    const ms = Date.parse(a.at)
    if (Number.isFinite(ms)) oldest = ms     // keep walking back
  }
  return oldest
}

// ─── fail-out decision ───────────────────────────────────────────

export type FailOutDecision = {
  fail: boolean
  reason: 'stale_claim' | 'bouncing' | 'awaiting_pickup'
  stalledMs: number
}

/**
 * Decide whether a job the sweeper found is hopeless.
 *
 * CRITICAL: `started_at` is NOT an input. Job age is not stall age — conflating
 * them is what capped every import at 15 minutes. There are exactly two ways a
 * job can be genuinely stuck, and both have a real signal:
 *
 *   • A claim is held but has gone stale → a segment claimed and then died
 *     mid-flight without releasing. Age it from the claim.
 *   • No claim, and every continuation attempt since the last landing has
 *     bounced → the handoff itself is broken (a gated origin, a dead route).
 *     Age it from the start of that bounce run.
 *
 * Everything else — most importantly a cleanly-yielded job with a null claim
 * and no recorded bounces, which is the NORMAL state between the segments of a
 * long import — is 'awaiting_pickup': re-poke it, never fail it.
 */
export function decideFailOut(input: {
  claimAt: string | null | undefined
  nowMs: number
  failAfterMs: number
  /** From consecutiveBounceStartMs() — null when nothing is bouncing. */
  bounceRunStartMs: number | null
}): FailOutDecision {
  const claimMs = input.claimAt ? Date.parse(input.claimAt) : NaN

  if (Number.isFinite(claimMs)) {
    // A segment holds (or held) the claim. Staleness here is real evidence.
    const stalledMs = input.nowMs - claimMs
    return {
      fail: stalledMs > input.failAfterMs,
      reason: 'stale_claim',
      stalledMs,
    }
  }

  // Null (or unparseable) claim → cleanly yielded, or never claimed.
  if (input.bounceRunStartMs === null) {
    return { fail: false, reason: 'awaiting_pickup', stalledMs: 0 }
  }
  const stalledMs = input.nowMs - input.bounceRunStartMs
  return {
    fail: stalledMs > input.failAfterMs,
    reason: 'bouncing',
    stalledMs,
  }
}

/** Human-readable error_message for a job the sweeper gives up on. */
export function failOutMessage(d: {
  reason: FailOutDecision['reason']
  stalledMs: number
  failAfterMs: number
  phase?: string | null
  processed?: number | null
  total?: number | null
}): string {
  const mins = Math.round(d.stalledMs / 60000)
  const ceiling = Math.round(d.failAfterMs / 60000)
  const cause =
    d.reason === 'bouncing'
      ? `every continuation re-poke has failed to land for ${mins}m ` +
        `(the import route was unreachable — check sync_log for ` +
        `"${CONTINUATION_LOG_PREFIX}" rows to see why)`
      : `a segment claimed this job and then died without releasing it; ` +
        `no progress for ${mins}m`
  const progress =
    d.total ? ` Last phase: ${d.phase || 'unknown'} (${d.processed ?? 0}/${d.total}).` : ''
  return (
    `Import stalled — ${cause} (max-lifetime fail-out at ${ceiling}m).` +
    `${progress} Re-sync to resume from where it stopped.`
  )
}

// ─── recording ───────────────────────────────────────────────────

/**
 * Persist one continuation attempt + its outcome to sync_log. Never throws
 * (writeSyncLog swallows), so recording can never itself break a handoff.
 *
 * entity_type 'location' — the sync_log CHECK constraint has no 'import'
 * member, and the attempt is scoped to a location's import, not to a record.
 */
export async function recordContinuationAttempt(a: {
  jobId: string
  locationSlug: string
  source: ContinuationSource
  outcome: ContinuationOutcome
  status?: number
  detail?: string
  write?: typeof writeSyncLog
}): Promise<void> {
  const write = a.write ?? writeSyncLog
  await write({
    location_id: a.locationSlug,
    entity_id: a.locationSlug,
    entity_type: 'location',
    direction: 'inbound',
    status: isFailedOutcome(a.outcome) ? 'error' : 'success',
    message: formatContinuationLogMessage({
      source: a.source,
      outcome: a.outcome,
      jobId: a.jobId,
      status: a.status,
      detail: a.detail,
    }),
  })
}

// ─── the POST itself ─────────────────────────────────────────────

export function continuationUrl(origin: string, locationSlug: string): string {
  return (
    `${origin.replace(/\/+$/, '')}/api/import/jobber-clients` +
    `?location_id=${encodeURIComponent(locationSlug)}&_continue=1`
  )
}

export type ContinuationPostResult = {
  outcome: ContinuationOutcome
  status?: number
  redirectedTo?: string
  detail?: string
}

/**
 * Fire one continuation POST and classify the result.
 *
 * AWAITED, never fire-and-forget: the caller must still be holding the
 * function open (inside runImport's own waitUntil, or inside the sweeper's
 * request) when this resolves. A nested waitUntil() would be a silent no-op —
 * see the header note.
 *
 * `redirect: 'manual'` so an SSO login redirect is caught rather than followed
 * to a misleading 200 HTML page. AbortSignal caps a hung connection.
 */
export async function postContinuation(opts: {
  origin: string
  locationSlug: string
  secret: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<ContinuationPostResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const url = continuationUrl(opts.origin, opts.locationSlug)
  const timeoutMs = opts.timeoutMs ?? CONTINUATION_TIMEOUT_MS

  // AbortSignal.timeout isn't available in every runtime this file loads in
  // (and is easier to stub in tests) — build the controller by hand.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'x-import-continue-secret': opts.secret },
      redirect: 'manual',
      signal: controller.signal,
    })
    const { outcome, redirect } = classifyContinuationResponse(res as any)
    const redirectedTo = redirect ? res.headers?.get?.('location') ?? undefined : undefined
    return {
      outcome,
      status: res.status,
      redirectedTo,
      detail: redirect
        ? `blocked by a redirect to ${redirectedTo ?? 'an unknown location'} — ` +
          `origin ${opts.origin} looks SSO-gated`
        : outcome === 'bounced'
          ? `import route returned ${res.status}`
          : undefined,
    }
  } catch (err: any) {
    const aborted = err?.name === 'AbortError' || controller.signal.aborted
    return {
      outcome: 'errored',
      detail: aborted
        ? `continuation POST timed out after ${timeoutMs}ms`
        : String(err?.message || err),
    }
  } finally {
    clearTimeout(timer)
  }
}
