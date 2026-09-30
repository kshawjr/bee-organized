// @vitest-environment node
// Unrouted leads (loc_other) always reach a person — Kevin's two backstops.
//
//   INSTANT (lib/failure-alerts kind 9): a loc_other lead whose alert email did
//   NOT go — nobody on the list, the send failed, the location read failed —
//   pages Kevin, one message per lead. A lead that emailed corporate is
//   corporate's and never pages.
//   DIGEST (lib/webhook-digest): loc_other leads still unrouted a day after
//   arriving make one line; none waiting says nothing.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => ({}) } }))

import {
  selectNewAlerts,
  buildAlertMessages,
  fetchUnroutedUntold,
  type UnroutedUntoldRow,
} from '@/lib/failure-alerts'
import { buildWebhookDigest, UNROUTED_WAIT_MS } from '@/lib/webhook-digest'

const NOW = Date.parse('2026-09-30T18:00:00Z')
const SINCE = NOW - 10 * 60_000
const CUTOFF = NOW - 5 * 60_000
const IN_WIN = new Date(NOW - 7 * 60_000).toISOString()

const select = (unroutedUntold: UnroutedUntoldRow[]) =>
  selectNewAlerts({
    events: [], importFailed: [], mismatches: [], locName: new Map(),
    unroutedUntold, sinceMs: SINCE, cutoffMs: CUTOFF, nowMs: NOW,
  })

describe('instant — an unrouted lead that reached nobody', () => {
  it('nobody on the list → one message naming the lead and the cause', () => {
    const items = select([
      { lead_id: 'l1', lead_name: 'Robin Unrouted', send_status: 'zero_recipients', created_at: IN_WIN },
    ])
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('unrouted_untold')
    const [msg] = buildAlertMessages(items)
    expect(msg.text).toContain(':round_pushpin:')
    expect(msg.text).toContain('Robin Unrouted')
    expect(msg.text).toContain("nobody is on Other's lead-alert list")
    expect(msg.text).toContain('Needs transfer')
  })

  it('a failed send and a failed location read each say so', () => {
    const items = select([
      { lead_id: 'l1', lead_name: 'A', send_status: 'failed', error: 'resend 500', created_at: IN_WIN },
      { lead_id: 'l2', lead_name: 'B', send_status: 'muted', error: 'read_failed: network down', created_at: IN_WIN },
    ])
    expect(items.map(i => i.text).join('\n')).toContain('failed to send (resend 500)')
    expect(items.map(i => i.text).join('\n')).toContain("couldn't read the location")
  })

  it('outside the window → nothing (the watermark already covered it)', () => {
    const old = new Date(SINCE - 60_000).toISOString()
    expect(select([{ lead_id: 'l1', send_status: 'failed', created_at: old }])).toHaveLength(0)
  })
})

// A fake that IGNORES filters, so the fetcher's own row check is what's tested.
const fakeDb = (rows: any[]) => {
  const b: any = {}
  for (const m of ['select', 'eq', 'in', 'gt', 'lte', 'order']) b[m] = () => b
  b.limit = async () => ({ data: rows, error: null })
  return { from: () => b } as any
}

describe('fetchUnroutedUntold', () => {
  it('one row per lead, loc_other email non-sends only', async () => {
    const rows = await fetchUnroutedUntold(fakeDb([
      // a failed send writes one row per address — one lead, one alert
      { lead_id: 'l1', lead_name: 'A', location_slug: 'loc_other', channel: 'email', send_status: 'failed', error: 'x', created_at: IN_WIN },
      { lead_id: 'l1', lead_name: 'A', location_slug: 'loc_other', channel: 'email', send_status: 'failed', error: 'x', created_at: IN_WIN },
      // sent → corporate was told; never an alert
      { lead_id: 'l2', lead_name: 'B', location_slug: 'loc_other', channel: 'email', send_status: 'accepted', created_at: IN_WIN },
      // an owner's Slack failure, even at loc_other → never Kevin's
      { lead_id: 'l3', lead_name: 'C', location_slug: 'loc_other', channel: 'slack', send_status: 'failed', created_at: IN_WIN },
      // a franchise location's muted row → not this rail
      { lead_id: 'l4', lead_name: 'D', location_slug: 'loc_omaha', channel: 'email', send_status: 'muted', created_at: IN_WIN },
    ]), 'since', 'cutoff')
    expect(rows.map(r => r.lead_id)).toEqual(['l1'])
  })
})

describe('digest — unrouted leads waiting over a day', () => {
  const digest = (count: number, oldestCreatedAt: string | null) =>
    buildWebhookDigest({
      events: [], appUrl: 'https://hub.example.com', nowMs: NOW,
      unroutedWaiting: { count, oldestCreatedAt },
    })

  it('waiting leads make one line with the count and the oldest age', () => {
    const d = digest(3, new Date(NOW - 4 * 86_400_000).toISOString())
    expect(d.suppressed).toBe(false)
    expect(d.unroutedWaiting).toBe(3)
    expect(d.headline).toContain('3 unrouted leads waiting over a day')
    expect(d.text).toContain('oldest 4 days')
    expect(d.text).toContain('Needs transfer')
  })

  it('none waiting says nothing — the silence rule holds', () => {
    const d = digest(0, null)
    expect(d.suppressed).toBe(true)
    expect(d.text).toBe('')
  })

  it('the wait is one day', () => {
    expect(UNROUTED_WAIT_MS).toBe(24 * 60 * 60 * 1000)
  })
})
