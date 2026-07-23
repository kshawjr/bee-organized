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
