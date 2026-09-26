// @vitest-environment node
//
// The 5am feedback digest links Kevin to the ADMIN Feedback list.
//
// It used to link to /?feedback=1 — the owner's reply-email link, which
// redirects to the owner's own Help › My requests page — so "Open triage"
// sent Kevin somewhere that showed him nothing. Same bug the owner-report
// alert shipped with (lib/beta-owner-report-alert.test.ts). Both now share
// lib/feedback-triage-link.
//
// Driven through the REAL cron route (app/api/cron/feedback-brief) with the
// feedback read, the heartbeat and Slack faked. Both of its Slack posts are
// checked: the queue nudge and the unopened-reply alert.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const slack = vi.hoisted(() => ({ fn: vi.fn(async () => ({ ok: true })) }))
const data = vi.hoisted(() => ({ items: [] as any[] }))
vi.mock('@/lib/slack', () => ({ postSlackMessage: slack.fn }))
// failure-alerts (imported for the shared-constant check) binds the service
// client at load; nothing here reads the database.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('unused') } } }))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: vi.fn(async () => ({ success: true })) }))
vi.mock('@/lib/feedback-brief-data', () => ({
  fetchFeedbackForBrief: vi.fn(async () => ({ items: data.items, ok: true, internalSupported: true })),
}))
vi.mock('@/lib/digest-runs', () => ({
  recordFeedbackBriefRun: vi.fn(async () => {}),
  fetchFeedbackAlertState: vi.fn(async () => ({ lastBriefRunAt: null, unopenedAlertedBefore: false })),
  recordFeedbackUnopenedRun: vi.fn(async () => {}),
}))

import { GET } from '@/app/api/cron/feedback-brief/route'
import { FEEDBACK_TRIAGE_PATH } from '@/lib/feedback-triage-link'
import { FEEDBACK_TRIAGE_PATH as ALERT_PATH } from '@/lib/failure-alerts'

const APP = 'https://beehive.example.com'
const NOW = Date.parse('2026-09-26T11:00:00Z')
const DAY = 86_400_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const item = (over: any = {}) => ({
  id: 'fresh-1', type: 'bug', title: 'Calendar will not load', description: 'Spins.',
  status: 'submitted', is_internal: false, location_id: 'uuid-portland',
  created_at: iso(DAY / 2), updated_at: iso(DAY / 2),
  admin_response: null, admin_response_at: null, reply_seen_at: null,
  ...over,
})
// An answer the owner never opened, old enough to trip the unopened alert.
const unread = () => item({
  id: 'old-1', status: 'shipped', created_at: iso(60 * DAY), updated_at: iso(30 * DAY),
  admin_response: 'We wrote back.', admin_response_at: iso(30 * DAY),
})

const run = () => GET(new NextRequest(`${APP}/api/cron/feedback-brief?secret=s3cret`))
// Everything a post carries — top-level text and attachment bodies.
const payloads = () =>
  slack.fn.mock.calls.map((c: any[]) =>
    [String(c[0] ?? ''), ...((c[1] as any[]) || []).map(a => `${a.text}\n${a.fallback}`)].join('\n'),
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 's3cret'
  process.env.NEXT_PUBLIC_APP_URL = APP
  data.items = []
  slack.fn.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe("the 5am digest's Open triage link", () => {
  it('the queue nudge links to the admin Feedback list', async () => {
    data.items = [item()]
    await run()
    const nudge = payloads().find(p => p.includes('open ·'))
    expect(nudge).toBeDefined()
    expect(nudge).toContain(`<${APP}/admin?adminTab=feedback|Open triage>`)
    expect(nudge).not.toContain('feedback=1')
  })

  it('the unopened-reply alert from the same run links there too', async () => {
    data.items = [unread()]
    await run()
    const alert = payloads().find(p => p.includes('never been opened'))
    expect(alert).toBeDefined()
    expect(alert).toContain(`${APP}/admin?adminTab=feedback`)
    expect(alert).not.toContain('feedback=1')
  })

  it('no post from this cron carries the owner link', async () => {
    data.items = [item(), unread()]
    await run()
    expect(slack.fn).toHaveBeenCalled()
    for (const p of payloads()) expect(p).not.toContain('?feedback=1')
  })

  it('the digest and the owner-report alert use the one shared link', () => {
    expect(FEEDBACK_TRIAGE_PATH).toBe('/admin?adminTab=feedback')
    expect(ALERT_PATH).toBe(FEEDBACK_TRIAGE_PATH)
  })
})
