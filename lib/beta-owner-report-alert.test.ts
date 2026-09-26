// @vitest-environment node
//
// The owner-report alert (Sept 2026). Any report an owner files — bug,
// question or feature idea — pings Kevin within one 5-minute alert run, as
// its OWN message, carrying enough to judge urgency without opening Bee Hub:
// the type, who, which location, the title, a trimmed description, the screen
// it was filed from and the screenshot count, plus a link to the ADMIN
// Feedback list.
//
// THE BUG THIS PINS: the first version linked to /?feedback=1 — the owner's
// reply-email deep link, which now redirects to the OWNER's own Help › My
// requests page. Kevin would have tapped it and landed somewhere useless.
//
// Driven through the REAL cron route (app/api/cron/failure-alerts) with only
// the database, the webhook-log reader and Slack faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

const db = vi.hoisted(() => ({ tables: {} as Record<string, any[]> }))
vi.mock('@/lib/supabase-service', () => {
  const from = (table: string) => {
    const b: any = {
      then: (resolve: (v: any) => void) => resolve({ data: db.tables[table] ?? [], error: null }),
    }
    for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'in', 'ilike', 'not', 'or', 'order', 'limit', 'is']) {
      b[m] = () => b
    }
    return b
  }
  return { supabaseService: { from } }
})
vi.mock('@/lib/webhook-observability', () => ({
  fetchWebhookLogEvents: vi.fn(async () => ({ events: [], truncated: false })),
}))
vi.mock('@/lib/slack', () => ({ postSlackMessage: vi.fn(async () => ({ ok: true })) }))
const runs = vi.hoisted(() => ({ watermark: null as string | null }))
vi.mock('@/lib/alert-runs', () => ({
  fetchLastAlertWatermark: vi.fn(async () => ({ tracked: true, watermark: runs.watermark })),
  recordAlertRun: vi.fn(async () => {}),
}))

import { postSlackMessage } from '@/lib/slack'
import { GET as failureAlerts } from '@/app/api/cron/failure-alerts/route'
import { trimDescription, OWNER_REPORT_DESC_MAX } from '@/lib/failure-alerts'
import { buildNudge } from '@/lib/feedback-nudge'

const NOW = Date.parse('2026-09-26T15:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const SINCE = NOW - 10 * MIN
const IN_WIN = NOW - 8 * MIN
const APP = 'https://beehive.example.com'

const report = (over: Record<string, any> = {}) => ({
  user_id: 'user-jane',
  type: 'bug',
  title: 'Calendar will not load',
  description: 'It spins forever when I open Tuesday.',
  location_id: 'uuid-portland',
  created_at: iso(IN_WIN),
  updated_at: iso(IN_WIN),
  is_internal: false,
  attachments: [],
  context: { screen: 'Clients', origin: 'engagement_panel_menu', kind: 'engagement', stage: 'Request', lead_id: 'lead-1' },
  ...over,
})

const run = () => failureAlerts(new NextRequest(`${APP}/api/cron/failure-alerts?secret=s3cret`))
const posts = () => (postSlackMessage as any).mock.calls.map((c: any[]) => String(c[0])) as string[]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 's3cret'
  process.env.NEXT_PUBLIC_APP_URL = APP
  runs.watermark = iso(SINCE)
  db.tables = {
    locations: [
      { id: 'uuid-portland', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active' },
      { id: 'uuid-nova', location_id: 'loc_nova', name: 'Nova', subscription_status: 'active' },
    ],
    hub_users: [
      { id: 'user-jane', full_name: 'Jane Smith', email: 'jane@example.com' },
      { id: 'user-sam', full_name: null, first_name: 'Sam', last_name: 'Lee', email: 'sam@example.com' },
    ],
    feedback_items: [],
  }
  ;(postSlackMessage as any).mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('a new report sends one message', () => {
  it('one report → exactly one Slack message', async () => {
    db.tables.feedback_items = [report()]
    await run()
    expect(posts()).toHaveLength(1)
  })

  it('two reports → two messages, not one combined', async () => {
    db.tables.feedback_items = [
      report(),
      report({ user_id: 'user-sam', location_id: 'uuid-nova', type: 'question', title: 'How do I add a second address?', created_at: iso(IN_WIN + MIN) }),
    ]
    await run()
    const p = posts()
    expect(p).toHaveLength(2)
    expect(p[0]).toContain('Calendar will not load')
    expect(p[0]).not.toContain('second address')
    expect(p[1]).toContain('How do I add a second address?')
    expect(p[1]).not.toContain('Calendar will not load')
  })
})

describe('the message carries who, where and what they wrote', () => {
  it('owner name, location, type, title, description, screen and screenshots', async () => {
    db.tables.feedback_items = [report({
      attachments: [{ path: 'user-jane/a.png' }, { path: 'user-jane/b.png' }],
    })]
    await run()
    const [m] = posts()
    expect(m).toContain(':beetle: *BUG* — Jane Smith, Portland')
    expect(m).toContain('*Calendar will not load*')
    expect(m).toContain('> It spins forever when I open Tuesday.')
    expect(m).toContain("Filed from Clients (on a client's Request-stage job) · 2 screenshots")
  })

  it('falls back to first + last name when full_name is blank', async () => {
    db.tables.feedback_items = [report({ user_id: 'user-sam', location_id: 'uuid-nova' })]
    await run()
    expect(posts()[0]).toContain('— Sam Lee, Nova')
  })

  it('says so plainly when there are no screenshots or no recorded screen', async () => {
    db.tables.feedback_items = [report({ context: null, attachments: [] })]
    await run()
    expect(posts()[0]).toContain('Screen not recorded · no screenshots')
  })

  it('a long description is trimmed on a word, marked with …, and never pasted whole', async () => {
    const long = 'word '.repeat(400).trim() // 1,999 characters
    db.tables.feedback_items = [report({ description: long })]
    await run()
    const quoted = posts()[0].split('\n').filter(l => l.startsWith('> ')).join('\n')
    expect(quoted.endsWith(' …')).toBe(true)
    expect(quoted.length).toBeLessThanOrEqual(OWNER_REPORT_DESC_MAX + 4)
    expect(quoted).not.toMatch(/wor …$/) // cut on a word boundary
  })

  it('keeps the owner\'s line breaks, up to four lines', () => {
    expect(trimDescription('1. Open Tuesday\n2. Click a job\n\n3. Spinner')).toBe('1. Open Tuesday\n2. Click a job\n3. Spinner')
    expect(trimDescription('a\nb\nc\nd\ne')).toBe('a\nb\nc\nd …')
  })
})

describe('the link is the admin Feedback list — never /?feedback=1', () => {
  it('links to /admin?adminTab=feedback, labelled as the list', async () => {
    db.tables.feedback_items = [report()]
    await run()
    const [m] = posts()
    expect(m).toContain(`<${APP}/admin?adminTab=feedback|Open the Feedback list>`)
    expect(m).toContain('no link to a single report exists yet')
    expect(m).not.toContain('feedback=1')
  })

  it('no message of any type ever carries the owner link', async () => {
    db.tables.feedback_items = [
      report(),
      report({ type: 'question', created_at: iso(IN_WIN + 1) }),
      report({ type: 'feature', created_at: iso(IN_WIN + 2) }),
    ]
    await run()
    expect(posts()).toHaveLength(3)
    for (const m of posts()) expect(m).not.toContain('?feedback=1')
  })
})

describe('a feature request alerts, with its type visible', () => {
  it('an idea pings like a bug, and reads as an IDEA at a glance', async () => {
    db.tables.feedback_items = [report({ type: 'feature', title: 'Dark mode please', description: 'Evenings are bright.' })]
    await run()
    const p = posts()
    expect(p).toHaveLength(1)
    expect(p[0].startsWith(':bulb: *IDEA* — Jane Smith, Portland')).toBe(true)
    expect(p[0]).not.toContain('BUG')
  })

  it('each type has its own icon and word on the first line', async () => {
    db.tables.feedback_items = [
      report({ type: 'bug' }),
      report({ type: 'question', created_at: iso(IN_WIN + 1) }),
      report({ type: 'feature', created_at: iso(IN_WIN + 2) }),
    ]
    await run()
    expect(posts().map(m => m.split('\n')[0].split(' —')[0])).toEqual([
      ':beetle: *BUG*', ':question: *QUESTION*', ':bulb: *IDEA*',
    ])
  })

  it('an internal item still does not page', async () => {
    db.tables.feedback_items = [report({ is_internal: true })]
    await run()
    expect(posts()).toHaveLength(0)
  })
})

describe('an edited or deleted report does NOT re-alert', () => {
  it('a report edited now, but filed before the window, sends nothing', async () => {
    db.tables.feedback_items = [report({ created_at: iso(NOW - 3 * 60 * MIN), updated_at: iso(IN_WIN) })]
    await run()
    expect(posts()).toHaveLength(0)
  })

  it('the same report is silent on the next run — alerted once', async () => {
    db.tables.feedback_items = [report()]
    await run()
    expect(posts()).toHaveLength(1)
    ;(postSlackMessage as any).mockClear()
    runs.watermark = iso(NOW - 5 * MIN)      // the watermark the first run stored
    vi.setSystemTime(NOW + 5 * MIN)
    await run()
    expect(posts()).toHaveLength(0)
  })

  it('a report deleted after it alerted produces nothing further', async () => {
    db.tables.feedback_items = [report()]
    await run()
    ;(postSlackMessage as any).mockClear()
    db.tables.feedback_items = []            // deleted
    runs.watermark = iso(NOW - 5 * MIN)
    vi.setSystemTime(NOW + 5 * MIN)
    await run()
    expect(posts()).toHaveLength(0)
  })
})

describe('the 5am queue digest: only its link changed', () => {
  // Pinned at a65d887 with the old /?feedback=1 link; the link is the ONE
  // thing the digest-link fix changed. Every other word must stay put.
  it('produces exactly the same message, now with the admin link', () => {
    const r = buildNudge({
      summary: { open: 46, closed: 10, total: 56, counts: { new: 36, stale: 4, working: 3, inHand: 3 }, oldestNewDays: 51, oldestStaleDays: 20 },
      oldestNewDays: 51,
      triageUrl: `${APP}/admin?adminTab=feedback`,
    })
    expect(r.post).toEqual({
      text: 'Feedback — where the queue stands',
      attachments: [{
        color: '#d97706',
        fallback: '46 open feedback items',
        text: `46 open · 36 not looked at · 4 gone quiet · 3 in progress\nOldest untouched: 51 days.\n<${APP}/admin?adminTab=feedback|Open triage>`,
      }],
    })
  })

  it('the digest cron does not reach into the instant owner-report alert', () => {
    const route = readFileSync(join(process.cwd(), 'app/api/cron/feedback-brief/route.ts'), 'utf8')
    expect(route).not.toContain('failure-alerts')
    expect(route).not.toContain('ownerReport')
  })
})
