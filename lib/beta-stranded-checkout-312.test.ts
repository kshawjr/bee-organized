// @vitest-environment node
//
// Stranded checkout alerts (issue 312).
//
// The failure this pins: an owner completed Stripe checkout, the session came
// back unpaid, the webhook wrote sync_log status='success' landed='na' — a row
// the failure-alerts allowlist (not_landed only) could never be a candidate
// for — and nothing anywhere said a paying owner was locked out. Money taken,
// infinite spinner, silence in Slack.
//
// What these tests pin:
//   1) a stranded checkout past the window raises EXACTLY ONE alert, ever
//   2) an async payment still INSIDE the window raises none
//   3) a settled payment stops the alert — both ways it can settle: a later
//      terminal row for the session, and the location simply going active
//   4) a card checkout never triggers it — the row it would need is never
//      written (route) and never selected (fetch scope)
//   5) the fetch shifts its bounds by one strand window, so a row that is
//      90 minutes old is evaluated in TODAY's window, not the one it was
//      written in
//   6) the alert says a person is waiting, not that a row exists
//   7) blast radius: the ops rail only — no slack-bot.ts, no new cron

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import {
  selectNewAlerts,
  buildAlertMessage,
  fetchPendingCheckouts,
  fetchCheckoutResolutions,
  collectFailureAlerts,
  ALERT_SETTLE_MS,
  STRANDED_CHECKOUT_MS,
  type PendingCheckoutRow,
  type LocationBillingState,
} from '@/lib/failure-alerts'

const NOW = Date.parse('2026-08-19T16:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

const CUTOFF = NOW - ALERT_SETTLE_MS   // 15:55
const SINCE = NOW - 10 * MIN           // 15:50

// A checkout whose STRAND MOMENT lands inside (SINCE, CUTOFF].
const STRAND_AT = NOW - 8 * MIN        // 15:52
const CREATED = STRAND_AT - STRANDED_CHECKOUT_MS

const NAMES = new Map([['loc_kc', 'Kansas City']])
const billing = (status: string | null) =>
  new Map<string, LocationBillingState>([['loc_kc', { status }]])

function run(over: {
  pendingCheckouts?: PendingCheckoutRow[]
  locBilling?: Map<string, LocationBillingState>
  resolvedSessions?: Set<string>
  sinceMs?: number
  cutoffMs?: number
  nowMs?: number
}) {
  return selectNewAlerts({
    events: [],
    importFailed: [],
    mismatches: [],
    locName: NAMES,
    pendingCheckouts: over.pendingCheckouts ?? [],
    locBilling: over.locBilling,
    resolvedSessions: over.resolvedSessions,
    sinceMs: over.sinceMs ?? SINCE,
    cutoffMs: over.cutoffMs ?? CUTOFF,
    nowMs: over.nowMs ?? NOW,
  })
}

const pending = (over: Partial<PendingCheckoutRow> = {}): PendingCheckoutRow => ({
  created_at: iso(CREATED),
  entity_id: 'cs_live_a1ZGpe2rgeKq0JS1Ho0jqeqkxsbaXJt1sBNJeELHIWd1Tk2mVtH6rTMdS1',
  location_id: 'loc_kc',
  ...over,
})

// ── 1. the strand fires, exactly once ─────────────────────────────────
describe('a stranded checkout past the window raises exactly one alert', () => {
  it('fires once when the location never went active', () => {
    const items = run({ pendingCheckouts: [pending()], locBilling: billing('onboarding') })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('checkout_stranded')
  })

  it('is alerted in exactly ONE window — the next window is silent', () => {
    const first = run({ pendingCheckouts: [pending()], locBilling: billing('onboarding') })
    expect(first).toHaveLength(1)
    // The watermark advances to this run's cutoff; the same row is re-read
    // next run (its created_at is still inside the shifted fetch bounds) and
    // must NOT alert again.
    const second = run({
      pendingCheckouts: [pending()],
      locBilling: billing('onboarding'),
      sinceMs: CUTOFF,
      cutoffMs: NOW,
      nowMs: NOW + ALERT_SETTLE_MS,
    })
    expect(second).toHaveLength(0)
  })

  it('a row with no location still alerts, says so, and points at Stripe', () => {
    // Pre-312 rows recorded no location; the strand is still real and the
    // alert must not guess at a name it does not have.
    const items = run({ pendingCheckouts: [pending({ location_id: null })], locBilling: billing('onboarding') })
    expect(items).toHaveLength(1)
    expect(items[0].text).toContain('an unidentified location')
    expect(items[0].text).toContain('open it in Stripe to see who')
  })

  it('fires per stranded session, not per location', () => {
    const items = run({
      pendingCheckouts: [
        pending({ entity_id: 'cs_a' }),
        pending({ entity_id: 'cs_b', created_at: iso(CREATED + MIN) }),
      ],
      locBilling: billing('onboarding'),
    })
    expect(items).toHaveLength(2)
  })
})

// ── 2. still inside the window → silence ──────────────────────────────
describe('an async payment inside the window raises none', () => {
  it('a checkout 20 minutes old has not stranded yet', () => {
    const items = run({
      pendingCheckouts: [pending({ created_at: iso(NOW - 20 * MIN) })],
      locBilling: billing('onboarding'),
    })
    expect(items).toHaveLength(0)
  })

  it('one minute short of the window is still silent; one minute past fires', () => {
    const justShort = run({
      pendingCheckouts: [pending({ created_at: iso(CUTOFF - STRANDED_CHECKOUT_MS + MIN) })],
      locBilling: billing('onboarding'),
    })
    expect(justShort).toHaveLength(0)
    const justPast = run({
      pendingCheckouts: [pending({ created_at: iso(CUTOFF - STRANDED_CHECKOUT_MS - MIN) })],
      locBilling: billing('onboarding'),
    })
    expect(justPast).toHaveLength(1)
  })

  it('the window is 90 minutes — not an hour, not three days', () => {
    expect(STRANDED_CHECKOUT_MS).toBe(90 * 60_000)
  })
})

// ── 3. settled stops it, both ways ────────────────────────────────────
describe('a settled payment stops the alert', () => {
  it('a later terminal row for the same session silences it', () => {
    const p = pending()
    const items = run({
      pendingCheckouts: [p],
      locBilling: billing('onboarding'),
      resolvedSessions: new Set([p.entity_id!]),
    })
    expect(items).toHaveLength(0)
  })

  it('the location going active silences it — however it got there', () => {
    // This is the ACH case prod actually has: both real bank payers were
    // active within 14 minutes while their transfer took six days.
    const items = run({ pendingCheckouts: [pending()], locBilling: billing('active') })
    expect(items).toHaveLength(0)
  })

  it('a DIFFERENT session activating the same location silences it', () => {
    // Ashley retried an hour later on a new session id; the first session
    // never settles under its own id, but she is not stranded.
    const items = run({
      pendingCheckouts: [pending()],
      locBilling: billing('active'),
      resolvedSessions: new Set(),
    })
    expect(items).toHaveLength(0)
  })

  it('fetchCheckoutResolutions counts a LATER terminal row, never the seed row', async () => {
    const seeds = [
      { created_at: iso(CREATED), entity_id: 'cs_a', location_id: 'loc_kc' },
      { created_at: iso(CREATED), entity_id: 'cs_b', location_id: 'loc_kc' },
    ]
    const { supabase } = makeSupabase({
      sync_log: [
        // the two seed rows themselves, read back by the same query
        { entity_id: 'cs_a', created_at: iso(CREATED), message: 'topic=STRIPE_PAYMENT item=cs_a — awaiting async payment (payment_status=unpaid)' },
        { entity_id: 'cs_b', created_at: iso(CREATED), message: 'topic=STRIPE_PAYMENT item=cs_b — awaiting async payment (payment_status=unpaid)' },
        // …and one genuine later settlement
        { entity_id: 'cs_b', created_at: iso(CREATED + 30 * MIN), message: 'topic=STRIPE_PAYMENT item=cs_b tier=owner — ACH cleared on already-active location' },
      ],
    })
    const resolved = await fetchCheckoutResolutions(supabase, seeds)
    expect(resolved.has('cs_b')).toBe(true)
    expect(resolved.has('cs_a')).toBe(false)
  })

  it('a terminal row that predates the pending row does not resolve it', async () => {
    // An earlier checkout for the same session id cannot settle a payment
    // that had not been attempted yet.
    const { supabase } = makeSupabase({
      sync_log: [
        { entity_id: 'cs_a', created_at: iso(CREATED - MIN), message: 'topic=STRIPE_PAYMENT item=cs_a tier=owner — activation' },
      ],
    })
    const resolved = await fetchCheckoutResolutions(
      supabase, [{ created_at: iso(CREATED), entity_id: 'cs_a', location_id: 'loc_kc' }],
    )
    expect(resolved.size).toBe(0)
  })

  it('does not depend on the pending row wording alone to skip itself', async () => {
    // If a copy edit ever changes the webhook's phrasing, the clock check
    // must still stop the seed row from resolving its own alert.
    const { supabase } = makeSupabase({
      sync_log: [{ entity_id: 'cs_a', created_at: iso(CREATED), message: 'some future rewording' }],
    })
    const resolved = await fetchCheckoutResolutions(
      supabase, [{ created_at: iso(CREATED), entity_id: 'cs_a', location_id: 'loc_kc' }],
    )
    expect(resolved.size).toBe(0)
  })

  it('resolves nothing — and queries nothing — when there are no candidates', async () => {
    const { supabase, calls } = makeSupabase({ sync_log: [] })
    const resolved = await fetchCheckoutResolutions(supabase, [])
    expect(resolved.size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

// ── 4. a card checkout never triggers it ──────────────────────────────
describe('a card checkout never triggers it', () => {
  const route = readFileSync(
    join(process.cwd(), 'app/api/webhooks/stripe/route.ts'),
    'utf8',
  )

  // SUPERSEDED BY ISSUE 313. This asserted that the awaiting-async sync_log row
  // is written below the unpaid guard. Issue 313 deleted the pending branch
  // outright: an unpaid ACH session now falls through into the full activation,
  // so no pending row is written for ANY session, paid or not. The guard
  // survives as `moneyInFlight`, which decides how the money is RECORDED rather
  // than whether the owner gets in.
  it('still writes the pending row, but no longer RETURNS on it (issue 313)', () => {
    const guard = route.indexOf("const moneyInFlight = paymentStatus !== 'paid'")
    const log = route.indexOf('awaiting async payment')
    expect(guard).toBeGreaterThan(-1)
    // The breadcrumb this alert is seeded by survives, and is still written
    // before any business write — so it exists even if activation then throws.
    expect(log).toBeGreaterThan(guard)
    // What is gone is the early return that left the owner outside.
    expect(route).not.toContain('return NextResponse.json({ ok: true, pending: true })')
  })

  it('the fetch selects only awaiting-async payment rows', async () => {
    const { supabase, calls } = makeSupabase({ sync_log: [] })
    await fetchPendingCheckouts(supabase, SINCE, CUTOFF)
    const c = calls.find(c => c.table === 'sync_log')!
    const ilike = c.ops.find(o => o[0] === 'ilike')?.[1]
    expect(ilike?.[0]).toBe('message')
    expect(String(ilike?.[1]).toLowerCase()).toContain('awaiting async payment')
    expect(c.ops.filter(o => o[0] === 'eq').map(o => o[1])).toContainEqual(['entity_type', 'payment'])
  })

  it('a settled activation row is not a candidate the selector can even see', () => {
    // Belt and braces: even handed one directly, an already-active location
    // is silent — which is every card checkout, one second after it lands.
    const items = run({ pendingCheckouts: [pending()], locBilling: billing('active') })
    expect(items).toHaveLength(0)
  })
})

// ── 5. the fetch shifts its bounds by one strand window ───────────────
describe('the fetch looks one strand-window into the past', () => {
  it('gt/lte are the run window minus STRANDED_CHECKOUT_MS', async () => {
    const { supabase, calls } = makeSupabase({ sync_log: [] })
    await fetchPendingCheckouts(supabase, SINCE, CUTOFF)
    const c = calls.find(c => c.table === 'sync_log')!
    expect(c.ops.find(o => o[0] === 'gt')?.[1]).toEqual([
      'created_at', iso(SINCE - STRANDED_CHECKOUT_MS),
    ])
    expect(c.ops.find(o => o[0] === 'lte')?.[1]).toEqual([
      'created_at', iso(CUTOFF - STRANDED_CHECKOUT_MS),
    ])
  })
})

// ── 6. the alert names a person, not a row ────────────────────────────
describe('the alert says what the owner is experiencing', () => {
  const items = run({ pendingCheckouts: [pending()], locBilling: billing('onboarding') })
  const text = items[0].text

  it('names the location, not just the session id', () => {
    expect(text).toContain('Kansas City')
  })

  it('leads with how long the person has been waiting', () => {
    expect(text).toMatch(/1h 3\dm ago/)
  })

  it('says a person is locked out and watching a spinner', () => {
    expect(text).toContain('cannot get in')
    expect(text).toContain('spinner')
  })

  it('carries enough session id to find it in Stripe', () => {
    expect(text).toContain('cs_live_a1ZGpe2rgeKq0J')
  })

  it('renders through the existing ops message builder with its own icon', () => {
    const msg = buildAlertMessage(items)!
    expect(msg.count).toBe(1)
    expect(msg.text).toContain(':hourglass_flowing_sand:')
    expect(msg.text).toContain('1 failure to check')
  })
})

// ── 7. wiring + blast radius ──────────────────────────────────────────
describe('wiring and blast radius', () => {
  it('collectFailureAlerts surfaces a strand through the normal run', async () => {
    const { supabase } = makeSupabase({
      import_jobs: [],
      // NB: this mock is coarser than PostgREST — it hands the same rows to
      // every sync_log query — so assert on the strand subset.
      sync_log: [{ created_at: iso(CREATED), entity_id: 'cs_x', location_id: 'loc_kc' }],
      locations: [{ location_id: 'loc_kc', name: 'Kansas City', subscription_status: 'onboarding' }],
    })
    const fetchEvents = async () => ({ events: [], truncated: false })
    const out = await collectFailureAlerts({
      nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any,
    })
    const strands = out.items.filter(i => i.kind === 'checkout_stranded')
    expect(strands).toHaveLength(1)
    expect(strands[0].text).toContain('Kansas City')
  })

  it('reads subscription_status so the strand check can tell locked-out from let-in', async () => {
    const { supabase, calls } = makeSupabase({ locations: [], sync_log: [], import_jobs: [] })
    await collectFailureAlerts({
      nowMs: NOW, sinceMs: SINCE, supabase,
      fetchEvents: (async () => ({ events: [], truncated: false })) as any,
    })
    const loc = calls.find(c => c.table === 'locations')!
    expect(String(loc.ops.find(o => o[0] === 'select')?.[1][0])).toContain('subscription_status')
  })

  it('routes through the ops rail only — never the per-location lead bot', () => {
    const lib = readFileSync(join(process.cwd(), 'lib/failure-alerts.ts'), 'utf8')
    const route = readFileSync(join(process.cwd(), 'app/api/cron/failure-alerts/route.ts'), 'utf8')
    expect(lib).not.toContain('slack-bot')
    expect(route).not.toContain('slack-bot')
    expect(route).toContain("from '@/lib/slack'")
  })

  it('adds no cron — it rides the 5-minute failure-alerts run', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'))
    const paths = vercel.crons.map((c: any) => c.path)
    expect(paths).toContain('/api/cron/failure-alerts')
    expect(paths.filter((p: string) => /strand|checkout/i.test(p))).toHaveLength(0)
  })

  // SUPERSEDED BY ISSUE 313, and the reason is the point of that issue.
  //
  // 312 taught the pending row to name its location so the stranded owner
  // could be identified. 313 removes the strand instead: activation now runs
  // on checkout.session.completed regardless of payment_status, so a completed
  // checkout can no longer leave an owner outside. The selector, the window
  // and the fetch below all stay — they are still the backstop for a checkout
  // that completes and somehow does NOT reach active — but the seed row the
  // webhook used to write for every ACH payer is gone, which is why prod
  // should stop producing this alert rather than the alert being deleted.
  it('still records the location on the pending row, and now activates too (issue 313)', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/webhooks/stripe/route.ts'), 'utf8')
    const branch = route.slice(
      route.indexOf('const moneyInFlight = paymentStatus'),
      route.indexOf('4. Layer-1 idempotency'),
    )
    // 312's fix — name the location on the row — is intact.
    expect(branch).toContain('getLocationBilling(clientReferenceId)')
    expect(branch).toContain('locationSlug: pendingLocation?.location_id')
    expect(branch).not.toContain('locationSlug: null')
    // The strand selector is untouched: still allowlisted, still keyed on
    // ACTIVATION rather than settlement, which is exactly why an instantly
    // activated ACH payer self-suppresses and only a real fault alerts.
    expect(typeof STRANDED_CHECKOUT_MS).toBe('number')
  })
})

// ── the chainable supabase stub (same shape as failure-alerts.test.ts) ─
function makeSupabase(byTable: Record<string, any[]>) {
  const calls: Array<{ table: string; ops: [string, any[]][] }> = []
  const supabase: any = {
    from(table: string) {
      const rec = { table, ops: [] as [string, any[]][] }
      calls.push(rec)
      const b: any = {
        then: (resolve: (v: any) => void) => resolve({ data: byTable[table] ?? [], error: null }),
      }
      for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'in', 'ilike', 'not', 'or', 'order', 'limit']) {
        b[m] = (...args: any[]) => { rec.ops.push([m, args]); return b }
      }
      return b
    },
  }
  return { supabase, calls }
}
