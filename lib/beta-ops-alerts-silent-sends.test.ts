// @vitest-environment node
//
// Silent-sends ops alerting — two failure shapes that were handled correctly
// and told nobody now reach the instant failure-alert rail (issue 159's
// watermark cron):
//
//   • SLACK: a per-location lead alert that failed to post (notification_log
//     channel='slack' send_status='failed'). Nothing retries these, so ONE
//     failure = one permanently missed lead → the FIRST failure alerts, one
//     line per location per window carrying the count.
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
  buildAlertMessage,
  collectFailureAlerts,
  fetchSlackSendFailures,
  fetchHeldSubjectEmails,
  ALERT_SETTLE_MS,
  HELD_SUBJECT_ALERT_MS,
  type SlackFailureRow,
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

const slackFail = (over: Partial<SlackFailureRow> = {}): SlackFailureRow => ({
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

describe('selectNewAlerts — slack_failed', () => {
  it('a single failed Slack post fires on the FIRST failure, named + actionable', () => {
    const items = selectNewAlerts({ ...base, slackFailures: [slackFail()] })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('slack_failed')
    expect(items[0].text).toContain('Portland')
    expect(items[0].text).toContain('Jane Doe')
    // channel_not_found maps to words Kevin can act on, not the raw code alone
    expect(items[0].text).toMatch(/private/i)
    expect(items[0].text).toMatch(/invite|reconnect/i)
  })

  it('several failures at ONE location collapse to one line carrying the count', () => {
    const items = selectNewAlerts({
      ...base,
      slackFailures: [
        slackFail({ lead_name: 'A', created_at: iso(inWin) }),
        slackFail({ lead_name: 'B', created_at: iso(inWin + MIN) }),
        slackFail({ lead_name: 'C', created_at: iso(inWin + 2 * MIN) }),
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0].text).toContain('3 lead alerts never posted')
  })

  it('failures at different locations get their own lines', () => {
    const locName = new Map([['loc_portland', 'Portland'], ['loc_katy', 'Katy']])
    const items = selectNewAlerts({
      ...base,
      locName,
      slackFailures: [slackFail(), slackFail({ location_slug: 'loc_katy', lead_name: 'Bo' })],
    })
    expect(items).toHaveLength(2)
    expect(items.map(i => i.text).join('\n')).toContain('Portland')
    expect(items.map(i => i.text).join('\n')).toContain('Katy')
  })

  it('a dead-token failure tells Kevin the owner must reconnect', () => {
    const items = selectNewAlerts({ ...base, slackFailures: [slackFail({ error: 'token_revoked' })] })
    expect(items[0].text).toMatch(/reconnect/i)
  })

  it('watermark: a row alerted in one window is silent in the next', () => {
    const row = slackFail()
    const run1 = selectNewAlerts({ ...base, slackFailures: [row] })
    expect(run1).toHaveLength(1)
    const run2 = selectNewAlerts({ ...base, slackFailures: [row], sinceMs: CUTOFF, cutoffMs: NOW, nowMs: NOW + 5 * MIN })
    expect(run2).toEqual([])
  })

  it('a not-yet-settled row (after cutoff) waits for its window', () => {
    const items = selectNewAlerts({ ...base, slackFailures: [slackFail({ created_at: iso(NOW - MIN) })] })
    expect(items).toEqual([])
  })
})

describe('fetchSlackSendFailures — scoped to exactly the slack-failed slice', () => {
  function makeSupabase(byTable: Record<string, any[]>) {
    const calls: Array<{ table: string; ops: [string, any[]][] }> = []
    const supabase: any = {
      from(table: string) {
        const rec = { table, ops: [] as [string, any[]][] }
        calls.push(rec)
        const b: any = {
          then: (resolve: (v: any) => void) => resolve({ data: byTable[table] ?? [], error: null }),
        }
        for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'ilike', 'not', 'or', 'order', 'limit', 'is', 'in']) {
          b[m] = (...args: any[]) => { rec.ops.push([m, args]); return b }
        }
        return b
      },
    }
    return { supabase, calls }
  }

  it("filters channel='slack', send_status='failed', created_at in (since, cutoff]", async () => {
    const { supabase, calls } = makeSupabase({ notification_log: [] })
    await fetchSlackSendFailures(supabase, iso(SINCE), iso(CUTOFF))
    const c = calls.find(c => c.table === 'notification_log')!
    const eqs = c.ops.filter(o => o[0] === 'eq').map(o => o[1])
    expect(eqs).toEqual(expect.arrayContaining([['channel', 'slack'], ['send_status', 'failed']]))
    expect(c.ops.find(o => o[0] === 'gt')?.[1]).toEqual(['created_at', iso(SINCE)])
    expect(c.ops.find(o => o[0] === 'lte')?.[1]).toEqual(['created_at', iso(CUTOFF)])
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
  it('a slack failure and a 6h-held email both land in one message; nothing else invents items', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('locations', [{ id: 'loc-uuid-1', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active' }])
    enqueue('notification_log', [slackFail()])
    enqueue('lead_drip_progress', [{ lead_id: 'lead-1', next_send_at: iso(NOW - HELD_SUBJECT_ALERT_MS - 8 * MIN) }])
    enqueue('leads', [{ id: 'lead-1', name: 'Sam', location_uuid: 'loc-uuid-1' }])
    const fetchEvents = vi.fn(async () => ({ events: [], truncated: false }))

    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    expect(out.items.map(i => i.kind).sort()).toEqual(['email_held', 'slack_failed'])

    const msg = buildAlertMessage(out.items)!
    expect(msg.count).toBe(2)
    expect(msg.text).toContain(':no_bell:')
    expect(msg.text).toContain(':envelope:')
    expect(msg.text).toContain('Portland')
  })

  it('a normal quiet run (successful sends only) alerts nobody', async () => {
    const { supabase, enqueue } = makeQueuedSupabase()
    enqueue('locations', [{ id: 'loc-uuid-1', location_id: 'loc_portland', name: 'Portland', subscription_status: 'active' }])
    // notification_log has only accepted rows → the failed-scoped fetch returns []
    const fetchEvents = vi.fn(async () => ({ events: [], truncated: false }))
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    expect(out.items).toEqual([])
    expect(buildAlertMessage(out.items)).toBeNull()
  })
})
