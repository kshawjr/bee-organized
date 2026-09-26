// @vitest-environment node
//
// Daily ops digest (runs once daily — issue 159, rebuilt Sept 2026) —
// formatter unit tests + source pins for the cron route.
//
// THE RULE: the digest carries only what is wrong-but-not-urgent, and posts
// NOTHING when every count is zero. What these tests pin:
//
//   1) A busy healthy day (leads in, Jobber landed, self-heals, no-op
//      deletes) → suppressed. No "Leads healthy" headline exists any more.
//   2) NEVER LANDED: a Jobber change with no later success for the same
//      record (whatever topic the retry came under) is a line; one that
//      recovered is not; a failure inside the retry grace waits.
//   3) Failed leads are NOT a daily line (they alert instantly).
//   4) STUCK: imports stalled / bouncing / origin gated, rate + booking-link
//      holds, locations still disconnected from Jobber. A FAILED import is not
//      a daily line (instant rail).
//   5) Cron route pins: 24h window, suppression no-post, CRON_SECRET
//      fail-closed, missing SLACK_WEBHOOK_URL 200 no-op, "0 10 * * *".

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWebhookDigest, findNeverLanded, RETRY_GRACE_MS } from '@/lib/webhook-digest'
import type { WebhookLogEvent } from '@/lib/webhook-observability'

const NOW = Date.parse('2026-07-18T12:00:00Z')
const HOUR = 60 * 60 * 1000
const at = (ms: number) => new Date(ms).toISOString()

function ev(over: Partial<WebhookLogEvent>): WebhookLogEvent {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: at(NOW - 6 * HOUR),
    topic: 'JOB_UPDATE',
    friendly: 'Job updated',
    skipped: false,
    processed: true,
    error: null,
    reason: null,
    landed: 'landed',
    client_name: null,
    lead_id: null,
    location_id: 'loc_portland',
    location_name: 'Portland',
    jobber_item: '123',
    intake_slug: null,
    entity_id: null,
    stage_from: null,
    stage_to: null,
    message: 'topic=JOB_UPDATE item=123',
    ...over,
  }
}

const leadIn = (slug: string) =>
  ev({ topic: 'LEAD_INTAKE', friendly: 'Lead intake', location_id: slug, location_name: slug, jobber_item: null })

const leadFail = (reason: string) =>
  ev({ topic: 'LEAD_INTAKE', friendly: 'Lead intake', processed: false, landed: null, error: reason, reason, location_id: null, jobber_item: null })

const fail = (over: Partial<WebhookLogEvent> = {}) =>
  ev({ processed: false, landed: null, error: 'job_fetch: no_valid_jobber_token', reason: 'job_fetch: no_valid_jobber_token', ...over })

const APP = 'https://beehub.example.com'
const digest = (events: WebhookLogEvent[], extra: any = {}) =>
  buildWebhookDigest({ events, appUrl: APP, nowMs: NOW, ...extra })

describe('silence — nothing wrong means nothing sent', () => {
  it('a busy healthy day is suppressed with empty text', () => {
    const d = digest([
      leadIn('loc_kc'), leadIn('loc_other'), leadIn('loc_other'),
      ev({ jobber_item: '1' }), ev({ topic: 'QUOTE_UPDATE', jobber_item: '2' }),
      // token self-heal under a DIFFERENT topic (the Nova shape)
      fail({ topic: 'QUOTE_APPROVED', jobber_item: '3', created_at: at(NOW - 5 * HOUR) }),
      ev({ topic: 'QUOTE_UPDATE', jobber_item: '3', created_at: at(NOW - 5 * HOUR + 600) }),
      // a no-matching-lead no-op
      ev({ topic: 'REQUEST_DESTROY', landed: null, jobber_item: '4' }),
    ])
    expect(d.suppressed).toBe(true)
    expect(d.allClear).toBe(true)
    expect(d.text).toBe('')
    expect(d.selfHeals).toBe(1)             // recorded on the heartbeat, never posted
    expect(d.leadsLanded).toBe(3)
  })

  it('no events at all is suppressed', () => {
    expect(digest([]).suppressed).toBe(true)
  })

  it('a failed LEAD is not a daily line — it alerted instantly', () => {
    const d = digest([leadFail('full_name required email_present=true')])
    expect(d.suppressed).toBe(true)
    expect(d.leadsFailed).toBe(1)
  })
})

describe('never landed', () => {
  it('a failure with no later success is reported, grouped under its location', () => {
    const d = digest([fail({ client_name: 'Karie Johnson', location_name: 'Carmel', topic: 'REQUEST_UPDATE', friendly: 'Request updated', jobber_item: '77' })])
    expect(d.suppressed).toBe(false)
    expect(d.neverLanded).toBe(1)
    expect(d.headline).toBe(':clipboard: Daily check — 1 Jobber change never landed')
    expect(d.text).toContain('Carmel: Karie Johnson — Request updated: the Jobber connection blipped and no retry came')
    expect(d.text).toContain('/admin?adminTab=webhooks&whFilter=failures&whWindow=24h')
    expect(d.text).not.toMatch(/healthy|self-heal|token expired|reconnect/i)
  })

  it('a processed-but-stuck row with no later landing is reported', () => {
    const d = digest([ev({ topic: 'PROPERTY_UPDATE', friendly: 'Property updated', landed: 'stuck', jobber_item: '88' })])
    expect(d.neverLanded).toBe(1)
    expect(d.text).toContain("processed but didn't reach its state")
  })

  it('two failures sharing ONE retry both count as recovered (the Greensboro shape)', () => {
    const r = findNeverLanded([
      fail({ jobber_item: '9', created_at: at(NOW - 3 * HOUR) }),
      fail({ jobber_item: '9', created_at: at(NOW - 3 * HOUR + 4) }),
      ev({ jobber_item: '9', created_at: at(NOW - 3 * HOUR + 460) }),
    ], NOW)
    expect(r.neverLanded).toEqual([])
    expect(r.recoveredCount).toBe(2)
  })

  it('a retry 9m48s later still counts as recovered (the Temecula shape)', () => {
    const r = findNeverLanded([
      fail({ jobber_item: '10', created_at: at(NOW - 3 * HOUR) }),
      ev({ jobber_item: '10', created_at: at(NOW - 3 * HOUR + 588_000) }),
    ], NOW)
    expect(r.neverLanded).toEqual([])
  })

  it('a success BEFORE the failure does not heal it', () => {
    const r = findNeverLanded([
      ev({ jobber_item: '11', created_at: at(NOW - 4 * HOUR) }),
      fail({ jobber_item: '11', created_at: at(NOW - 3 * HOUR) }),
    ], NOW)
    expect(r.neverLanded).toHaveLength(1)
  })

  it('repeated failures of one record are one line', () => {
    const r = findNeverLanded([
      fail({ jobber_item: '12', created_at: at(NOW - 4 * HOUR) }),
      fail({ jobber_item: '12', created_at: at(NOW - 3 * HOUR) }),
    ], NOW)
    expect(r.neverLanded).toHaveLength(1)
  })

  it('a failure younger than the retry grace is left for tomorrow', () => {
    const r = findNeverLanded([fail({ jobber_item: '13', created_at: at(NOW - RETRY_GRACE_MS + 60_000) })], NOW)
    expect(r.neverLanded).toEqual([])
  })

  it('a non-token error keeps its own reason', () => {
    const d = digest([fail({ error: 'invoice_not_found_in_jobber', reason: 'invoice_not_found_in_jobber', jobber_item: '14' })])
    expect(d.text).toContain('invoice_not_found_in_jobber')
  })
})

describe('still disconnected from Jobber', () => {
  it('a stamped location is a daily line and un-suppresses', () => {
    const d = digest([], { reconnect: { locations: [{ location_id: 'loc_kc', name: 'Kansas City' }] } })
    expect(d.suppressed).toBe(false)
    expect(d.reconnectRequired).toBe(1)
    expect(d.text).toContain('Jobber still disconnected')
    expect(d.text).toContain('Kansas City — reconnect Jobber in Settings')
  })

  it('none stamped → nothing', () => {
    expect(digest([], { reconnect: { locations: [] } }).suppressed).toBe(true)
  })
})

describe('buildWebhookDigest — import health (item 2/3)', () => {
  const failedJob = (over: any = {}) => ({
    location_id: 'loc_scottsdale', phase: 'writing', error_message: 'Token: jobber_reauth_required',
    processed_records: 607, total_records: 709, ...over,
  })
  const stalledJob = (over: any = {}) => ({
    location_id: 'loc_temecula', phase: 'writing', processed_records: 300, total_records: 709,
    location_claim_at: new Date(NOW - 18 * 60 * 1000).toISOString(), started_at: new Date(NOW - 40 * 60 * 1000).toISOString(),
    ...over,
  })

  it('a FAILED import is NOT a daily line — it alerted instantly; counted for the heartbeat only', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: { failed: [failedJob()], stalled: [], originGated: false, nowMs: NOW },
    })
    expect(d.suppressed).toBe(true)
    expect(d.importFailed).toBe(1)
    expect(d.text).toBe('')
  })

  it('a STALLED import is reported with how long it has been stuck', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: { failed: [], stalled: [stalledJob()], originGated: false, nowMs: NOW },
    })
    expect(d.suppressed).toBe(false)
    expect(d.importStalled).toBe(1)
    expect(d.headline).toContain('1 import stalled')
    expect(d.text).toContain('loc_temecula — writing (300/709) — stuck 18m')
  })

  it('an SSO-GATED re-poke origin escalates as a :rotating_light: alert', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: { failed: [], stalled: [], originGated: true, originTarget: 'https://dep123.vercel.app', nowMs: NOW },
    })
    expect(d.suppressed).toBe(false)
    expect(d.importOriginGated).toBe(true)
    expect(d.headline).toContain('imports cannot self-resume')
    expect(d.text).toContain(':rotating_light:')
    expect(d.text).toContain('NEXT_PUBLIC_APP_URL')
    expect(d.text).toContain('https://dep123.vercel.app')
  })

  it('HEALTHY imports are silent — no section, and a quiet window still suppresses', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: { failed: [], stalled: [], originGated: false, nowMs: NOW },
    })
    expect(d.suppressed).toBe(true)           // healthy imports add NO noise
    expect(d.importFailed).toBe(0)
    expect(d.importStalled).toBe(0)
    expect(d.text).not.toContain(':package: Imports')
  })

  it('healthy imports beside a landed lead still post nothing', () => {
    const d = buildWebhookDigest({
      events: [leadIn('boulder-01')], appUrl: APP, nowMs: NOW,
      importHealth: { failed: [], stalled: [], originGated: false, nowMs: NOW },
    })
    expect(d.suppressed).toBe(true)
    expect(d.text).toBe('')
  })

  // ── continuation bounces: a broken handoff must be VISIBLE ──────
  // These used to be console.warn-only, so a silently failing handoff looked
  // identical to a healthy window until an import had already stalled out.
  it('a continuation re-poke that did not land raises the Imports section', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: {
        failed: [], stalled: [], originGated: false, nowMs: NOW,
        bounced: [{
          location_id: 'loc_kc', count: 3, outcomes: 'bounced×2, no_claim×1',
          sample: '[continuation] source=sweeper outcome=bounced job=job-1 status=0 — blocked by a redirect',
        }],
      },
    })
    expect(d.suppressed).toBe(false)
    expect(d.text).toContain('*:package: Imports*')
    expect(d.text).toContain('continuation re-poke(s) did NOT land')
    expect(d.text).toContain('loc_kc')
    expect(d.text).toContain('bounced×2')
    expect(d.text).toContain('blocked by a redirect')
  })

  it('bounce counts sum across locations', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: {
        failed: [], stalled: [], originGated: false, nowMs: NOW,
        bounced: [
          { location_id: 'loc_kc', count: 3, outcomes: 'bounced×3' },
          { location_id: 'loc_pdx', count: 1, outcomes: 'errored×1' },
        ],
      },
    })
    expect(d.text).toContain('4 continuation re-poke(s) did NOT land')
  })

  it('an omitted bounced list degrades to no section (pre-fix callers stay quiet)', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: { failed: [], stalled: [], originGated: false, nowMs: NOW },
    })
    expect(d.text).not.toContain('did NOT land')
    expect(d.suppressed).toBe(true)
  })

  it('originGated null (probe failed) is NOT treated as a problem', () => {
    const d = buildWebhookDigest({
      events: [], appUrl: APP,
      importHealth: { failed: [], stalled: [], originGated: null, nowMs: NOW },
    })
    expect(d.importOriginGated).toBe(false)
    expect(d.suppressed).toBe(true)
  })
})

describe('cron route + registration pins', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/cron/webhook-digest/route.ts'), 'utf8')
  const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
  const slack  = readFileSync(join(process.cwd(), 'lib/slack.ts'), 'utf8')

  it('wires import health + the origin-gated probe into the digest', () => {
    expect(route).toContain('fetchImportHealth(')
    expect(route).toContain('probeInternalOriginGated(')
    expect(route).toContain('importHealth:')
  })

  it('is CRON_SECRET fail-closed with Bearer + ?secret= accepted', () => {
    expect(route).toContain("{ error: 'cron_secret_not_configured' }, { status: 500 }")
    expect(route).toContain('`Bearer ${secret}`')
    expect(route).toContain("searchParams.get('secret')")
    expect(route).toContain("{ error: 'unauthorized' }, { status: 401 }")
  })

  it('queries the 24h window (daily cadence — issue 159)', () => {
    expect(route).toContain("fetchWebhookLogEvents({ window: '24h' })")
    expect(route).toContain("windowLabel: 'last 24h'")
  })

  it('wires the still-disconnected locations into the digest', () => {
    expect(route).toContain('parseReconnectStamp(')
    expect(route).toContain('reconnect: { locations: reconnectLocations }')
  })

  it('suppresses a quiet window by posting nothing', () => {
    expect(route).toContain('if (digest.suppressed)')
    expect(route).toContain('posted: false, suppressed: true')
  })

  it('treats missing SLACK_WEBHOOK_URL as a logged 200 no-op, but Slack errors as 502', () => {
    expect(slack).toContain("skipped: 'no_webhook_url'")
    expect(route).toMatch(/if \(!post\.ok && post\.error\)/)
    expect(route).toContain('status: 502')
  })

  it('vercel.json registers the once-daily schedule (issue 159)', () => {
    expect(vercel).toContain('"path": "/api/cron/webhook-digest", "schedule": "0 10 * * *"')
  })
})
