// @vitest-environment node
//
// The continuation handoff's decision logic (lib/import-continuation.ts).
//
// The bug these pin: the sweeper aged a stalled job as
//   now - (location_claim_at || started_at)
// After a GRACEFUL yield location_claim_at is NULL by design, so it fell back
// to started_at — the time the whole job began — and any job older than the
// 15-minute ceiling was marked 'failed' at its very next clean yield, WITHOUT
// EVER BEING RE-POKED. Prod: loc_kc (3,352 records → ~9 segments) died at
// 636/3352 and again at 2067/3352 on 2026-07-22, each time with
// "no progress for Nm" where N == exactly (completed_at − started_at).
//
// decideFailOut therefore does not accept started_at at all. Job age is not
// stall age.
import { describe, it, expect, vi } from 'vitest'
import {
  classifyContinuationResponse,
  formatContinuationLogMessage,
  parseContinuationLogMessage,
  consecutiveBounceStartMs,
  decideFailOut,
  failOutMessage,
  recordContinuationAttempt,
  continuationUrl,
  postContinuation,
  isFailedOutcome,
  agesBounceRun,
  CONTINUATION_LOG_PREFIX,
  CONTINUATION_TIMEOUT_MS,
  RESPONSE_SNIPPET_MAX,
  withEvidence,
} from './import-continuation'

const MIN = 60_000
const NOW = Date.parse('2026-07-22T21:00:00.000Z')
const ago = (mins: number) => new Date(NOW - mins * MIN).toISOString()
const FAIL_AFTER = 15 * MIN

// ── classification ───────────────────────────────────────────────
describe('classifyContinuationResponse', () => {
  it('2xx is a landing', () => {
    expect(classifyContinuationResponse({ status: 200 })).toEqual({ outcome: 'landed', redirect: false })
  })

  it('an opaqueredirect (redirect:manual + SSO gate) is a bounce, not a landing', () => {
    // undici surfaces a blocked redirect as type='opaqueredirect', status=0.
    expect(classifyContinuationResponse({ status: 0, type: 'opaqueredirect' }))
      .toEqual({ outcome: 'bounced', redirect: true })
  })

  it('a raw 302 is a bounce', () => {
    expect(classifyContinuationResponse({ status: 302 })).toEqual({ outcome: 'bounced', redirect: true })
  })

  it('a 401 is a bounce but not a redirect', () => {
    expect(classifyContinuationResponse({ status: 401 })).toEqual({ outcome: 'bounced', redirect: false })
  })

  it('a 500 is a bounce', () => {
    expect(classifyContinuationResponse({ status: 500 }).outcome).toBe('bounced')
  })

  // Vercel's recursion guard. Observed on the real loc_kc import at ~3,340 of
  // 3,352 records — the self-chain got depth-capped and the cron sweeper (its
  // own invocation chain) carried the job to 'completed'.
  it('a 508 Loop Detected is chain_capped, NOT a bounce', () => {
    expect(classifyContinuationResponse({ status: 508 }))
      .toEqual({ outcome: 'chain_capped', redirect: false })
  })

  it('chain_capped never ages a job toward fail-out', () => {
    // A 508 says the self-chain is capped. It says nothing about the sweeper,
    // which is the primary mechanism — so it is not evidence of a broken
    // handoff and must never contribute to the fail-out clock.
    expect(agesBounceRun('chain_capped')).toBe(false)
    expect(consecutiveBounceStartMs([
      { at: ago(1), outcome: 'chain_capped' },
      { at: ago(2), outcome: 'chain_capped' },
    ])).toBeNull()
  })

  it('chain_capped is not reported as a problem (it is the designed fallback)', () => {
    // Every long import emits some; alarming on them makes the digest noise.
    expect(isFailedOutcome('chain_capped')).toBe(false)
  })

  it('a long run of 508s still cannot fail a job out', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ at: ago(i + 1), outcome: 'chain_capped' as const }))
    expect(decideFailOut({
      claimAt: null, nowMs: NOW, failAfterMs: FAIL_AFTER,
      bounceRunStartMs: consecutiveBounceStartMs(many),
    }).fail).toBe(false)
  })
})

// ── the sync_log round trip ──────────────────────────────────────
describe('continuation log message', () => {
  it('round-trips source + outcome', () => {
    const msg = formatContinuationLogMessage({
      source: 'sweeper', outcome: 'bounced', jobId: 'job-1', status: 0, detail: 'SSO gate',
    })
    expect(msg.startsWith(CONTINUATION_LOG_PREFIX)).toBe(true)
    expect(msg).toContain('job=job-1')
    expect(parseContinuationLogMessage(msg)).toEqual({ source: 'sweeper', outcome: 'bounced' })
  })

  it('round-trips the self-chain source', () => {
    const msg = formatContinuationLogMessage({ source: 'self_chain', outcome: 'landed', jobId: 'j' })
    expect(parseContinuationLogMessage(msg)).toEqual({ source: 'self_chain', outcome: 'landed' })
  })

  it('ignores unrelated sync_log rows (webhook + import-summary rows share the table)', () => {
    expect(parseContinuationLogMessage('Leads: 12 created, 3 updated; Errors: 0')).toBeNull()
    expect(parseContinuationLogMessage(null)).toBeNull()
    expect(parseContinuationLogMessage('')).toBeNull()
  })

  it('rejects a malformed continuation row rather than mis-parsing it', () => {
    expect(parseContinuationLogMessage(`${CONTINUATION_LOG_PREFIX} source=martians outcome=landed`)).toBeNull()
    expect(parseContinuationLogMessage(`${CONTINUATION_LOG_PREFIX} source=sweeper outcome=vibes`)).toBeNull()
  })
})

// ── the consecutive-bounce run ───────────────────────────────────
describe('consecutiveBounceStartMs', () => {
  it('no attempts at all → null (a job never re-poked is not "stuck")', () => {
    expect(consecutiveBounceStartMs([])).toBeNull()
  })

  it('newest attempt landed → null, even with older bounces behind it', () => {
    expect(consecutiveBounceStartMs([
      { at: ago(1), outcome: 'landed' },
      { at: ago(9), outcome: 'bounced' },
      { at: ago(20), outcome: 'bounced' },
    ])).toBeNull()
  })

  it('walks back to the OLDEST hard bounce in the current run', () => {
    expect(consecutiveBounceStartMs([
      { at: ago(1), outcome: 'bounced' },
      { at: ago(2), outcome: 'bounced' },
      { at: ago(3), outcome: 'bounced' },
    ])).toBe(NOW - 3 * MIN)
  })

  // Observed in prod: the receiving 800s route took >9s from handler entry to
  // its claim write, so an immediate re-read reported no_claim and a 10s POST
  // timeout reported errored — for handoffs that had actually landed. Aging a
  // job on that would kill healthy imports on a different clock.
  it('an ambiguous no_claim does NOT age the run (cold-start race, not evidence)', () => {
    expect(consecutiveBounceStartMs([{ at: ago(1), outcome: 'no_claim' }])).toBeNull()
  })

  it('an ambiguous timeout does NOT age the run', () => {
    expect(consecutiveBounceStartMs([{ at: ago(1), outcome: 'errored' }])).toBeNull()
  })

  it('an ambiguous outcome ENDS a run of hard bounces rather than extending it', () => {
    expect(consecutiveBounceStartMs([
      { at: ago(1), outcome: 'no_claim' },
      { at: ago(20), outcome: 'bounced' },
    ])).toBeNull()
  })

  it('only bounced ages the run', () => {
    expect(agesBounceRun('bounced')).toBe(true)
    expect(agesBounceRun('no_claim')).toBe(false)
    expect(agesBounceRun('errored')).toBe(false)
    expect(agesBounceRun('landed')).toBe(false)
  })

  it('stops at the last landing — an already-recovered stall never ages a healthy job', () => {
    // A long import: bounced for a while, recovered, now bouncing again.
    // Only the CURRENT run counts, so the clock restarts at the recovery.
    expect(consecutiveBounceStartMs([
      { at: ago(2), outcome: 'bounced' },
      { at: ago(3), outcome: 'bounced' },
      { at: ago(4), outcome: 'landed' },
      { at: ago(40), outcome: 'bounced' },
    ])).toBe(NOW - 3 * MIN)
  })

  it('skips unparseable timestamps without breaking the run', () => {
    expect(consecutiveBounceStartMs([
      { at: 'not-a-date', outcome: 'bounced' },
      { at: ago(5), outcome: 'bounced' },
    ])).toBe(NOW - 5 * MIN)
  })

  it('a run of ambiguous outcomes can NEVER reach the fail-out, however long', () => {
    // The safety property: no amount of racy evidence kills a job.
    const many = Array.from({ length: 40 }, (_, i) => ({
      at: ago(i + 1), outcome: (i % 2 ? 'no_claim' : 'errored') as const,
    }))
    expect(consecutiveBounceStartMs(many)).toBeNull()
    expect(decideFailOut({
      claimAt: null, nowMs: NOW, failAfterMs: FAIL_AFTER,
      bounceRunStartMs: consecutiveBounceStartMs(many),
    }).fail).toBe(false)
  })
})

// ── the fail-out decision (the loc_kc regression) ────────────────
describe('decideFailOut', () => {
  it('THE REGRESSION: a cleanly-yielded job 40 minutes into a long import is NOT failed out', () => {
    // Exactly loc_kc: status='running', claim released by the graceful yield,
    // job started long ago. The old code aged this from started_at and killed
    // it on sight. It must be re-poked instead.
    const d = decideFailOut({ claimAt: null, nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: null })
    expect(d.fail).toBe(false)
    expect(d.reason).toBe('awaiting_pickup')
  })

  it('a segment holding a FRESH claim is healthy', () => {
    const d = decideFailOut({ claimAt: ago(1), nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: null })
    expect(d.fail).toBe(false)
    expect(d.reason).toBe('stale_claim')
    expect(d.stalledMs).toBe(1 * MIN)
  })

  it('a claim held and stale past the ceiling → failed out (segment died mid-flight)', () => {
    const d = decideFailOut({ claimAt: ago(20), nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: null })
    expect(d.fail).toBe(true)
    expect(d.reason).toBe('stale_claim')
    expect(d.stalledMs).toBe(20 * MIN)
  })

  it('a null-claim job whose re-pokes have ALL bounced past the ceiling → failed out', () => {
    const d = decideFailOut({
      claimAt: null, nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: NOW - 16 * MIN,
    })
    expect(d.fail).toBe(true)
    expect(d.reason).toBe('bouncing')
  })

  it('a null-claim job bouncing for only 5 minutes keeps getting re-poked', () => {
    const d = decideFailOut({
      claimAt: null, nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: NOW - 5 * MIN,
    })
    expect(d.fail).toBe(false)
  })

  it('started_at is not an input — a 4-hour-old job with a fresh claim is healthy', () => {
    // Belt and braces: the signature simply has nowhere to put job age.
    const d = decideFailOut({ claimAt: ago(0.5), nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: null })
    expect(d.fail).toBe(false)
  })

  it('an unparseable claim falls through to the null-claim path (never wrongly killed)', () => {
    const d = decideFailOut({ claimAt: 'garbage', nowMs: NOW, failAfterMs: FAIL_AFTER, bounceRunStartMs: null })
    expect(d.fail).toBe(false)
    expect(d.reason).toBe('awaiting_pickup')
  })
})

describe('failOutMessage', () => {
  it('a bouncing fail-out names the real cause and points at the sync_log trail', () => {
    const m = failOutMessage({
      reason: 'bouncing', stalledMs: 16 * MIN, failAfterMs: FAIL_AFTER,
      phase: 'batched — 636/3352, continuing (time budget)', processed: 636, total: 3352,
    })
    expect(m).toMatch(/re-poke has failed to land for 16m/)
    expect(m).toContain(CONTINUATION_LOG_PREFIX)
    expect(m).toContain('636/3352')
    // NOT the old misleading phrasing, which reported total job age as "no progress".
    expect(m).not.toMatch(/no progress for 16m/)
  })

  it('a stale-claim fail-out says the segment died without releasing', () => {
    const m = failOutMessage({ reason: 'stale_claim', stalledMs: 20 * MIN, failAfterMs: FAIL_AFTER })
    expect(m).toMatch(/died without releasing/)
    expect(m).toMatch(/no progress for 20m/)
  })
})

// ── recording ────────────────────────────────────────────────────
describe('recordContinuationAttempt', () => {
  it('writes a success row for a landing', async () => {
    const write = vi.fn(async () => {})
    await recordContinuationAttempt({
      jobId: 'j1', locationSlug: 'loc_kc', source: 'self_chain', outcome: 'landed', status: 200, write,
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toMatchObject({
      location_id: 'loc_kc', entity_type: 'location', status: 'success',
    })
  })

  it('writes an ERROR row for a bounce, so it surfaces as a problem', async () => {
    const write = vi.fn(async () => {})
    await recordContinuationAttempt({
      jobId: 'j1', locationSlug: 'loc_kc', source: 'sweeper', outcome: 'bounced', status: 0,
      detail: 'blocked by a redirect', write,
    })
    expect(write.mock.calls[0][0]).toMatchObject({ status: 'error' })
    expect(write.mock.calls[0][0].message).toContain('outcome=bounced')
  })

  it('every non-landed outcome is an error row', async () => {
    for (const o of ['bounced', 'errored', 'no_claim'] as const) {
      expect(isFailedOutcome(o)).toBe(true)
    }
    expect(isFailedOutcome('landed')).toBe(false)
  })
})

// ── the POST ─────────────────────────────────────────────────────
describe('postContinuation', () => {
  const OK = { status: 200, type: 'basic', headers: { get: () => null } }

  it('targets the import route with the internal secret and manual redirects', async () => {
    const fetchImpl = vi.fn(async () => OK) as any
    const r = await postContinuation({
      origin: 'https://beehive.beeorganized.com', locationSlug: 'loc_kc', secret: 's3cret', fetchImpl,
    })
    expect(r.outcome).toBe('landed')
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://beehive.beeorganized.com/api/import/jobber-clients?location_id=loc_kc&_continue=1')
    expect(opts.method).toBe('POST')
    expect(opts.headers['x-import-continue-secret']).toBe('s3cret')
    expect(opts.redirect).toBe('manual')
    expect(opts.signal).toBeDefined()   // hung connection can't pin the function open
  })

  it('reports an SSO redirect as a bounce with the destination', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 0, type: 'opaqueredirect', headers: { get: (k: string) => (k === 'location' ? 'https://vercel.com/sso' : null) },
    })) as any
    const r = await postContinuation({ origin: 'https://x.vercel.app', locationSlug: 'loc_kc', secret: 's', fetchImpl })
    expect(r.outcome).toBe('bounced')
    expect(r.redirectedTo).toBe('https://vercel.com/sso')
    expect(r.detail).toMatch(/SSO-gated/)
  })

  it('a thrown fetch is an errored outcome, not an unhandled rejection', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') }) as any
    const r = await postContinuation({ origin: 'https://x', locationSlug: 'loc_kc', secret: 's', fetchImpl })
    expect(r.outcome).toBe('errored')
    expect(r.detail).toContain('ECONNRESET')
  })

  it('a hung POST times out instead of holding the segment open forever', async () => {
    const fetchImpl = vi.fn((_u: any, opts: any) => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e)
      })
    })) as any
    const r = await postContinuation({
      origin: 'https://x', locationSlug: 'loc_kc', secret: 's', fetchImpl, timeoutMs: 10,
    })
    expect(r.outcome).toBe('errored')
    expect(r.detail).toMatch(/timed out/)
  })

  it('a 508 reports as chain_capped with a message naming the sweeper handoff', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 508, type: 'basic', headers: { get: () => null } })) as any
    const r = await postContinuation({ origin: 'https://x', locationSlug: 'loc_kc', secret: 's', fetchImpl })
    expect(r.outcome).toBe('chain_capped')
    expect(r.detail).toMatch(/Loop Detected/)
    expect(r.detail).toMatch(/sweeper/)
  })

  it('the ack timeout has real cold-start headroom', () => {
    // The receiver is a maxDuration-800s Next.js route; prod showed >9s from
    // handler entry to its claim write. 10s produced false timeouts.
    expect(CONTINUATION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('builds the continuation URL with an encoded slug and no double slash', () => {
    expect(continuationUrl('https://app.example.com/', 'loc kc'))
      .toBe('https://app.example.com/api/import/jobber-clients?location_id=loc%20kc&_continue=1')
  })
})

// ─── what actually answered ──────────────────────────────────────
//
// THE PHILADELPHIA SUBURBS STALL (loc_phillysuburbs, job f385d31d, stuck at
// 1,606 of 18,883 since 2026-09-02). The sweeper logged `outcome=landed
// status=200` about 4,300 times; Vercel shows /api/import/jobber-clients ran
// THREE times in three days. So ~4,300 "successes" were recorded for requests
// that never reached the route.
//
// A 2xx proves something answered, not that the import route answered. These
// pin the evidence that tells them apart. NOTHING here changes classification
// — a 2xx is still 'landed'; the diagnosis has to be readable without also
// being a behaviour change nobody asked for.
describe('postContinuation records WHAT answered, not just that something did', () => {
  const reply = (over: any = {}) => ({
    status: 200,
    type: 'basic',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    url: 'https://beehive.beeorganized.com/api/import/jobber-clients?location_id=loc_kc&_continue=1',
    text: async () => '{"ok":true,"job_id":"f385d31d-e7cc-46af-9a3f-db9ca3429056"}',
    ...over,
  })
  const post = (fetchImpl: any) =>
    postContinuation({ origin: 'https://beehive.beeorganized.com', locationSlug: 'loc_kc', secret: 's', fetchImpl })

  it('a real import reply shows its job_id in the detail', async () => {
    const r = await post(vi.fn(async () => reply()))
    expect(r.outcome).toBe('landed')
    expect(r.detail).toContain('content-type=application/json')
    expect(r.detail).toContain('f385d31d-e7cc-46af-9a3f-db9ca3429056')
  })

  it('an SSO login page answering 200 is STILL landed — but the detail gives it away', async () => {
    const r = await post(vi.fn(async () => reply({
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      text: async () => '<!doctype html>\n<html>\n  <head><title>Authentication Required</title></head>\n  <body>Sign in to continue</body>\n</html>',
    })))
    // classification is deliberately unchanged — this is a diagnostic
    expect(r.outcome).toBe('landed')
    expect(r.status).toBe(200)
    // ...and it is no longer indistinguishable from a real resume
    expect(r.detail).toContain('content-type=text/html')
    expect(r.detail).toContain('<!doctype html>')
    expect(r.detail).toContain('Authentication Required')
    // whitespace collapsed so the snippet stays one readable sync_log line
    expect(r.detail).not.toContain('\n')
  })

  it('a final URL that differs from the one we asked for is recorded', async () => {
    const r = await post(vi.fn(async () => reply({ url: 'https://vercel.com/sso/access?next=%2Fapi%2Fimport' })))
    expect(r.outcome).toBe('landed')
    expect(r.detail).toContain('final-url=https://vercel.com/sso/access')
  })

  it('a final URL equal to the target is NOT repeated — 4,300 rows of noise hides the one that matters', async () => {
    const r = await post(vi.fn(async () => reply()))
    expect(r.detail).not.toContain('final-url=')
  })

  it('an unreadable body records that, stays landed, and never breaks the retry', async () => {
    const r = await post(vi.fn(async () => reply({
      text: async () => { throw new Error('body already consumed') },
    })))
    expect(r.outcome).toBe('landed')
    expect(r.detail).toContain('response body unreadable')
  })

  it('the snippet is capped, so one enormous page cannot flood sync_log', async () => {
    const r = await post(vi.fn(async () => reply({ text: async () => 'x'.repeat(5000) })))
    expect(r.detail).toContain('x'.repeat(RESPONSE_SNIPPET_MAX))
    expect(r.detail).not.toContain('x'.repeat(RESPONSE_SNIPPET_MAX + 1))
  })

  it('an empty body says so rather than reading as a missing field', async () => {
    const r = await post(vi.fn(async () => reply({ text: async () => '   ' })))
    expect(r.detail).toContain('body="(empty)"')
  })

  it('a bounce keeps its classification detail AND gains the evidence', async () => {
    const r = await post(vi.fn(async () => reply({ status: 503, text: async () => 'upstream unavailable' })))
    expect(r.outcome).toBe('bounced')
    expect(r.detail).toContain('import route returned 503')
    expect(r.detail).toContain('upstream unavailable')
  })

  it('a thrown fetch has no response to describe, and still reports the throw', async () => {
    const r = await post(vi.fn(async () => { throw new Error('ECONNRESET') }))
    expect(r.outcome).toBe('errored')
    expect(r.detail).toContain('ECONNRESET')
    expect(r.evidence).toBeUndefined()
  })

  it('the URL, header, redirect mode and classification are untouched', async () => {
    const fetchImpl = vi.fn(async () => reply()) as any
    await post(fetchImpl)
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://beehive.beeorganized.com/api/import/jobber-clients?location_id=loc_kc&_continue=1')
    expect(opts.headers['x-import-continue-secret']).toBe('s')
    expect(opts.redirect).toBe('manual')
  })
})

describe('withEvidence — the sweeper appends, it does not overwrite', () => {
  it('keeps both halves', () => {
    expect(withEvidence('no segment claimed', 'content-type=text/html; body="<!doctype html>"'))
      .toBe('no segment claimed — content-type=text/html; body="<!doctype html>"')
  })
  it('tolerates either half being absent', () => {
    expect(withEvidence(undefined, 'content-type=none')).toBe('content-type=none')
    expect(withEvidence('no segment claimed', undefined)).toBe('no segment claimed')
    expect(withEvidence(undefined, undefined)).toBeUndefined()
  })
})

// ─── firing without waiting for the reply ────────────────────────
//
// The segment now runs INSIDE the request (the handoff fix), so a reply means
// "the whole segment finished" — up to 600s away. Neither caller can hold
// that: the sweeper is a once-a-minute cron with no maxDuration override, and
// selfContinue runs inside a segment already on an 800s ceiling. So they fire
// and let the claim verification decide.
//
// What must NOT be lost: every fast rejection — an SSO gate, a bad secret, a
// 5xx, a 508 — still has to be classified, because those are the failures that
// stranded loc_kc. They all answer in milliseconds, so a short probe catches
// them while never cutting a healthy segment short.
describe('postContinuation with awaitResponse:false', () => {
  const fire = (fetchImpl: any, probeMs = 50) =>
    postContinuation({
      origin: 'https://beehive.beeorganized.com',
      locationSlug: 'loc_phillysuburbs',
      secret: 's',
      fetchImpl,
      awaitResponse: false,
      probeMs,
    })

  it('a segment that keeps working reads as dispatched, not as a timeout failure', async () => {
    // Never answers within the probe — the healthy case now.
    const fetchImpl = vi.fn(() => new Promise(() => {})) as any
    const r = await fire(fetchImpl)
    expect(r.outcome).toBe('dispatched')
    expect(r.detail).toMatch(/claim check decides/)
    // and it is NOT a failure, so it neither alarms nor ages a job
    expect(isFailedOutcome('dispatched')).toBe(false)
    expect(agesBounceRun('dispatched')).toBe(false)
  })

  it('A HUNG CONNECTION NEVER PINS THE CALLER OPEN', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {})) as any
    const started = Date.now()
    const r = await fire(fetchImpl, 30)
    // Returned on the probe, not on the fetch — which never settles at all.
    expect(r.outcome).toBe('dispatched')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('the request is NOT aborted at the probe — that would kill a live segment', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_u: string, o: any) => { seenSignal = o.signal; return new Promise(() => {}) }) as any
    await fire(fetchImpl, 20)
    await new Promise((r) => setTimeout(r, 60))   // well past the probe
    expect(seenSignal?.aborted).toBe(false)
  })

  it('AN SSO GATE IS STILL CAUGHT — the loc_kc failure mode survives the change', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 0, type: 'opaqueredirect',
      headers: { get: (k: string) => (k === 'location' ? 'https://vercel.com/sso' : null) },
      text: async () => '',
    })) as any
    const r = await fire(fetchImpl)
    expect(r.outcome).toBe('bounced')          // NOT swallowed as 'dispatched'
    expect(r.redirectedTo).toBe('https://vercel.com/sso')
    expect(r.detail).toMatch(/SSO-gated/)
    expect(agesBounceRun('bounced')).toBe(true) // and it still ages the job
  })

  it('a fast 5xx is still a bounce, with its evidence', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 503, type: 'basic',
      headers: { get: () => null },
      text: async () => 'upstream unavailable',
    })) as any
    const r = await fire(fetchImpl)
    expect(r.outcome).toBe('bounced')
    expect(r.detail).toContain('import route returned 503')
    expect(r.detail).toContain('upstream unavailable')
  })

  it('a 508 is still the designed self-chain handoff, not a fault', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 508, type: 'basic', headers: { get: () => null }, text: async () => '',
    })) as any
    const r = await fire(fetchImpl)
    expect(r.outcome).toBe('chain_capped')
    expect(agesBounceRun('chain_capped')).toBe(false)
  })

  it('a synchronous throw is reported, not swallowed as dispatched', async () => {
    const fetchImpl = vi.fn(() => { throw new Error('bad url') }) as any
    const r = await fire(fetchImpl)
    expect(r.outcome).toBe('errored')
    expect(r.detail).toContain('bad url')
  })

  it('a rejected fetch inside the probe window is errored, and never unhandled', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') }) as any
    const r = await fire(fetchImpl)
    expect(r.outcome).toBe('errored')
    expect(r.detail).toContain('ECONNRESET')
  })

  it('the default is still to wait — only callers that must, opt out', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200, type: 'basic', headers: { get: () => null }, text: async () => '{"ok":true}',
    })) as any
    const r = await postContinuation({
      origin: 'https://x', locationSlug: 'loc_kc', secret: 's', fetchImpl,
    })
    expect(r.outcome).toBe('landed')
  })

  it('a dispatched attempt round-trips through the sync_log format', () => {
    const msg = formatContinuationLogMessage({
      source: 'sweeper', outcome: 'dispatched', jobId: 'job-1',
    })
    expect(parseContinuationLogMessage(msg)).toEqual({ source: 'sweeper', outcome: 'dispatched' })
  })
})
