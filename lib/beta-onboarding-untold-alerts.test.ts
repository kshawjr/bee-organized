// @vitest-environment node
// Lead emails to ONBOARDING locations always reach someone (20 Oct 2026).
//
// Zip routing now sends a lead straight to an onboarding location
// (lib/zip-routing ROUTE_ONLY_TO_ACTIVE = false). Those locations mostly have
// no Bee Hub users and no Slack, so the lead email is the only way the owner
// hears about it. lib/failure-alerts kind 10 ('location_untold') pages Kevin
// when that email was not sent, failed, bounced or was marked as spam.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => ({}) } }))

import {
  selectNewAlerts,
  buildAlertMessages,
  collectFailureAlerts,
  fetchOnboardingUntold,
  type LocationUntoldRow,
} from '@/lib/failure-alerts'

const NOW = Date.parse('2026-10-20T18:00:00Z')
const SINCE = NOW - 10 * 60_000
const CUTOFF = NOW - 5 * 60_000
const IN_WIN = new Date(NOW - 7 * 60_000).toISOString()
const OLD = new Date(SINCE - 60_000).toISOString()

const locName = new Map([['loc_southorangecounty', 'South Orange County'], ['loc_reno', 'Reno']])
const select = (locationUntold: LocationUntoldRow[]) =>
  selectNewAlerts({
    events: [], importFailed: [], mismatches: [], locName,
    locationUntold, sinceMs: SINCE, cutoffMs: CUTOFF, nowMs: NOW,
  })
const row = (over: Partial<LocationUntoldRow>): LocationUntoldRow => ({
  lead_id: 'l1', lead_name: 'Loujean Test', location_slug: 'loc_southorangecounty',
  problem: 'bounced', recipients: ['infosouthoc@beeorganized.com'], at: IN_WIN, ...over,
})

describe('instant — an onboarding location never heard about a lead', () => {
  it('a bounce → one message naming the location, the lead and the address', () => {
    const items = select([row({})])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('location_untold')
    const [msg] = buildAlertMessages(items)
    expect(msg.text).toContain(':no_bell:')
    expect(msg.text).toContain("Lead email didn't reach South Orange County — Loujean Test")
    expect(msg.text).toContain('the email bounced (sent to infosouthoc@beeorganized.com')
    expect(msg.text).toContain("Resend doesn't say which address")
    expect(msg.text).toContain('Tell them directly')
  })

  it.each([
    ['zero_recipients', 'nobody is on its lead-alert list'],
    ['muted', 'its notifications are switched off'],
    ['failed', 'the email failed to send to infosouthoc@beeorganized.com (resend 500)'],
    ['complained', 'marked as spam by infosouthoc@beeorganized.com'],
  ] as const)('%s says why in words', (problem, words) => {
    const items = select([row({ problem, error: problem === 'failed' ? 'resend 500' : null, recipients: problem === 'zero_recipients' || problem === 'muted' ? [] : ['infosouthoc@beeorganized.com'] })])
    expect(items).toHaveLength(1)
    expect(items[0].text).toContain(words)
  })

  it('outside the window → nothing (the watermark already covered it)', () => {
    expect(select([row({ at: OLD })])).toHaveLength(0)
  })

  it('an unknown slug still alerts, by slug', () => {
    const [i] = select([row({ location_slug: 'loc_new' })])
    expect(i.text).toContain("didn't reach loc_new")
  })
})

// A fake that IGNORES row filters, so the fetcher's own row checks are what's
// tested. The two notification_log reads are told apart by which status column
// they filter on (send_status vs delivery_status).
const fakeDb = (t: { locations: any[]; cc?: any[]; sends?: any[]; deliveries?: any[]; locError?: boolean }) => ({
  from: (table: string) => {
    let statusCol = ''
    const b: any = {}
    for (const m of ['select', 'eq', 'gt', 'lte', 'order']) b[m] = () => b
    b.in = (c: string) => { if (c === 'send_status' || c === 'delivery_status') statusCol = c; return b }
    const result = () => {
      if (table === 'locations') return t.locError ? { data: null, error: { message: 'down' } } : { data: t.locations, error: null }
      if (table === 'lead_notification_global_cc') return { data: t.cc ?? [], error: null }
      return { data: statusCol === 'send_status' ? t.sends ?? [] : t.deliveries ?? [], error: null }
    }
    b.limit = async () => result()
    b.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
    return b
  },
}) as any

const LOCS = [
  { location_id: 'loc_southorangecounty', lifecycle_status: 'onboarding' },
  { location_id: 'loc_reno', lifecycle_status: 'onboarding' },
  { location_id: 'loc_omaha', lifecycle_status: 'active' },
  { location_id: 'loc_other', lifecycle_status: 'onboarding' },
]
const CC = [{ email: 'admin@beeorganized.com', active: true }, { email: 'Roza@beeorganized.com', active: true }]
const log = (over: any) => ({
  lead_id: 'l1', lead_name: 'A', location_slug: 'loc_southorangecounty', channel: 'email',
  email_kind: 'lead_notification_non_hub', recipient: 'infosouthoc@beeorganized.com',
  send_status: 'accepted', delivery_status: null, delivery_updated_at: null, error: null, created_at: IN_WIN, ...over,
})

describe('fetchOnboardingUntold', () => {
  it('a bounce on a whole message → one row per lead, the location address only, timed by delivery_updated_at', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      deliveries: [
        log({ delivery_status: 'bounced', delivery_updated_at: IN_WIN, created_at: OLD }),
        log({ delivery_status: 'bounced', delivery_updated_at: IN_WIN, created_at: OLD, recipient: 'admin@beeorganized.com' }),
        log({ delivery_status: 'bounced', delivery_updated_at: IN_WIN, created_at: OLD, recipient: 'roza@beeorganized.com' }),
      ],
    }), 'since', 'cutoff')
    expect(rows).toEqual([{
      lead_id: 'l1', lead_name: 'A', location_slug: 'loc_southorangecounty', problem: 'bounced',
      error: null, recipients: ['infosouthoc@beeorganized.com'], at: IN_WIN,
    }])
  })

  it('a failed send to corporate\'s copy ONLY is not an alert — the location got it', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      sends: [log({ send_status: 'failed', recipient: 'ADMIN@beeorganized.com', error: 'x' })],
    }), 'since', 'cutoff')
    expect(rows).toEqual([])
  })

  it('a failed send to two location addresses → one row naming both', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      sends: [
        log({ location_slug: 'loc_reno', send_status: 'failed', recipient: 'megan@beeorganized.com', error: 'resend 500' }),
        log({ location_slug: 'loc_reno', send_status: 'failed', recipient: 'second@beeorganized.com', error: 'resend 500' }),
      ],
    }), 'since', 'cutoff')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ location_slug: 'loc_reno', problem: 'failed', error: 'resend 500' })
    expect(rows[0].recipients).toEqual(['megan@beeorganized.com', 'second@beeorganized.com'])
  })

  it('zero_recipients and muted rows (no address) alert', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      sends: [
        log({ lead_id: 'l1', send_status: 'zero_recipients', recipient: null }),
        log({ lead_id: 'l2', send_status: 'muted', recipient: null, error: 'notifications_live=false' }),
      ],
    }), 'since', 'cutoff')
    expect(rows.map(r => [r.lead_id, r.problem, r.recipients])).toEqual([['l1', 'zero_recipients', []], ['l2', 'muted', []]])
  })

  it('a returning-client email counts too', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      sends: [log({ email_kind: 'lead_resubmission_non_hub', send_status: 'failed', error: 'x' })],
    }), 'since', 'cutoff')
    expect(rows).toHaveLength(1)
  })

  it('never this rail: active locations, loc_other, Slack, drips, delivered/opened, accepted sends', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      sends: [
        log({ lead_id: 'a', location_slug: 'loc_omaha', send_status: 'failed' }),        // active location
        log({ lead_id: 'b', location_slug: 'loc_other', send_status: 'failed' }),        // loc_other has its own rail
        log({ lead_id: 'c', channel: 'slack', send_status: 'failed' }),                  // Slack
        log({ lead_id: 'd', email_kind: 'drip', send_status: 'failed' }),                // a drip to the customer
        log({ lead_id: 'e', send_status: 'accepted' }),                                  // it went
      ],
      deliveries: [
        log({ lead_id: 'f', delivery_status: 'delivered', delivery_updated_at: IN_WIN }),
        log({ lead_id: 'g', delivery_status: 'opened', delivery_updated_at: IN_WIN }),
        log({ lead_id: 'h', delivery_status: 'bounced', delivery_updated_at: null }),
        log({ lead_id: 'i', location_slug: 'loc_omaha', delivery_status: 'bounced', delivery_updated_at: IN_WIN }),
      ],
    }), 'since', 'cutoff')
    expect(rows).toEqual([])
  })

  it('a send failure and a bounce on the same lead are two problems, two rows', async () => {
    const rows = await fetchOnboardingUntold(fakeDb({
      locations: LOCS, cc: CC,
      sends: [log({ send_status: 'failed', recipient: 'other@beeorganized.com', error: 'x' })],
      deliveries: [log({ delivery_status: 'bounced', delivery_updated_at: IN_WIN })],
    }), 'since', 'cutoff')
    expect(rows.map(r => r.problem).sort()).toEqual(['bounced', 'failed'])
  })

  it('no onboarding locations, or the locations read fails → nothing, no throw', async () => {
    const sends = [log({ send_status: 'failed' })]
    expect(await fetchOnboardingUntold(fakeDb({ locations: [LOCS[2]], sends }), 's', 'c')).toEqual([])
    expect(await fetchOnboardingUntold(fakeDb({ locations: LOCS, locError: true, sends }), 's', 'c')).toEqual([])
  })
})

// A recording fake: every read of a table gets that table's rows, and every
// filter call is kept so the query itself can be checked.
const recording = (byTable: Record<string, any[]>) => {
  const calls: Array<{ table: string; ops: [string, any[]][] }> = []
  const supabase: any = {
    from(table: string) {
      const rec = { table, ops: [] as [string, any[]][] }
      calls.push(rec)
      const b: any = { then: (res: any) => res({ data: byTable[table] ?? [], error: null }) }
      for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'ilike', 'not', 'or', 'order', 'limit', 'is', 'in']) {
        b[m] = (...args: any[]) => { rec.ops.push([m, args]); return b }
      }
      return b
    },
  }
  return { supabase, calls }
}

describe('the queries and the run', () => {
  it('send outcomes are windowed on created_at, bounces on delivery_updated_at, both email + onboarding slugs only', async () => {
    const { supabase, calls } = recording({ locations: LOCS, lead_notification_global_cc: CC, notification_log: [] })
    await fetchOnboardingUntold(supabase, 'S', 'C')
    const loc = calls.find(c => c.table === 'locations')!
    expect(loc.ops).toContainEqual(['eq', ['lifecycle_status', 'onboarding']])
    const reads = calls.filter(c => c.table === 'notification_log')
    expect(reads).toHaveLength(2)
    const send = reads.find(c => c.ops.some(o => o[0] === 'in' && o[1][0] === 'send_status'))!
    const del = reads.find(c => c.ops.some(o => o[0] === 'in' && o[1][0] === 'delivery_status'))!
    for (const c of [send, del]) {
      expect(c.ops).toContainEqual(['eq', ['channel', 'email']])
      expect(c.ops).toContainEqual(['in', ['location_slug', ['loc_southorangecounty', 'loc_reno']]])
    }
    expect(send.ops).toContainEqual(['in', ['send_status', ['muted', 'zero_recipients', 'failed']]])
    expect(send.ops).toContainEqual(['gt', ['created_at', 'S']])
    expect(send.ops).toContainEqual(['lte', ['created_at', 'C']])
    expect(del.ops).toContainEqual(['in', ['delivery_status', ['bounced', 'complained']]])
    expect(del.ops).toContainEqual(['gt', ['delivery_updated_at', 'S']])
    expect(del.ops).toContainEqual(['lte', ['delivery_updated_at', 'C']])
  })

  it('collectFailureAlerts pages for a South OC bounce, named, through the normal run', async () => {
    const { supabase } = recording({
      locations: [
        { id: 'u-soc', location_id: 'loc_southorangecounty', name: 'South Orange County', lifecycle_status: 'onboarding' },
      ],
      lead_notification_global_cc: CC,
      notification_log: [log({ delivery_status: 'bounced', delivery_updated_at: IN_WIN, created_at: OLD })],
    })
    const fetchEvents = vi.fn(async () => ({ events: [], truncated: false }))
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    const mine = out.items.filter(i => i.kind === 'location_untold')
    expect(mine).toHaveLength(1)
    expect(mine[0].text).toContain("Lead email didn't reach South Orange County")
  })
})
