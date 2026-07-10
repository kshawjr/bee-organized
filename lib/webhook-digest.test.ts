// @vitest-environment node
//
// Twice-daily Slack webhook-failure digest — formatter unit tests +
// source pins for the cron route.
//
//   1) buildWebhookDigest is pure: failures (red) + didn't-land (amber)
//      grouped by location with client names, event types, and error
//      messages; a deep link into the admin Webhooks tab pre-filtered
//      to the non-empty bucket; per-location + per-digest caps so a
//      webhook storm doesn't produce a 500-line Slack post.
//
//   2) All-clear policy: a quiet window POSTS a short all-clear line
//      (with the processed count) rather than skipping — a silent
//      digest must be distinguishable from a dead one.
//
//   3) Cron route pins: CRON_SECRET fail-closed, Bearer + ?secret=
//      accepted (send-drips convention), 12h window, missing
//      SLACK_WEBHOOK_URL is a 200 logged no-op (not a paged failure),
//      and vercel.json registers the 0 0,12 UTC schedule.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWebhookDigest } from '@/lib/webhook-digest'
import type { WebhookLogEvent } from '@/lib/webhook-observability'

function ev(over: Partial<WebhookLogEvent>): WebhookLogEvent {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: '2026-07-09T12:00:00Z',
    topic: 'JOB_UPDATE',
    friendly: 'Job updated',
    skipped: false,
    processed: true,
    error: null,
    landed: null,
    client_name: null,
    lead_id: null,
    location_id: 'loc_portland',
    location_name: 'Portland',
    jobber_item: '123',
    stage_from: null,
    stage_to: null,
    message: 'topic=JOB_UPDATE item=123',
    ...over,
  }
}

const APP = 'https://beehub.example.com'

describe('buildWebhookDigest — all clear', () => {
  it('posts a short all-clear with the processed count on a quiet window', () => {
    const d = buildWebhookDigest({ events: [ev({}), ev({}), ev({})], appUrl: APP })
    expect(d.allClear).toBe(true)
    expect(d.failures).toBe(0)
    expect(d.stuck).toBe(0)
    expect(d.text).toContain('all clear')
    expect(d.text).toContain('3 events processed')
    expect(d.text).toContain("0 didn't land")
  })
})

describe('buildWebhookDigest — problems', () => {
  const failure = ev({
    processed: false,
    error: 'quote_fetch: no_valid_jobber_token',
    topic: 'QUOTE_UPDATE',
    friendly: 'Quote updated',
    client_name: 'Joe Green',
    location_id: 'loc_nwarkansas',
    location_name: 'Northwest Arkansas',
  })
  const stuckRow = ev({
    landed: 'stuck',
    topic: 'JOB_CREATE',
    friendly: 'Job created',
    client_name: 'Cindy Rodden',
    location_id: 'loc_portland',
    location_name: 'Portland',
  })

  it('groups by location with names, event types, and error messages', () => {
    const d = buildWebhookDigest({ events: [ev({}), failure, stuckRow], appUrl: APP })
    expect(d.allClear).toBe(false)
    expect(d.failures).toBe(1)
    expect(d.stuck).toBe(1)
    expect(d.text).toContain("*Webhook digest — 1 failure, 1 didn't land*")
    expect(d.text).toContain('*Northwest Arkansas*')
    expect(d.text).toContain('Joe Green — Quote updated (QUOTE_UPDATE): quote_fetch: no_valid_jobber_token')
    expect(d.text).toContain('*Portland*')
    expect(d.text).toContain("Cindy Rodden — Job created (JOB_CREATE): processed but didn't land")
  })

  it('deep-links to the dashboard filtered to failures when both buckets exist', () => {
    const d = buildWebhookDigest({ events: [failure, stuckRow], appUrl: APP })
    expect(d.text).toContain(`<${APP}/admin?adminTab=webhooks&whFilter=failures&whWindow=24h|`)
  })

  it("deep-links to the didn't-land filter when there are no failures", () => {
    const d = buildWebhookDigest({ events: [stuckRow], appUrl: APP })
    expect(d.text).toContain('whFilter=stuck')
  })

  it('falls back to the Jobber item id when no client name resolved', () => {
    const d = buildWebhookDigest({
      events: [ev({ processed: false, error: 'boom', client_name: null, jobber_item: '987654' })],
      appUrl: APP,
    })
    expect(d.text).toContain('Jobber #987654')
  })

  it('caps lines per location so a storm stays readable', () => {
    const storm = Array.from({ length: 20 }, (_, i) =>
      ev({ processed: false, error: `err ${i}`, client_name: `Client ${i}` }),
    )
    const d = buildWebhookDigest({ events: storm, appUrl: APP })
    expect(d.text).toContain('…plus 12 more')
    expect(d.failures).toBe(20)
  })
})

describe('cron route + registration pins', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/cron/webhook-digest/route.ts'), 'utf8')
  const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
  const slack  = readFileSync(join(process.cwd(), 'lib/slack.ts'), 'utf8')

  it('is CRON_SECRET fail-closed with Bearer + ?secret= accepted', () => {
    expect(route).toContain("{ error: 'cron_secret_not_configured' }, { status: 500 }")
    expect(route).toContain('`Bearer ${secret}`')
    expect(route).toContain("searchParams.get('secret')")
    expect(route).toContain("{ error: 'unauthorized' }, { status: 401 }")
  })

  it('queries the 12h window', () => {
    expect(route).toContain("fetchWebhookLogEvents({ window: '12h' })")
  })

  it('treats missing SLACK_WEBHOOK_URL as a logged 200 no-op, but Slack errors as 502', () => {
    expect(slack).toContain("skipped: 'no_webhook_url'")
    expect(route).toMatch(/if \(!post\.ok && post\.error\)/)
    expect(route).toContain('status: 502')
  })

  it('vercel.json registers the twice-daily schedule', () => {
    expect(vercel).toContain('"path": "/api/cron/webhook-digest", "schedule": "0 0,12 * * *"')
  })
})
