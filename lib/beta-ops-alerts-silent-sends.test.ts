// @vitest-environment node
//
// Silent-sends ops alerting — the instant failure-alert rail (issue 159's
// watermark cron):
//
//   • SLACK: a per-location lead alert that failed to post (notification_log
//     channel='slack' send_status='failed') USED to alert here. The Sept 2026
//     rebuild removed it: every one is the OWNER's private channel
//     (channel_not_found / not_in_channel), which Kevin cannot fix. Pinned
//     below as silent.
//   • EMAIL HELD (issue 316): a send held for a blank subject that has stayed
//     held for HELD_SUBJECT_ALERT_MS (6h). A fresh hold is mid-edit noise and
//     stays quiet; the alert moment is due_at + 6h windowed through the
//     watermark (the stranded-checkout idiom), so each held send alerts
//     exactly once — and only if it is STILL held when the moment commits.
//
// What deliberately does NOT alert (pinned below): successful sends, Slack
// skips/mutes (nothing was attempted), email 'failed' rows (hourly-retried +
// auto-stop capped), holds younger than 6h, rate/booking-link holds, and an
// unused blank-subject template that nothing is trying to send.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import {
  selectNewAlerts,
  buildAlertMessages,
  collectFailureAlerts,
  fetchHeldSubjectEmails,
  ALERT_SETTLE_MS,
  HELD_SUBJECT_ALERT_MS,
  type HeldSubjectEmailRow,
} from '@/lib/failure-alerts'

const NOW = Date.parse('2026-08-25T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

const CUTOFF = NOW - ALERT_SETTLE_MS
const SINCE = NOW - 10 * MIN
const inWin = NOW - 8 * MIN

// Base selector input: everything empty, a window that would fire if fed.
const base = {
  events: [],
  importFailed: [],
  mismatches: [],
  locName: new Map([['loc_portland', 'Portland']]),
  locNameByUuid: new Map([['loc-uuid-1', 'Portland']]),
  sinceMs: SINCE,
  cutoffMs: CUTOFF,
  nowMs: NOW,
}

const slackFail = (over: Record<string, any> = {}) => ({
  location_slug: 'loc_portland',
  lead_name: 'Jane Doe',
  error: 'channel_not_found',
  created_at: iso(inWin),
  ...over,
})

// A drip send that came due `age` ago and is still held for a blank subject.
const held = (age: number, over: Partial<HeldSubjectEmailRow> = {}): HeldSubjectEmailRow => ({
  source: 'drip',
  lead_name: 'Sam Smith',
  location_uuid: 'loc-uuid-1',
  due_at: iso(NOW - age),
  ...over,
})

// ═══ Slack failures reach the rail ═══

describe("slack channel failures are the owner's fix — never an alert", () => {
  it('the selector no longer accepts or reports Slack failures', () => {
    const items = selectNewAlerts({ ...base, ...({ slackFailures: [slackFail()] } as any) })
    expect(items).toEqual([])
  })

  it('collect never reads notification_log, so failed Slack rows cannot reach Kevin', async () => {
    const { supabase, enqueue, calls } = makeQueuedSupabase()
    enqueue('locations', [{ id: 'loc-uuid-1', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active' }])
    enqueue('notification_log', [slackFail(), slackFail({ error: 'not_in_channel' })])
    const fetchEvents = vi.fn(async () => ({ events: [], truncated: false }))
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    expect(out.items).toEqual([])
    expect(calls.map((c: any) => c.table)).not.toContain('notification_log')
  })
})

// ═══ Held emails reach the rail — after 6 hours, once ═══

describe('selectNewAlerts — email_held (blank subject, 6h threshold)', () => {
  it('a hold whose 6h moment falls in the window fires, with age + release copy', () => {
    // due 6h before a moment inside the window → moment = inWin
    const items = selectNewAlerts({ ...base, heldEmails: [held(HELD_SUBJECT_ALERT_MS + 8 * MIN)] })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('email_held')
    expect(items[0].text).toContain('Portland')
    expect(items[0].text).toContain('Sam Smith')
    expect(items[0].text).toMatch(/blank subject/)
    expect(items[0].text).toMatch(/6h/)
    expect(items[0].text).toMatch(/releases itself/)
  })

  it('BELOW the threshold, silence: a fresh hold (2h) does not alert', () => {
    const items = selectNewAlerts({ ...base, heldEmails: [held(2 * HOUR)] })
    expect(items).toEqual([])
  })

  it('a hold just short of settling (moment after cutoff) waits for its window', () => {
    const items = selectNewAlerts({ ...base, heldEmails: [held(HELD_SUBJECT_ALERT_MS + MIN)] })
    expect(items).toEqual([])
  })

  it('watermark: a held send alerted in one window is silent in the next', () => {
    const row = held(HELD_SUBJECT_ALERT_MS + 8 * MIN)
    const run1 = selectNewAlerts({ ...base, heldEmails: [row] })
    expect(run1).toHaveLength(1)
    const run2 = selectNewAlerts({
      ...base, heldEmails: [row],
      sinceMs: CUTOFF, cutoffMs: NOW, nowMs: NOW + 5 * MIN,
    })
    expect(run2).toEqual([])
  })

  it('all three sources render their own label (drip / welcome / stage)', () => {
    const age = HELD_SUBJECT_ALERT_MS + 8 * MIN
    const items = selectNewAlerts({
      ...base,
      heldEmails: [
        held(age, { source: 'drip' }),
        held(age, { source: 'welcome', lead_name: 'Wendy' }),
        held(age, { source: 'stage', lead_name: 'Stan' }),
      ],
    })
    expect(items.map(i => i.text).join('\n')).toContain('drip email')
    expect(items.map(i => i.text).join('\n')).toContain('welcome email')
    expect(items.map(i => i.text).join('\n')).toContain('stage email')
  })
})

// ═══ fetchHeldSubjectEmails — what counts as held, per queue ═══

// Chainable, awaitable builder with per-table FIFO queues (a table can be
// read more than once here — leads serves drip-held, welcome, and stage-lead
// reads — so FIFO beats the single-map style).
function makeQueuedSupabase() {
  const queues = new Map<string, any[][]>()
  const calls: Array<{ table: string; ops: [string, any[]][] }> = []
  const enqueue = (table: string, rows: any[]) => {
    if (!queues.has(table)) queues.set(table, [])
    queues.get(table)!.push(rows)
  }
  const supabase: any = {
    from(table: string) {
      const rec = { table, ops: [] as [string, any[]][] }
      calls.push(rec)
      const q = queues.get(table)
      const data = q && q.length ? q.shift()! : []
      const b: any = {
        then: (resolve: (v: any) => void) => resolve({ data, error: null }),
      }
      for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'ilike', 'not', 'or', 'order', 'limit', 'is', 'in']) {
        b[m] = (...args: any[]) => { rec.ops.push([m, args]); return b }
      }
      return b
    },
  }
  return { supabase, calls, enqueue }
}

describe('fetchHeldSubjectEmails', () => {
  const PROG = { lead_id: 'lead-1', next_send_at: iso(NOW - HELD_SUBJECT_ALERT_MS - 8 * MIN) }

  it('drip: an active due row whose lead carries the subject-hold badge is returned', async () => {
    const { supabase, calls, enqueue } = makeQueuedSupabase()
    enqueue('lead_drip_progress', [PROG])
    enqueue('leads', [{ id: 'lead-1', name: 'Sam', location_uuid: 'loc-uuid-1' }]) // drip-held read
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([
      { source: 'drip', lead_name: 'Sam', location_uuid: 'loc-uuid-1', due_at: PROG.next_send_at },
    ])
    // …and the lead read is scoped to the SENDER'S OWN verdict, so a rate or
    // booking-link hold (different drip_last_send_error) can never match.
    const leadCall = calls.find(c => c.table === 'leads')!
    expect(leadCall.ops.find(o => o[0] === 'eq')?.[1]).toEqual(['drip_last_send_status', 'failed'])
    expect(leadCall.ops.find(o => o[0] === 'ilike')?.[1][1]).toContain('subject is blank')
  })

  it('drip: a due row whose lead is NOT subject-held (e.g. rate hold) returns nothing', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('lead_drip_progress', [PROG])
    enqueue('leads', []) // the ilike filter matched no lead
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([])
  })

  it('welcome: a pending welcome whose master subject is blank is returned', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('lead_drip_progress', [])
    enqueue('leads', [{ id: 'lead-2', name: 'Wendy', location_uuid: 'loc-uuid-1', welcome_email_scheduled_at: PROG.next_send_at }]) // welcome read
    enqueue('scheduled_stage_emails', [])
    enqueue('templates', [{ id: 'tpl-w', legacy_id: 'welcome', subject: null }]) // masters
    enqueue('templates', []) // forks
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([
      { source: 'welcome', lead_name: 'Wendy', location_uuid: 'loc-uuid-1', due_at: PROG.next_send_at },
    ])
  })

  it('welcome: a REAL master subject (normal successful path) returns nothing', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('lead_drip_progress', [])
    enqueue('leads', [{ id: 'lead-2', name: 'Wendy', location_uuid: 'loc-uuid-1', welcome_email_scheduled_at: PROG.next_send_at }])
    enqueue('scheduled_stage_emails', [])
    enqueue('templates', [{ id: 'tpl-w', legacy_id: 'welcome', subject: 'Welcome to Bee Organized!' }])
    enqueue('templates', [])
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([])
  })

  it("stage: a fork whose subject is EMPTY-STRING shadows the master ('' ?? master) and IS held", async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('lead_drip_progress', [])
    enqueue('leads', []) // welcome read
    enqueue('scheduled_stage_emails', [{ lead_id: 'lead-3', stage_email_key: 'opp_closed_job_3mo', send_at: PROG.next_send_at }])
    enqueue('leads', [{ id: 'lead-3', name: 'Stan', location_uuid: 'loc-uuid-1' }]) // stage leads
    enqueue('templates', [{ id: 'tpl-s', legacy_id: 'opp_closed_job_3mo', subject: 'Real master subject' }]) // masters
    enqueue('templates', [{ cloned_from_id: 'tpl-s', location_uuid: 'loc-uuid-1', subject: '', updated_at: iso(NOW) }]) // forks
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([
      { source: 'stage', lead_name: 'Stan', location_uuid: 'loc-uuid-1', due_at: PROG.next_send_at },
    ])
  })

  it('stage: a fork with a NULL subject FALLS BACK to a real master subject → not held', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('lead_drip_progress', [])
    enqueue('leads', [])
    enqueue('scheduled_stage_emails', [{ lead_id: 'lead-3', stage_email_key: 'opp_closed_job_3mo', send_at: PROG.next_send_at }])
    enqueue('leads', [{ id: 'lead-3', name: 'Stan', location_uuid: 'loc-uuid-1' }])
    enqueue('templates', [{ id: 'tpl-s', legacy_id: 'opp_closed_job_3mo', subject: 'Real master subject' }])
    enqueue('templates', [{ cloned_from_id: 'tpl-s', location_uuid: 'loc-uuid-1', subject: null, updated_at: iso(NOW) }])
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([])
  })

  it('a completely quiet system (no due rows anywhere) does no template reads at all', async () => {
    const { supabase, calls } = makeQueuedSupabase()
    const rows = await fetchHeldSubjectEmails(supabase, SINCE, CUTOFF)
    expect(rows).toEqual([])
    expect(calls.filter(c => c.table === 'templates')).toHaveLength(0)
  })
})

// ═══ end to end through collect + the message ═══

describe('collectFailureAlerts — the two new sources flow to the Slack post', () => {
  it('a 6h-held email alerts on its own; a Slack failure beside it does not', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('locations', [{ id: 'loc-uuid-1', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active' }])
    enqueue('notification_log', [slackFail()])
    enqueue('lead_drip_progress', [{ lead_id: 'lead-1', next_send_at: iso(NOW - HELD_SUBJECT_ALERT_MS - 8 * MIN) }])
    enqueue('leads', [{ id: 'lead-1', name: 'Sam', location_uuid: 'loc-uuid-1' }])
    const fetchEvents = vi.fn(async () => ({ events: [], truncated: false }))

    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    expect(out.items.map(i => i.kind)).toEqual(['email_held'])

    const msgs = buildAlertMessages(out.items)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toContain(':envelope:')
    expect(msgs[0].text).toContain('Portland')
  })

  it('a normal quiet run (successful sends only) alerts nobody', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('locations', [{ id: 'loc-uuid-1', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active' }])
    // notification_log has only accepted rows → the failed-scoped fetch returns []
    const fetchEvents = vi.fn(async () => ({ events: [], truncated: false }))
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    expect(out.items).toEqual([])
    expect(buildAlertMessages(out.items)).toEqual([])
  })
})
