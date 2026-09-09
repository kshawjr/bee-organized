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
// WHICH MECHANISM IS PRIMARY (settled by prod, 2026-07-22):
// THE CRON SWEEPER IS PRIMARY. The self-chain is only an accelerator. This is
// not a preference — it is a platform limit: a function that keeps invoking
// itself eventually gets HTTP 508 Loop Detected from Vercel's recursion guard,
// no matter how the call is made. The real loc_kc import hit exactly that at
// ~3,340 of 3,352 records; the sweeper (invoked by cron, so a fresh chain)
// picked it up and carried the job to 'completed'. So a 508 must be treated as
// a normal handoff to the sweeper, never as a fault and never as evidence for
// failing a job out.
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
import { formatSecretMatch } from './secret-fingerprint'

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
//   chain_capped — HTTP 508 Loop Detected. Vercel's recursion guard refusing
//               a function that has invoked itself too many times. NOT an
//               error: it is the platform capping the self-chain, and the
//               sweeper (cron-originated, so a fresh invocation chain) takes
//               over by design. Observed on the real loc_kc import at ~3,340
//               of 3,352 records; the sweeper carried it to 'completed'.
//   dispatched — the POST was SENT and the connection deliberately released
//               without waiting for the reply. Since the segment now runs
//               INSIDE the request (the handoff fix), a reply means "the whole
//               segment finished", which can be ~600s away — far past any
//               timeout a once-a-minute cron can hold. So the caller fires and
//               lets the CLAIM VERIFICATION decide the truth, which was always
//               the honest signal. Never a failure on its own; the sweeper
//               resolves it to 'landed' or 'no_claim' from DB state.
export type ContinuationOutcome = 'landed' | 'no_claim' | 'bounced' | 'errored' | 'chain_capped' | 'dispatched'

// Vercel returns this when a function invokes itself past the platform's
// recursion limit. It is the reason THE SWEEPER IS THE PRIMARY MECHANISM and
// the self-chain is only an accelerator: a long import cannot be carried by
// self-invocation alone, no matter how the call is made.
export const LOOP_DETECTED_STATUS = 508

/**
 * Outcomes that represent an actual PROBLEM — drives the sync_log row's
 * status and whether the digest calls it out. NOT whether the job is failed
 * out (that is agesBounceRun).
 *
 * 'chain_capped' is excluded deliberately: the platform capping a self-chain
 * is the designed fallback engaging, not a fault, and every long import will
 * emit some. Alarming on it would make the digest noise that nobody reads.
 */
export const isFailedOutcome = (o: ContinuationOutcome): boolean =>
  o !== 'landed' && o !== 'chain_capped' && o !== 'dispatched'

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
 *   • 'chain_capped' — a 508 says the SELF-CHAIN is depth-capped; it says
 *     nothing about the sweeper, which runs on its own invocation chain and
 *     is the primary mechanism. loc_kc 508'd twice at ~3,340/3,352 and the
 *     sweeper still carried it to 'completed'.
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

// The bound used when the caller does NOT wait for the reply (awaitResponse
// false). It exists only so a genuinely dead socket is eventually released —
// never to cut a live segment short, so it sits just past the import route's
// 800s maxDuration. The caller is not held open by it: not awaiting is what
// guarantees that, and this timer only ever reaps the connection.
export const DISPATCH_ABORT_MS = 810_000

// How long to wait for a reply before concluding "the segment is running".
// Comfortably longer than any fast rejection (gate redirect, 401, 5xx, 508),
// far shorter than a real segment.
export const DISPATCH_PROBE_MS = 10_000

// Captured at module load, ON PURPOSE. Tests legitimately stub global
// setTimeout to make their own waits instant; the probe must still measure
// real elapsed time or it fires before any fetch can answer and every reply
// reads as "still running". Production behaviour is identical either way.
const timerFn: typeof setTimeout = setTimeout

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
}): {
  outcome: Extract<ContinuationOutcome, 'landed' | 'bounced' | 'chain_capped'>
  redirect: boolean
} {
  const redirect =
    (res as any).type === 'opaqueredirect' ||
    res.status === 0 ||
    (res.status >= 300 && res.status < 400)
  // Checked BEFORE the generic non-2xx bucket: a 508 is the platform capping
  // self-invocation, not a broken handoff, and must never age a job.
  if (!redirect && res.status === LOOP_DETECTED_STATUS) {
    return { outcome: 'chain_capped', redirect: false }
  }
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
    outcome !== 'errored' &&
    outcome !== 'chain_capped' &&
    outcome !== 'dispatched'
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
  /** What answered — content-type, differing final URL, body snippet. Absent
   *  when the fetch threw, since there was no response to describe. */
  evidence?: string
}

// ─── what actually answered ──────────────────────────────────────

// How much of the body to keep. Enough to tell an import route's JSON from a
// login page's <!doctype html>, short enough to sit in a sync_log message.
export const RESPONSE_SNIPPET_MAX = 160

/**
 * Describe WHAT ANSWERED, not just that something did.
 *
 * THE PHILADELPHIA SUBURBS STALL (2026-09-02, loc_phillysuburbs, 1,606 of
 * 18,883): the sweeper logged `outcome=landed status=200` about 4,300 times
 * while Vercel showed the import route ran THREE times in three days. So ~4,300
 * "successes" were recorded for requests that never reached the route.
 *
 * A 2xx proves SOMETHING answered. It does not prove the import route
 * answered. An SSO login page answers 200 with HTML and is indistinguishable
 * from a successful resume at the status-code level, and `redirect: 'manual'`
 * only catches a redirect it is actually shown — an origin that rewrites, or
 * serves the gate inline, never shows one.
 *
 * So record the three things that tell them apart: the content-type (JSON vs
 * HTML), the final URL when it differs from the one we asked for, and a short
 * body snippet. This is a DIAGNOSTIC. It changes no classification: a 2xx is
 * still 'landed', the same URL and header still go out, redirect is still
 * 'manual'. It only makes the remaining hop — the sweeper's fetch reaching the
 * route — readable instead of assumed.
 *
 * The body read is guarded: an unreadable body records that fact and must
 * never break the retry. A handoff that throws because we tried to look at it
 * would be a worse bug than the one we are diagnosing.
 */
export async function describeResponse(
  res: { headers?: any; url?: string; text?: () => Promise<string> },
  requestUrl: string,
): Promise<string> {
  const bits: string[] = []

  let contentType = ''
  try {
    contentType = String(res?.headers?.get?.('content-type') ?? '')
  } catch {
    contentType = ''
  }
  bits.push(`content-type=${contentType || 'none'}`)

  // Only when it DIFFERS — logging the URL we just asked for on every one of
  // ~4,300 attempts is noise that hides the one line that matters.
  const finalUrl = String(res?.url ?? '')
  if (finalUrl && finalUrl !== requestUrl) bits.push(`final-url=${finalUrl}`)

  let snippet: string
  try {
    const body = await res.text!()
    snippet = String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, RESPONSE_SNIPPET_MAX)
    if (!snippet) snippet = '(empty)'
  } catch {
    snippet = 'response body unreadable'
  }
  bits.push(`body="${snippet}"`)

  return bits.join('; ')
}

/** Join a classification detail with the captured evidence; either may be absent. */
export function withEvidence(detail: string | undefined, evidence: string | undefined): string | undefined {
  if (!detail) return evidence
  if (!evidence) return detail
  return `${detail} — ${evidence}`
}

/**
 * Classify a continuation response and attach the evidence of what answered.
 * Shared by both paths — the awaited one and the fire-then-probe one — so a
 * reply that arrives quickly is read identically however it was requested.
 */
async function classifyAndDescribe(
  res: { status: number; type?: string; headers?: any; url?: string; text?: () => Promise<string> },
  requestUrl: string,
  origin: string,
): Promise<ContinuationPostResult> {
  const { outcome, redirect } = classifyContinuationResponse(res as any)
  const redirectedTo = redirect ? res.headers?.get?.('location') ?? undefined : undefined
  // EVERY outcome, 'landed' included. The success path used to hold the
  // response and throw it away, which is exactly why ~4,300 landed rows say
  // nothing about what answered.
  const evidence = await describeResponse(res as any, requestUrl)
  const classified = redirect
    ? `blocked by a redirect to ${redirectedTo ?? 'an unknown location'} — ` +
      `origin ${origin} looks SSO-gated`
    : outcome === 'chain_capped'
      ? `self-chain depth-capped by the platform (HTTP ${LOOP_DETECTED_STATUS} ` +
        `Loop Detected) — the cron sweeper continues from here, as designed`
      : outcome === 'bounced'
        ? `import route returned ${res.status}`
        : undefined
  return {
    outcome,
    status: res.status,
    redirectedTo,
    evidence,
    detail: withEvidence(classified, evidence),
  }
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
  /**
   * Wait for the reply (default true), or fire and release the connection.
   *
   * FALSE IS FOR CALLERS THAT CANNOT WAIT. The segment now runs INSIDE the
   * request — that is the handoff fix; nothing is detached, so nothing can be
   * dropped. The consequence is that a reply now means "the entire segment
   * finished", up to TIME_BUDGET_MS (600s) away. No caller here can hold that:
   * the sweeper is a once-a-minute cron with no maxDuration override, and
   * selfContinue runs INSIDE a segment that is itself on an 800s ceiling —
   * awaiting there would nest segment inside segment until the ceiling blew.
   *
   * So those two fire and let the CLAIM VERIFICATION decide, which was always
   * the honest signal: a 2xx never proved a segment took the job, and a held
   * claim always did. A dead socket is still bounded (DISPATCH_ABORT_MS), and
   * not awaiting is what keeps a hung connection from pinning the caller open.
   */
  awaitResponse?: boolean
  /** Probe window for awaitResponse:false. Defaults to DISPATCH_PROBE_MS. */
  probeMs?: number
}): Promise<ContinuationPostResult> {
  const doFetch = opts.fetchImpl ?? fetch
  const url = continuationUrl(opts.origin, opts.locationSlug)
  const awaitResponse = opts.awaitResponse !== false

  // ─── DIAGNOSTIC (temporary — Kevin removes this) ─────────────────────────
  // The other half of the [secret-match] pair. The route records what it
  // RECEIVED and what it compares against; this records what the sweeper is
  // about to SEND. Two rows, one from each end, is what makes the question
  // answerable: if both are present and the sha8s differ, the sweeper is
  // reading a different CRON_SECRET than the route does. If the route's row
  // says header=absent while this one says present, it was stripped in
  // transit.
  //
  // NEVER the secret itself — presence, length, truncated sha256 only.
  // Skipped when there is no secret to send AND none configured, so a
  // misconfigured local run does not spam the log.
  try {
    await writeSyncLog({
      location_id: opts.locationSlug,
      entity_id: opts.locationSlug,
      entity_type: 'location',
      direction: 'outbound',
      status: 'success',
      message: formatSecretMatch({
        side: 'sweeper',
        headerValue: opts.secret,
        envValue: process.env.CRON_SECRET,
        origin: opts.origin,
        note: awaitResponse ? 'awaiting' : 'dispatch',
      }),
    })
  } catch { /* a diagnostic must never break a handoff */ }

  if (!awaitResponse) {
    // FIRE, THEN PROBE BRIEFLY.
    //
    // Every FAILURE mode of this handoff is fast — an SSO gate redirects, a
    // bad secret 401s, a dead route 5xxs, the platform 508s — all decided
    // before the route does any work. Every SUCCESS is slow: the segment runs
    // inside the request now and takes minutes. So a short probe separates
    // them cleanly. If a reply lands inside the probe window we classify it
    // exactly as before, evidence and all — the SSO detection that mattered
    // in the loc_kc incident is NOT lost. If nothing lands, the segment is
    // running and the claim check decides.
    //
    // The request is NEVER aborted at the probe: the hard abort sits past the
    // route's own 800s ceiling and exists only to reap a dead socket. Cutting
    // the connection on a healthy segment could take the segment with it.
    const controller = new AbortController()
    const hardTimer = timerFn(() => controller.abort(), DISPATCH_ABORT_MS)
    // A synchronous throw (bad URL, no fetch impl) never even leaves the box —
    // catch it here rather than letting it escape past the probe.
    let settled: Promise<{ kind: 'res'; res: any } | { kind: 'err'; err: any }>
    try {
      settled = doFetch(url, {
        method: 'POST',
        headers: { 'x-import-continue-secret': opts.secret },
        redirect: 'manual',
        signal: controller.signal,
      }).then(
        (res) => ({ kind: 'res' as const, res }),
        (err) => ({ kind: 'err' as const, err }),
      )
    } catch (err: any) {
      clearTimeout(hardTimer)
      return { outcome: 'errored', detail: String(err?.message || err) }
    }
    const probe = new Promise<{ kind: 'probe' }>((resolve) =>
      timerFn(() => resolve({ kind: 'probe' }), opts.probeMs ?? DISPATCH_PROBE_MS),
    )

    const first = await Promise.race([settled, probe])

    if (first.kind === 'probe') {
      // Still in flight — the segment is running. Let go, but keep the
      // rejection handled so an eventual failure is never unhandled.
      void settled.then(() => clearTimeout(hardTimer), () => clearTimeout(hardTimer))
      return {
        outcome: 'dispatched',
        detail:
          `no reply within ${Math.round((opts.probeMs ?? DISPATCH_PROBE_MS) / 1000)}s — ` +
          `the segment runs inside the request, so this is the healthy case; ` +
          `the claim check decides`,
      }
    }

    clearTimeout(hardTimer)
    if (first.kind === 'err') {
      const aborted = (first.err as any)?.name === 'AbortError' || controller.signal.aborted
      return {
        outcome: 'errored',
        detail: aborted
          ? `continuation POST aborted after ${DISPATCH_ABORT_MS}ms`
          : String((first.err as any)?.message || first.err),
      }
    }
    return await classifyAndDescribe(first.res as any, url, opts.origin)
  }

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
    return await classifyAndDescribe(res as any, url, opts.origin)
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
