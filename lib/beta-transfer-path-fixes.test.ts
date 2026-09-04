// @vitest-environment node
//
// FIX 1 of the transfer path — the auto-close clock. (Fixes 2 and 3, and the
// "an ordinary transfer is unchanged" regression, are route behaviour and live
// in lib/beta-lead-transfer-endpoint.test.ts alongside the existing harness.)
//
//   1. THE CLOCK. A transferred lead's 35-day auto-close runs from the
//      TRANSFER, not the original enquiry. The transfer is activity on the
//      clock — it is deliberately NOT an enquiry exit and NOT a new enquiry
//      date, so lib/enquiry-exit (the Inbox rule) is unchanged by it. The
//      last test in that block pins exactly that: same facts, same
//      enquiryState.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── 1. THE CLOCK — findStaleEnquiries against a table-driven fake ──

const db = vi.hoisted(() => ({
  leads: [] as any[],
  touchpoints: [] as any[],
  locations: [] as any[],
}))

vi.mock('@/lib/supabase-service', () => {
  // Minimal PostgREST-shaped fake: records the filters a chain applies, then
  // resolves by applying them to the in-memory table.
  const build = (table: string) => {
    const f: any = { eq: {}, in: {}, like: null, is: {} }
    const b: any = {}
    b.select = () => b
    b.eq = (c: string, v: any) => { f.eq[c] = v; return b }
    b.in = (c: string, v: any[]) => { f.in[c] = v; return b }
    b.is = (c: string, v: any) => { f.is[c] = v; return b }
    b.lte = (c: string, v: any) => { f.lte = [c, v]; return b }
    b.like = (c: string, v: string) => { f.like = [c, v]; return b }
    b.range = () => b
    b.order = () => b
    b.limit = () => b
    const rows = () => {
      let out = [...((db as any)[table] ?? [])]
      for (const [c, v] of Object.entries(f.eq)) out = out.filter(r => r[c] === v)
      for (const [c, v] of Object.entries(f.in)) out = out.filter(r => (v as any[]).includes(r[c]))
      for (const [c, v] of Object.entries(f.is)) out = out.filter(r => (r[c] ?? null) === v)
      if (f.lte) out = out.filter(r => new Date(r[f.lte[0]]) <= new Date(f.lte[1]))
      if (f.like) {
        const pre = String(f.like[1]).replace(/%$/, '')
        out = out.filter(r => String(r[f.like[0]] ?? '').startsWith(pre))
      }
      return out
    }
    b.then = (res: any, rej: any) => Promise.resolve({ data: rows(), error: null }).then(res, rej)
    b.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null })
    b.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null })
    return b
  }
  return { supabaseService: { from: (t: string) => build(t) } }
})
vi.mock('@/lib/drip-lifecycle', () => ({
  stopActiveDripsForLead: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/stage-emails', () => ({ cancelStageEmails: vi.fn(async () => {}) }))
vi.mock('@/lib/welcome-email', () => ({ cancelPendingWelcomeEmail: vi.fn(async () => {}) }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { findStaleEnquiries, AUTO_CLOSE_DAYS, TRANSFER_LABEL } from '@/lib/auto-close'
import { enquiryState, TRANSFER_IN_LABEL } from '@/lib/enquiry-exit'

const NOW = new Date('2026-09-04T06:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString()

const seedLead = (over: any = {}) => {
  db.locations.push({ id: 'dest-uuid', lifecycle_status: 'active', subscription_status: 'active' })
  db.leads.push({
    id: 'lead-1',
    name: 'Routed Person',
    location_id: 'loc_siouxfalls',
    location_uuid: 'dest-uuid',
    created_at: daysAgo(40),          // enquiry well past the 35-day line
    import_source: 'manual',
    is_junk: false,
    archived_at: null,
    jobber_request_id: null,
    jobber_job_id: null,
    email: 'routed@example.com',
    phone: '5555550100',
    ...over,
  })
}

beforeEach(() => {
  db.leads = []; db.touchpoints = []; db.locations = []
  vi.clearAllMocks()
})

describe('fix 1 — the 35-day clock runs from the transfer', () => {
  it('an enquiry 40 days old with NO transfer still closes', async () => {
    seedLead()
    const scan = await findStaleEnquiries({ now: NOW })
    expect(scan.toClose.map(t => t.leadId)).toEqual(['lead-1'])
  })

  it('the SAME enquiry transferred 2 days ago is spared — the clock restarted', async () => {
    seedLead()
    db.touchpoints.push({
      lead_id: 'lead-1', kind: 'system', label: TRANSFER_LABEL, occurred_at: daysAgo(2),
    })
    const scan = await findStaleEnquiries({ now: NOW })
    expect(scan.toClose).toEqual([])
    const spared = scan.spared.find(s => s.leadId === 'lead-1')
    expect(spared?.reason).toBe('transferred_recent')
    // the clock, not the enquiry date: enquiry stays where it was
    expect(spared?.enquiryAt).toBe(daysAgo(40))
    expect(spared?.lastActivityAt).toBe(daysAgo(2))
    expect(spared?.ageDays).toBe(2)
  })

  it('the day-34 transfer no longer closes the next night', async () => {
    // Enquiry 36 days ago, routed on its day 34 → 2 days at the new owner.
    seedLead({ created_at: daysAgo(36) })
    db.touchpoints.push({
      lead_id: 'lead-1', kind: 'system', label: TRANSFER_LABEL, occurred_at: daysAgo(2),
    })
    const scan = await findStaleEnquiries({ now: NOW })
    expect(scan.toClose).toEqual([])
  })

  it('a transfer OLDER than 35 days does not spare it forever', async () => {
    seedLead({ created_at: daysAgo(90) })
    db.touchpoints.push({
      lead_id: 'lead-1', kind: 'system', label: TRANSFER_LABEL, occurred_at: daysAgo(50),
    })
    const scan = await findStaleEnquiries({ now: NOW })
    expect(scan.toClose.map(t => t.leadId)).toEqual(['lead-1'])
    expect(scan.toClose[0].ageDays).toBe(50)
  })

  it('the transfer is NOT an exit and NOT a new enquiry date — the Inbox rule is unmoved', async () => {
    const facts = {
      createdAt: daysAgo(40),
      importSource: 'manual',
      resubmissionAts: [],
      reachOutAts: [],
      jobberWorkAts: [],
      networkMoved: false,
      closedAts: [],
      email: 'routed@example.com',
      phone: '5555550100',
    }
    // enquiryState takes no transfer input at all; the transfer touchpoint is
    // invisible to it by construction. Same facts in, same answer out.
    const before = enquiryState(facts)
    expect(before.exit).toBeNull()
    expect(before.open).toBe(true)
    expect(before.inbox).toBe(true)
    expect(before.enquiryAt).toBe(new Date(daysAgo(40)).getTime())
    // and the writer's label is the reader's label
    expect(TRANSFER_LABEL).toBe(TRANSFER_IN_LABEL)
  })

  it('AUTO_CLOSE_DAYS is still 35 — the fix moved the start, not the length', () => {
    expect(AUTO_CLOSE_DAYS).toBe(35)
  })
})
