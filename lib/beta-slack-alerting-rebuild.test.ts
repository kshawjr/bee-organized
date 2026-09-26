// @vitest-environment node
//
// The Slack alerting rebuild (Sept 2026): instant for what Kevin can fix,
// silent for everything else. These tests drive the two REAL cron routes —
// app/api/cron/failure-alerts (instant, every 5 min) and
// app/api/cron/webhook-digest (daily) — with only the database, the webhook
// log reader and the Slack transport faked, and count the Slack posts.
//
//   1) each instant trigger fires ITS OWN message (a failed lead, an owner's
//      bug, an owner's question, a Jobber reconnect)
//   2) a self-healing token expiry produces NO message — including the three
//      shapes that fooled the old per-record check (two failures sharing one
//      retry, a retry under a different topic, a retry after 9m48s)
//   3) a token expiry that does NOT recover (the RECONNECT REQUIRED stamp)
//      DOES alert, once
//   4) the daily digest is NOT sent when every count is zero — even on a busy,
//      healthy day with leads, landed Jobber events, self-heals and
//      no-matching-lead no-ops
//   5) a Slack channel failure on an owner's workspace produces no message
//
// Stripe payment failures are the fifth instant trigger; they post straight
// from app/api/webhooks/stripe, one message per failure, and are pinned by
// lib/beta-ach-instant-activation-313.test.ts ("a FAILED debit … alerts
// once", "invoice.payment_failed on an ACTIVE location still alerts").

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { WebhookLogEvent } from '@/lib/webhook-observability'

// ── fakes ────────────────────────────────────────────────────────────
const db = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  reads: [] as string[],
}))
vi.mock('@/lib/supabase-service', () => {
  const from = (table: string) => {
    db.reads.push(table)
    const b: any = {
      then: (resolve: (v: any) => void) => resolve({ data: db.tables[table] ?? [], error: null }),
    }
    for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'in', 'ilike', 'not', 'or', 'order', 'limit', 'is', 'insert']) {
      b[m] = () => b
    }
    return b
  }
  return { supabaseService: { from } }
})

const log = vi.hoisted(() => ({ events: [] as any[] }))
vi.mock('@/lib/webhook-observability', () => ({
  fetchWebhookLogEvents: vi.fn(async () => ({ events: log.events, truncated: false })),
}))

vi.mock('@/lib/slack', () => ({ postSlackMessage: vi.fn(async () => ({ ok: true })) }))

const runs = vi.hoisted(() => ({ watermark: null as string | null, recorded: [] as any[] }))
vi.mock('@/lib/alert-runs', () => ({
  fetchLastAlertWatermark: vi.fn(async () => ({ tracked: true, watermark: runs.watermark })),
  recordAlertRun: vi.fn(async (r: any) => { runs.recorded.push(r) }),
}))

// Daily-digest side sources: healthy by default.
vi.mock('@/lib/import-health', () => ({
  fetchImportHealth: vi.fn(async () => ({ failed: [], stalled: [], bounced: [] })),
}))
vi.mock('@/lib/rate-health', () => ({ fetchRateHealth: vi.fn(async () => ({ missingRate: [] })) }))
vi.mock('@/lib/booking-link-health', () => ({ fetchBookingLinkHealth: vi.fn(async () => ({ missingLink: [] })) }))
vi.mock('@/lib/internal-origin', () => ({
  resolveInternalOrigin: () => 'https://beehive.example.com',
  probeInternalOriginGated: vi.fn(async () => false),
}))
vi.mock('@/lib/digest-runs', () => ({ recordDigestRun: vi.fn(async () => {}) }))

import { postSlackMessage } from '@/lib/slack'
import { GET as failureAlerts } from '@/app/api/cron/failure-alerts/route'
import { GET as dailyDigest } from '@/app/api/cron/webhook-digest/route'
import { watermarkAfterPosting, ALERT_SETTLE_MS, type AlertItem } from '@/lib/failure-alerts'

// ── clock + window ───────────────────────────────────────────────────
const NOW = Date.parse('2026-09-26T15:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const SINCE = NOW - 10 * MIN              // last watermark
const IN_WIN = NOW - 8 * MIN              // inside (SINCE, NOW - settle]
const stampOf = (ms: number) => iso(ms).slice(0, 19) // lib/jobber's stamp format

const LOCATIONS = [
  { id: 'uuid-nova', location_id: 'loc_nova', name: 'Nova', subscription_status: 'active', last_sync_status: 'Token refreshed: 2026-09-26T14:00:00' },
  { id: 'uuid-temecula', location_id: 'loc_temecula', name: 'Temecula', subscription_status: 'active', last_sync_status: 'Token refreshed: 2026-09-26T14:00:00' },
  { id: 'uuid-portland', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active', last_sync_status: null },
]

function ev(over: Partial<WebhookLogEvent>): WebhookLogEvent {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: iso(IN_WIN),
    topic: 'QUOTE_UPDATE',
    friendly: 'Quote updated',
    skipped: false,
    processed: true,
    error: null,
    reason: null,
    landed: 'landed',
    client_name: null,
    lead_id: null,
    location_id: 'loc_nova',
    location_name: 'Nova',
    jobber_item: '111',
    intake_slug: null,
    entity_id: null,
    stage_from: null,
    stage_to: null,
    message: '',
    ...over,
  }
}
const tokenFail = (over: Partial<WebhookLogEvent>) =>
  ev({ processed: false, landed: null, error: 'quote_fetch: no_valid_jobber_token', reason: 'quote_fetch: no_valid_jobber_token', ...over })
const leadFail = (reason: string) =>
  ev({ topic: 'LEAD_INTAKE', friendly: 'Lead intake', processed: false, landed: null, error: reason, reason, location_id: null, location_name: 'Unknown account', jobber_item: null })

const req = (path: string) => new NextRequest(`https://beehive.example.com${path}?secret=s3cret`)
const posts = () => (postSlackMessage as any).mock.calls.map((c: any[]) => String(c[0])) as string[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 's3cret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://beehive.example.com'
  db.tables = { locations: LOCATIONS.map(l => ({ ...l })) }
  db.reads = []
  log.events = []
  runs.watermark = iso(SINCE)
  runs.recorded = []
  ;(postSlackMessage as any).mockClear()
  ;(postSlackMessage as any).mockImplementation(async () => ({ ok: true }))
})
afterEach(() => { vi.useRealTimers() })

// ═══ 1. each instant trigger fires its own message ═══════════════════

describe('instant — each trigger is its own message', () => {
  it('three failed website leads → three messages, each saying what went wrong', async () => {
    log.events = [
      leadFail('full_name required email_present=true'),
      leadFail('location_slug required email_present=false'),
      leadFail('location_not_found slug=acme-typo'),
    ]
    const res = await failureAlerts(req('/api/cron/failure-alerts'))
    expect(res.status).toBe(200)
    const p = posts()
    expect(p).toHaveLength(3)
    expect(p[0]).toContain("didn't arrive")
    expect(p.find(t => t.includes('full_name required'))).toContain('sent no name')
    expect(p.find(t => t.includes('location_slug required'))).toContain('sent no location')
    expect(p.find(t => t.includes('location_not_found'))).toContain('matches no Bee Hub location')
  })

  it("an owner's bug and an owner's question → two messages, named by location", async () => {
    db.tables.feedback_items = [
      { type: 'bug', title: 'Calendar will not load', location_id: 'uuid-portland', created_at: iso(IN_WIN), is_internal: false },
      { type: 'question', title: 'How do I add a second address?', location_id: 'uuid-nova', created_at: iso(IN_WIN + MIN), is_internal: false },
    ]
    await failureAlerts(req('/api/cron/failure-alerts'))
    const p = posts()
    expect(p).toHaveLength(2)
    expect(p[0]).toContain('Portland reported a bug')
    expect(p[0]).toContain('Calendar will not load')
    expect(p[1]).toContain('Nova asked a question')
    expect(p[1]).toContain('https://beehive.example.com/?feedback=1')
  })

  it('a feature request or an internal item does not page', async () => {
    db.tables.feedback_items = [
      { type: 'feature', title: 'Dark mode', location_id: 'uuid-nova', created_at: iso(IN_WIN), is_internal: false },
      { type: 'bug', title: 'Kevin note', location_id: 'uuid-nova', created_at: iso(IN_WIN), is_internal: true },
    ]
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(0)
  })

  it('a lead failure and a bug in the same run are two messages, not one list', async () => {
    log.events = [leadFail('full_name required email_present=true')]
    db.tables.feedback_items = [
      { type: 'bug', title: 'Broken', location_id: 'uuid-nova', created_at: iso(IN_WIN), is_internal: false },
    ]
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(2)
    expect(posts().every(t => !t.includes('failures to check'))).toBe(true)
  })
})

// ═══ 2. a self-healing token expiry is silent ════════════════════════

describe('instant — a self-healing token expiry produces NO message', () => {
  it('fail → success on the same record a second later', async () => {
    log.events = [
      tokenFail({ created_at: iso(IN_WIN) }),
      ev({ created_at: iso(IN_WIN + 700) }),
    ]
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(0)
  })

  it('the three shapes that paged Kevin 7 times in one week stay silent', async () => {
    log.events = [
      // Greensboro/Omaha: two failures, ONE retry
      tokenFail({ jobber_item: '222', created_at: iso(IN_WIN) }),
      tokenFail({ jobber_item: '222', created_at: iso(IN_WIN + 4) }),
      ev({ jobber_item: '222', created_at: iso(IN_WIN + 460) }),
      // Nova/West Raleigh: QUOTE_APPROVED fails, QUOTE_UPDATE lands
      tokenFail({ topic: 'QUOTE_APPROVED', jobber_item: '333', created_at: iso(IN_WIN) }),
      ev({ topic: 'QUOTE_UPDATE', jobber_item: '333', created_at: iso(IN_WIN + 600) }),
      // Temecula: retry 9m48s later
      tokenFail({ location_id: 'loc_temecula', location_name: 'Temecula', jobber_item: '444', created_at: iso(NOW - 20 * MIN) }),
      ev({ location_id: 'loc_temecula', location_name: 'Temecula', jobber_item: '444', created_at: iso(NOW - 20 * MIN + 588_000) }),
    ]
    runs.watermark = iso(NOW - 30 * MIN)
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(0)
  })

  it('even a token failure with no retry at all is not an instant message on its own', async () => {
    // Carmel: the record never came back, but the location was fine a second
    // later. That lost record is the daily "never landed" line, not a page.
    log.events = [tokenFail({ location_id: 'loc_carmel', location_name: 'Carmel', jobber_item: '555' })]
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(0)
  })
})

// ═══ 3. a token expiry that does not recover DOES alert ══════════════

describe('instant — a token that does not recover alerts once', () => {
  it('a location stamped RECONNECT REQUIRED in the window → one message', async () => {
    db.tables.locations[1].last_sync_status =
      `RECONNECT REQUIRED — Jobber rejected refresh token (401) @ ${stampOf(IN_WIN)}`
    log.events = [tokenFail({ location_id: 'loc_temecula', location_name: 'Temecula', error: 'jobber_reauth_required', reason: 'jobber_reauth_required' })]
    await failureAlerts(req('/api/cron/failure-alerts'))
    const p = posts()
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('Jobber disconnected — Temecula')
    expect(p[0]).toContain('will not recover by itself')
  })

  it('the same stamp is silent in the next run — it alerts once, not every 5 minutes', async () => {
    db.tables.locations[1].last_sync_status =
      `RECONNECT REQUIRED — Jobber rejected refresh token (401) @ ${stampOf(NOW - 40 * MIN)}`
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(0)
  })
})

// ═══ 5. a Slack channel failure produces no message to Kevin ═════════

describe("instant — a Slack failure on an owner's channel is not Kevin's", () => {
  it('channel_not_found / not_in_channel rows produce no message and are never read', async () => {
    db.tables.notification_log = [
      { channel: 'slack', send_status: 'failed', location_slug: 'loc_portland', lead_name: 'Jane', error: 'channel_not_found', created_at: iso(IN_WIN) },
      { channel: 'slack', send_status: 'failed', location_slug: 'loc_nova', lead_name: 'Sam', error: 'not_in_channel', created_at: iso(IN_WIN) },
    ]
    await failureAlerts(req('/api/cron/failure-alerts'))
    expect(posts()).toHaveLength(0)
    expect(db.reads).not.toContain('notification_log')
  })
})

// ═══ the watermark never repeats a message or loses one ══════════════

describe('instant — a Slack error part-way through', () => {
  it('advances past what was posted and holds what was not', async () => {
    log.events = [
      leadFail('full_name required email_present=true'),
      { ...leadFail('location_slug required email_present=false'), created_at: iso(IN_WIN + MIN) },
    ]
    ;(postSlackMessage as any)
      .mockImplementationOnce(async () => ({ ok: true }))
      .mockImplementationOnce(async () => ({ ok: false, error: 'slack_http_500' }))
    const res = await failureAlerts(req('/api/cron/failure-alerts'))
    expect(res.status).toBe(502)
    expect(runs.recorded.at(-1).watermark).toBe(iso(IN_WIN))
  })

  it('watermarkAfterPosting: equal timestamps are never split', () => {
    const a: AlertItem = { kind: 'lead_failed', ts: 100, text: 'a' }
    const b: AlertItem = { kind: 'lead_failed', ts: 100, text: 'b' }
    expect(watermarkAfterPosting({ sinceMs: 50, cutoffMs: 200, posted: [a], unposted: [b] })).toBe(50)
    expect(watermarkAfterPosting({ sinceMs: 50, cutoffMs: 200, posted: [a, b], unposted: [] })).toBe(200)
    expect(ALERT_SETTLE_MS).toBe(5 * MIN)
  })
})

// ═══ 4. the daily digest is silent when every count is zero ══════════

describe('daily — nothing wrong means nothing sent', () => {
  it('a busy, healthy day posts NOTHING', async () => {
    const day = NOW - 6 * 60 * MIN
    log.events = [
      // leads in
      ev({ topic: 'LEAD_INTAKE', friendly: 'Lead intake', location_id: 'loc_nova', jobber_item: null, created_at: iso(day) }),
      ev({ topic: 'LEAD_INTAKE', friendly: 'Lead intake', location_id: 'loc_other', jobber_item: null, created_at: iso(day) }),
      // Jobber syncing
      ev({ topic: 'JOB_UPDATE', friendly: 'Job updated', jobber_item: '900', created_at: iso(day) }),
      // a token self-heal under a different topic
      tokenFail({ topic: 'QUOTE_APPROVED', jobber_item: '901', created_at: iso(day) }),
      ev({ topic: 'QUOTE_UPDATE', jobber_item: '901', created_at: iso(day + 600) }),
      // a no-matching-lead no-op (processed, landed 'na' → null)
      ev({ topic: 'REQUEST_DESTROY', friendly: 'Request deleted', landed: null, jobber_item: '902', location_id: 'loc_portland', created_at: iso(day) }),
    ]
    const res = await dailyDigest(req('/api/cron/webhook-digest'))
    const body = await res.json()
    expect(body.suppressed).toBe(true)
    expect(postSlackMessage).not.toHaveBeenCalled()
  })

  it('a record that never landed IS sent — and the message carries no "healthy" rundown', async () => {
    log.events = [
      ev({ topic: 'LEAD_INTAKE', friendly: 'Lead intake', location_id: 'loc_nova', jobber_item: null, created_at: iso(NOW - 3 * 60 * MIN) }),
      tokenFail({ topic: 'REQUEST_UPDATE', friendly: 'Request updated', client_name: 'Karie Johnson', location_name: 'Carmel', jobber_item: '777', created_at: iso(NOW - 3 * 60 * MIN) }),
    ]
    await dailyDigest(req('/api/cron/webhook-digest'))
    const p = posts()
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('Never landed')
    expect(p[0]).toContain('Carmel: Karie Johnson — Request updated')
    expect(p[0]).not.toMatch(/healthy|landed —|self-heal|token expired|reconnect Jobber/i)
  })

  it('a location still stamped RECONNECT REQUIRED is a daily "still disconnected" line', async () => {
    db.tables.locations[1].last_sync_status =
      `RECONNECT REQUIRED — Jobber rejected refresh token (400) @ ${stampOf(NOW - 3 * 24 * 60 * MIN)}`
    await dailyDigest(req('/api/cron/webhook-digest'))
    const p = posts()
    expect(p).toHaveLength(1)
    expect(p[0]).toContain('Jobber still disconnected')
    expect(p[0]).toContain('Temecula')
  })

  it('a failure younger than the retry grace waits for tomorrow instead of crying wolf', async () => {
    log.events = [tokenFail({ jobber_item: '778', created_at: iso(NOW - 10 * MIN) })]
    await dailyDigest(req('/api/cron/webhook-digest'))
    expect(postSlackMessage).not.toHaveBeenCalled()
  })
})
