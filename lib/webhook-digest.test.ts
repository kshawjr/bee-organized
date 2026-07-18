// @vitest-environment node
//
// Slack webhook digest (runs every 3h) — formatter unit tests + source
// pins for the cron route.
//
// The redesigned digest LEADS with lead-intake health and re-presents
// Jobber sync underneath. What these tests pin:
//
//   1) Clean window → ✅ "Leads healthy" headline, right counts, fires
//      (not suppressed).
//   2) A real didn't-land (lead OR Jobber) → ⚠️ headline naming it.
//   3) Token-race self-heals (reauth fail → success on the same entity
//      within the window) are NOT failures: they never reach the ⚠️
//      headline; a self-heal-ONLY window is suppressed; when a digest
//      fires for other reasons the self-heals show as a calm line.
//   4) A genuine reauth expiry (no following success) IS a real
//      didn't-land and is flagged loud.
//   5) Quiet window → suppressed entirely (post nothing).
//   6) loc_other spike detection.
//   7) Cron route pins: 3h window, suppression no-post, CRON_SECRET
//      fail-closed, missing SLACK_WEBHOOK_URL 200 no-op, and vercel.json
//      registers the "0 */3 * * *" schedule.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWebhookDigest, SELF_HEAL_WINDOW_MS } from '@/lib/webhook-digest'
import type { WebhookLogEvent } from '@/lib/webhook-observability'

function ev(over: Partial<WebhookLogEvent>): WebhookLogEvent {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: '2026-07-18T12:00:00Z',
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

// A landed website lead (topic=LEAD_INTAKE, success).
const leadIn = (slug: string, over: Partial<WebhookLogEvent> = {}) =>
  ev({
    topic: 'LEAD_INTAKE',
    friendly: 'Lead intake',
    processed: true,
    landed: 'landed',
    location_id: slug,
    location_name: slug,
    jobber_item: null,
    ...over,
  })

// A failed website lead.
const leadFail = (slug: string | null, reason: string, over: Partial<WebhookLogEvent> = {}) =>
  ev({
    topic: 'LEAD_INTAKE',
    friendly: 'Lead intake',
    processed: false,
    landed: null,
    error: reason,
    reason,
    location_id: slug,
    location_name: slug,
    intake_slug: slug === null ? 'acme-typo' : null,
    jobber_item: null,
    ...over,
  })

const APP = 'https://beehub.example.com'

describe('buildWebhookDigest — clean window', () => {
  it('leads with a ✅ "Leads healthy" headline and fires', () => {
    const d = buildWebhookDigest({
      events: [leadIn('boulder-01'), leadIn('boulder-01'), leadIn('denver-02'), ev({}), ev({})],
      appUrl: APP,
    })
    expect(d.suppressed).toBe(false)
    expect(d.allClear).toBe(true)
    expect(d.leadsLanded).toBe(3)
    expect(d.leadsFailed).toBe(0)
    expect(d.jobberLanded).toBe(2)
    expect(d.jobberDidntLand).toBe(0)
    expect(d.headline).toContain(':white_check_mark: Leads healthy — 3 in, 0 didn')
    expect(d.headline).toContain('Jobber: 2 landed')
    expect(d.text).toContain('*:inbox_tray: Lead intake*')
    expect(d.text).toContain('boulder-01 ×2')
    expect(d.text).toContain('*:wrench: Jobber sync*')
    expect(d.text).toContain('2 landed, 0 didn')
  })
})

describe('buildWebhookDigest — real didn\'t-land drives ⚠️', () => {
  it('a failed lead flips the headline to ⚠️ and lists the failure', () => {
    const d = buildWebhookDigest({
      events: [leadIn('boulder-01'), leadFail(null, 'location_not_found slug=acme-typo')],
      appUrl: APP,
    })
    expect(d.suppressed).toBe(false)
    expect(d.allClear).toBe(false)
    expect(d.leadsFailed).toBe(1)
    expect(d.headline).toContain(":warning:")
    expect(d.headline).toContain("1 lead DIDN'T LAND")
    expect(d.text).toContain('• :warning: 1 didn')
    expect(d.text).toContain('acme-typo — location_not_found')
  })

  it('a Jobber failure drives ⚠️ and names the Jobber count', () => {
    const d = buildWebhookDigest({
      events: [
        leadIn('boulder-01'),
        ev({ processed: false, landed: null, error: 'quote_fetch: boom', reason: 'quote_fetch: boom',
             topic: 'QUOTE_UPDATE', friendly: 'Quote updated', client_name: 'Joe Green',
             location_name: 'Northwest Arkansas', jobber_item: '55' }),
      ],
      appUrl: APP,
    })
    expect(d.allClear).toBe(false)
    expect(d.jobberDidntLand).toBe(1)
    expect(d.headline).toContain("1 Jobber event DIDN'T LAND")
    expect(d.text).toContain('Northwest Arkansas: Joe Green — Quote updated (QUOTE_UPDATE): quote_fetch: boom')
  })

  it('counts a processed-but-stuck row as a Jobber didn\'t-land', () => {
    const d = buildWebhookDigest({
      events: [ev({ landed: 'stuck', topic: 'JOB_CREATE', friendly: 'Job created', client_name: 'Cindy' })],
      appUrl: APP,
    })
    expect(d.jobberDidntLand).toBe(1)
    expect(d.text).toContain("Cindy — Job created (JOB_CREATE): processed but didn't land")
  })
})

describe('buildWebhookDigest — token self-heals', () => {
  // A reauth failure at T followed by a success on the SAME entity 30s
  // later = a token-race self-heal.
  const reauthFail = ev({
    created_at: '2026-07-18T12:00:00Z',
    processed: false, landed: null,
    error: 'jobber_reauth_required', reason: 'jobber_reauth_required',
    topic: 'JOB_UPDATE', jobber_item: '900', location_name: 'Portland',
  })
  const healSuccess = ev({
    created_at: '2026-07-18T12:00:30Z',
    processed: true, landed: 'landed',
    topic: 'JOB_UPDATE', jobber_item: '900', location_name: 'Portland',
  })

  it('classifies fail→success on the same entity as a self-heal, not a failure or a landed event', () => {
    const d = buildWebhookDigest({
      events: [leadIn('boulder-01'), reauthFail, healSuccess],
      appUrl: APP,
    })
    // Real activity (the lead) keeps it firing, but the self-heal is neither
    // a failure nor an extra landed Jobber event.
    expect(d.suppressed).toBe(false)
    expect(d.allClear).toBe(true)
    expect(d.jobberDidntLand).toBe(0)
    expect(d.jobberLanded).toBe(0)
    expect(d.selfHeals).toBe(1)
    expect(d.headline).not.toContain(':warning:')
    expect(d.text).toContain(':recycle: 1 token self-heal — Portland (expected, no action)')
  })

  it('SUPPRESSES a window whose only activity was self-heals', () => {
    const d = buildWebhookDigest({ events: [reauthFail, healSuccess], appUrl: APP })
    expect(d.suppressed).toBe(true)
    expect(d.headline).not.toContain(':warning:')
  })

  it('a reauth failure OUTSIDE the heal window is a genuine expiry — real didn\'t-land, flagged loud', () => {
    const lateSuccess = ev({
      created_at: new Date(Date.parse(reauthFail.created_at) + SELF_HEAL_WINDOW_MS + 60_000).toISOString(),
      processed: true, landed: 'landed', topic: 'JOB_UPDATE', jobber_item: '900', location_name: 'Portland',
    })
    const d = buildWebhookDigest({ events: [reauthFail, lateSuccess], appUrl: APP })
    expect(d.selfHeals).toBe(0)
    expect(d.jobberDidntLand).toBe(1)
    expect(d.jobberLanded).toBe(1) // the late success is a genuine separate landing
    expect(d.headline).toContain(':warning:')
    expect(d.text).toContain(':key: token expired — reconnect')
  })

  it('a reauth failure with NO following success at all is a genuine expiry (e.g. loc_kc)', () => {
    const d = buildWebhookDigest({
      events: [ev({ processed: false, landed: null, error: 'jobber_reauth_required',
                    reason: 'jobber_reauth_required', topic: 'INVOICE_UPDATE', friendly: 'Invoice updated',
                    jobber_item: '77', location_id: 'loc_kc', location_name: 'Kansas City' })],
      appUrl: APP,
    })
    expect(d.selfHeals).toBe(0)
    expect(d.jobberDidntLand).toBe(1)
    expect(d.headline).toContain(':warning:')
    expect(d.text).toContain('Kansas City')
    expect(d.text).toContain(':key: token expired — reconnect')
  })
})

describe('buildWebhookDigest — quiet window suppresses', () => {
  it('sends nothing when there were no events at all', () => {
    const d = buildWebhookDigest({ events: [], appUrl: APP })
    expect(d.suppressed).toBe(true)
    expect(d.leadsLanded).toBe(0)
    expect(d.jobberLanded).toBe(0)
  })
})

describe('buildWebhookDigest — loc_other spike detection', () => {
  it('labels a normal loc_other share "(normal)"', () => {
    const d = buildWebhookDigest({
      events: [leadIn('boulder-01'), leadIn('denver-02'), leadIn('aspen-03'), leadIn('loc_other')],
      appUrl: APP,
    })
    expect(d.locOtherLeads).toBe(1)
    expect(d.locOtherSpike).toBe(false)
    expect(d.text).toContain('loc_other ×1 (normal)')
  })

  it('flags a spike when loc_other dominates the window', () => {
    const d = buildWebhookDigest({
      events: [leadIn('boulder-01'), leadIn('loc_other'), leadIn('loc_other'), leadIn('loc_other')],
      appUrl: APP,
    })
    expect(d.locOtherLeads).toBe(3)
    expect(d.locOtherSpike).toBe(true)
    expect(d.text).toContain('loc_other ×3 :warning: spike')
    // A spike is a leads-section flag, not a headline driver (nothing failed).
    expect(d.headline).toContain(':white_check_mark:')
  })

  it('does not flag a spike below the volume floor (avoids 1-of-1 = 100%)', () => {
    const d = buildWebhookDigest({ events: [leadIn('loc_other')], appUrl: APP })
    expect(d.locOtherSpike).toBe(false)
    expect(d.text).toContain('loc_other ×1 (normal)')
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

  it('queries the 3h window', () => {
    expect(route).toContain("fetchWebhookLogEvents({ window: '3h' })")
    expect(route).toContain("windowLabel: 'last 3h'")
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

  it('vercel.json registers the every-3-hours schedule', () => {
    expect(vercel).toContain('"path": "/api/cron/webhook-digest", "schedule": "0 */3 * * *"')
  })
})
