// @vitest-environment node
//
// TWO OPEN CARDS FOR ONE CLIENT — the flag, "Close as duplicate", and the
// self-close of a hand-made card whose Jobber request was deleted.
// (2026-11-13. Reported by an owner at New Braunfels on 14 Oct 2026.)
//
// What is pinned here, in Kevin's words:
//   · a pair with real work on both cards shows no flag
//   · "Close as duplicate" is refused server-side on a card with any work
//   · the 60-minute join still joins
//   · a hand-made card with a deleted request and nothing on it closes itself
//   · no card is closed, merged or written to by this change outside that
//     self-close (and the one tap itself)
//   · nothing else in the files this touched changed, by fingerprint
//
// Everything runs against real rows in the in-memory table set
// (lib/test-memdb.ts): the real routes, the real Jobber webhook handlers.
// The card's own half is lib/beta-twin-cards-ui.test.tsx.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({
  db: null as any, requests: {} as Record<string, any>, syncLog: [] as any[],
  user: { id: 'owner-1' } as any,
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.db.from(t), rpc: (...a: any[]) => h.db.rpc(...a) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (t: string) => h.db.from(t),
  }),
}))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: async (_loc: string, _q: string, vars: any) => {
    const hit = Object.values(h.requests).find((r: any) => r.id === vars?.id)
    return hit ? { data: { request: hit } } : { data: {} }
  },
  jobberMutation: async () => ({ data: {}, userErrors: undefined }),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: async (row: any) => { h.syncLog.push(row) } }))

import * as handlers from '@/lib/jobber-webhook-handlers'
import { GET } from '@/app/api/engagements/[id]/route'
import { POST as CLOSE_DUPLICATE } from '@/app/api/engagements/[id]/close-duplicate/route'
import { createMemDb } from '@/lib/test-memdb'
import { NOW, T, location, jobberRequest, baseLocations, lead, card, sr, LOC_UUID, OTHER_LOC_UUID, SLUG } from '@/lib/founding-fingerprint.test.harness'
import {
  findTwinCard, twinFlagText, duplicateClosedLine, twinDay,
  DUPLICATE_CARD_REASON, CLOSE_AS_DUPLICATE_ACTION,
} from '@/components/hive/shared/twinCards'
import { closedReasonLabel } from '@/components/hive/shared/engagementStatus'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  ;(globalThis as any).fetch = async () => { throw new Error('network disabled in test') }
})
afterAll(() => { vi.useRealTimers() })

// ── the two cards, as rows ──────────────────────────────────────────────────
// Heather Blue's shape (New Braunfels): card A from our Send on 22 Oct, card B
// from a second Jobber request a day later, and the quote on B.
const DAY = 24 * 60
const OWNER = { id: 'owner-1', role: 'owner', location_id: LOC_UUID }
const quote = (id: string, eng: string, over: any = {}) => ({ id, engagement_id: eng, lead_id: 'lead-pat', location_id: SLUG, jobber_quote_id: `9${id}`, status: 'sent', created_at: T(60), ...over })
const job = (id: string, eng: string, over: any = {}) => ({ id, engagement_id: eng, lead_id: 'lead-pat', location_id: SLUG, jobber_job_id: `8${id}`, status: 'active', created_at: T(30), ...over })
const invoice = (id: string, eng: string, over: any = {}) => ({ id, engagement_id: eng, lead_id: 'lead-pat', location_id: SLUG, jobber_invoice_id: `7${id}`, status: 'sent', total: 500, created_at: T(10), ...over })

function setup(seed: Record<string, any[]> = {}, user: any = OWNER) {
  h.db = createMemDb({
    locations: baseLocations(), leads: [lead()],
    hub_users: [user],
    ...seed,
  })
  h.user = { id: user.id }
  h.requests = {}
  h.syncLog = []
}
const heather = (over: Record<string, any[]> = {}) => ({
  engagements: [
    card('eng-a', { created_at: T(2 * DAY) }),
    card('eng-b', { created_at: T(DAY), stage: 'Estimate' }),
  ],
  service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(2 * DAY) }), sr('sr-b', '6002', 'eng-b', { requested_at: T(DAY) })],
  quotes: [quote('q-b', 'eng-b')],
  ...over,
})
const row = (id: string) => h.db.rows('engagements').find((e: any) => e.id === id)
const writesTo = (t: string) => h.db.writes.filter((w: any) => w.table === t)
const getCard = async (id: string) => {
  const res = await GET(new Request(`http://test/api/engagements/${id}`), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}
const closeDup = async (id: string) => {
  const res = await CLOSE_DUPLICATE(new Request(`http://test/api/engagements/${id}/close-duplicate`, { method: 'POST' }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() }
}

// ── the rule, on its own ────────────────────────────────────────────────────
const C = (id: string, over: any = {}) => ({
  id, client_id: 'c1', title: 'Engagement – Oct 2026', stage: 'Request', founded_by: 'request',
  location_uuid: 'L1', total_invoiced: 0, work: null, first_work_at: null, created_at: '2026-10-22T20:08:00Z', ...over,
})
const A = (over: any = {}) => C('a', over)
const B = (over: any = {}) => C('b', { created_at: '2026-10-23T20:29:00Z', ...over })

describe('the rule — when two cards are a pair', () => {
  it('work on the newer card: the older says the quote is on the other and may be closed; the newer names itself', () => {
    const cards = [A(), B({ stage: 'Estimate', work: 'quote', first_work_at: '2026-10-24T10:00:00Z' })]
    const a = findTwinCard(cards, 'a')!
    expect(a.role).toBe('empty')
    expect(a.canCloseAsDuplicate).toBe(true)
    expect(a.other.id).toBe('b')
    const b = findTwinCard(cards, 'b')!
    expect(b.role).toBe('worked')
    expect(b.canCloseAsDuplicate).toBe(false)
    expect(b.other.id).toBe('a')
  })

  it('work on neither: both are flagged, neither may be closed as a duplicate', () => {
    const cards = [A(), B()]
    for (const id of ['a', 'b']) {
      const t = findTwinCard(cards, id)!
      expect(t.role).toBe('neither')
      expect(t.canCloseAsDuplicate).toBe(false)
    }
  })

  // The Philadelphia Suburbs pair from the scout: two requests 1.1 hours
  // apart, and a quote on each. Two real jobs.
  it('REAL WORK ON BOTH CARDS → no flag on either (the Philadelphia pair, 1.1 hours apart)', () => {
    const cards = [
      A({ created_at: '2026-10-02T14:00:00Z', stage: 'Estimate', work: 'quote', first_work_at: '2026-10-03T09:00:00Z' }),
      B({ created_at: '2026-10-02T15:06:00Z', stage: 'Job in Progress', work: 'job', first_work_at: '2026-10-04T09:00:00Z' }),
    ]
    expect(findTwinCard(cards, 'a')).toBeNull()
    expect(findTwinCard(cards, 'b')).toBeNull()
  })

  it('REPEAT BUSINESS → no flag: the older card already had a quote when the new request arrived', () => {
    const cards = [
      A({ created_at: '2026-06-01T14:00:00Z', stage: 'Job in Progress', work: 'job', first_work_at: '2026-06-03T09:00:00Z' }),
      B({ created_at: '2026-10-23T20:29:00Z' }),
    ]
    expect(findTwinCard(cards, 'a')).toBeNull()
    expect(findTwinCard(cards, 'b')).toBeNull()
  })

  it('the work went onto the OLDER card after the second request arrived → the newer, empty one is the duplicate', () => {
    const cards = [A({ stage: 'Estimate', work: 'quote', first_work_at: '2026-10-25T09:00:00Z' }), B()]
    expect(findTwinCard(cards, 'b')!.role).toBe('empty')
    expect(findTwinCard(cards, 'b')!.canCloseAsDuplicate).toBe(true)
    expect(findTwinCard(cards, 'a')!.role).toBe('worked')
  })

  it('money invoiced counts as work even with no invoice row to show for it', () => {
    const cards = [A({ total_invoiced: 865.2 }), B({ work: 'quote', first_work_at: '2026-10-24T10:00:00Z' })]
    expect(findTwinCard(cards, 'a')).toBeNull()
  })

  it.each([
    ['a single card', [A()]],
    ['the newer card was made by hand, not by a request', [A(), B({ founded_by: 'manual' })]],
    ['the other card is closed', [A(), B({ stage: 'Closed Lost' })]],
    ['the other card is at a different location', [A(), B({ location_uuid: 'L2' })]],
    ['a card with no date', [A(), B({ created_at: null })]],
  ])('no flag: %s', (_label, cards) => {
    expect(findTwinCard(cards as any[], 'a')).toBeNull()
  })

  it('a closed card never shows the flag', () => {
    expect(findTwinCard([A({ stage: 'Closed Lost' }), B()], 'a')).toBeNull()
  })

  it('there is no time limit: 200 days apart is still two open cards', () => {
    const cards = [A({ created_at: '2026-04-01T00:00:00Z' }), B({ work: 'quote', first_work_at: '2026-10-24T10:00:00Z' })]
    expect(findTwinCard(cards, 'a')!.role).toBe('empty')
  })

  it('three cards: the empty one points at the card with the work, not at the other empty one', () => {
    const cards = [A(), B(), C('c', { created_at: '2026-10-24T20:00:00Z', stage: 'Estimate', work: 'quote', first_work_at: '2026-10-25T10:00:00Z' })]
    expect(findTwinCard(cards, 'a')!.other.id).toBe('c')
    expect(findTwinCard(cards, 'b')!.other.id).toBe('c')
  })
})

describe('the words an owner reads', () => {
  const pair = [A(), B({ stage: 'Estimate', work: 'quote', first_work_at: '2026-10-24T10:00:00Z' })]
  it('on the empty card', () => {
    expect(twinFlagText(findTwinCard(pair, 'a'), 'Heather')).toEqual({
      headline: 'Two cards are open for Heather.',
      body: 'The quote is on the other card, opened Oct 23. This card has no quote, job or invoice on it. If they are the same job, close this one as a duplicate. Nothing changes in Jobber.',
    })
  })
  it('on the card with the work', () => {
    expect(twinFlagText(findTwinCard(pair, 'b'), 'Heather')).toEqual({
      headline: 'Two cards are open for Heather.',
      body: 'This is the card with the quote. The other card, opened Oct 22, has no quote, job or invoice on it. If they are the same job, open that card and close it as a duplicate.',
    })
  })
  it('when neither has work yet', () => {
    expect(twinFlagText(findTwinCard([A(), B()], 'a'), 'Heather')).toEqual({
      headline: 'Two cards are open for Heather.',
      body: 'This one, and another opened Oct 23. Neither has a quote or a job yet. When you quote one of them in Jobber, that card fills in and the other can be closed as a duplicate.',
    })
  })
  it('names the furthest record: a job, an invoice', () => {
    const j = [A(), B({ work: 'job', first_work_at: '2026-10-24T10:00:00Z' })]
    expect(twinFlagText(findTwinCard(j, 'a'), 'Katie')!.body).toMatch(/^The job is on the other card/)
    const i = [A(), B({ work: 'invoice', first_work_at: '2026-10-24T10:00:00Z' })]
    expect(twinFlagText(findTwinCard(i, 'b'), 'Katie')!.body).toMatch(/^This is the card with the invoice\./)
  })
  // Seen live on 13 Nov 2026 (San Diego): three requests in three days, none quoted.
  it('three open cards say three, not two', () => {
    const three = [A(), B(), C('c', { created_at: '2026-10-24T20:00:00Z' })]
    for (const id of ['a', 'b', 'c']) {
      expect(twinFlagText(findTwinCard(three, id), 'Brandon')).toEqual({
        headline: 'Three cards are open for Brandon.',
        body: 'This one, and 2 more. None of them has a quote or a job yet. When you quote one of them in Jobber, that card fills in and the others can be closed as duplicates.',
      })
    }
    const quoted = [A(), B(), C('c', { created_at: '2026-10-24T20:00:00Z', stage: 'Estimate', work: 'quote', first_work_at: '2026-10-25T10:00:00Z' })]
    expect(twinFlagText(findTwinCard(quoted, 'a'), 'Brandon')!.body).toMatch(/^The quote is on another card, opened Oct 24\./)
    expect(twinFlagText(findTwinCard(quoted, 'c'), 'Brandon')).toMatchObject({ headline: 'Three cards are open for Brandon.' })
    expect(twinFlagText(findTwinCard(quoted, 'c'), 'Brandon')!.body).toMatch(/^This is the card with the quote\. Another card, opened Oct 2[23], has no quote/)
  })

  it('still reads with no first name on file', () => {
    expect(twinFlagText(findTwinCard(pair, 'a'), '')!.headline).toBe('Two cards are open for this client.')
  })
  it('the close note, the button and the reason label', () => {
    expect(duplicateClosedLine('quote', '2026-10-23T20:29:00Z')).toBe("Closed as a duplicate. The quote is on this client's other card, opened Oct 23, 2026.")
    expect(twinDay('2026-10-23T20:29:00Z')).toBe('Oct 23')
    expect(CLOSE_AS_DUPLICATE_ACTION).toBe('Close as duplicate')
    expect(closedReasonLabel(DUPLICATE_CARD_REASON)).toBe('Duplicate card')
  })
})

// ── what the card is handed ─────────────────────────────────────────────────
describe('GET /api/engagements/:id — the flag rides the card, and reading it writes nothing', () => {
  it('a flagged pair with the work on the newer card', async () => {
    setup(heather())
    const a = await getCard('eng-a')
    expect(a.status).toBe(200)
    expect(a.body.twin).toMatchObject({ role: 'empty', canCloseAsDuplicate: true, otherWork: 'quote', other: { id: 'eng-b', client_id: 'lead-pat', stage: 'Estimate' } })
    const b = await getCard('eng-b')
    expect(b.body.twin).toMatchObject({ role: 'worked', canCloseAsDuplicate: false, thisWork: 'quote', other: { id: 'eng-a' } })
    expect(h.db.writes).toEqual([])
  })

  it('a pair with work on neither', async () => {
    setup(heather({ quotes: [], engagements: [card('eng-a', { created_at: T(2 * DAY) }), card('eng-b', { created_at: T(DAY) })] }))
    expect((await getCard('eng-a')).body.twin).toMatchObject({ role: 'neither', canCloseAsDuplicate: false })
    expect((await getCard('eng-b')).body.twin).toMatchObject({ role: 'neither', canCloseAsDuplicate: false })
    expect(h.db.writes).toEqual([])
  })

  it('REAL WORK ON BOTH → twin is null on both cards', async () => {
    setup(heather({
      engagements: [card('eng-a', { created_at: T(2 * DAY), stage: 'Estimate' }), card('eng-b', { created_at: T(2 * DAY - 66), stage: 'Estimate' })],
      quotes: [quote('q-a', 'eng-a', { created_at: T(DAY) }), quote('q-b', 'eng-b', { created_at: T(DAY - 30) })],
    }))
    expect((await getCard('eng-a')).body.twin).toBeNull()
    expect((await getCard('eng-b')).body.twin).toBeNull()
  })

  it('a single card: twin is null, and the work tables are not even asked', async () => {
    setup({ engagements: [card('eng-a')], service_requests: [sr('sr-a', '6001', 'eng-a')] })
    const seen: string[] = []
    const from = h.db.from
    h.db.from = (t: string) => { seen.push(t); return from(t) }
    expect((await getCard('eng-a')).body.twin).toBeNull()
    // quotes/jobs/invoices are each read ONCE by the card itself; the flag adds none.
    for (const t of ['quotes', 'jobs', 'invoices']) expect(seen.filter(x => x === t)).toHaveLength(1)
  })

  it('a failed read shows no flag rather than taking the card down', async () => {
    setup(heather())
    const from = h.db.from
    let n = 0
    h.db.from = (t: string) => {
      // the card's own sibling read is the first engagements select by client; fail the flag's (the next one)
      if (t === 'quotes' && ++n === 2) return { select: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }
      return from(t)
    }
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await getCard('eng-a')
    errors.mockRestore()
    expect(a.status).toBe(200)
    expect(a.body.twin).toBeNull()
    expect(a.body.engagement.id).toBe('eng-a')
  })
})

// ── the one tap ─────────────────────────────────────────────────────────────
describe('POST /api/engagements/:id/close-duplicate', () => {
  it('closes the empty card with a reason that says what happened — and touches nothing else', async () => {
    setup(heather())
    const otherBefore = JSON.stringify(row('eng-b'))
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(200)
    expect(row('eng-a')).toMatchObject({
      stage: 'Closed Lost', closed_reason: 'duplicate_card',
      closed_note: `Closed as a duplicate. The quote is on this client's other card, opened ${twinDay(T(DAY), true)}.`,
      closed_at: NOW, stage_entered_at: NOW,
    })
    expect(body).toMatchObject({ id: 'eng-a', stage: 'Closed Lost', prev_stage: 'Request', closed_reason: 'duplicate_card', other: { id: 'eng-b' } })
    // the other card: not one byte
    expect(JSON.stringify(row('eng-b'))).toBe(otherBefore)
    // every write this request made: the card itself, and its trail line
    expect(h.db.writes.map((w: any) => `${w.op} ${w.table} ${w.rows.map((r: any) => r.engagement_id || r.id).join(',')}`)).toEqual([
      'update engagements eng-a',
      'insert touchpoints eng-a',
    ])
    // nothing moved: every request and quote is where it was
    expect(h.db.rows('service_requests').map((r: any) => `${r.jobber_request_id}@${r.engagement_id}`).sort()).toEqual(['6001@eng-a', '6002@eng-b'])
    expect(h.db.rows('quotes').map((r: any) => r.engagement_id)).toEqual(['eng-b'])
    expect(h.syncLog).toHaveLength(1)
    expect(h.syncLog[0].message).toContain('reason=duplicate_card')
    expect(h.syncLog[0].message).toContain('duplicate of open card eng-b')
    expect(h.syncLog[0].message).not.toMatch(/Pat|Lee/) // ids only
  })

  it('a second tap is refused and writes nothing more', async () => {
    setup(heather())
    await closeDup('eng-a')
    const writes = h.db.writes.length
    const again = await closeDup('eng-a')
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('already_closed')
    expect(h.db.writes).toHaveLength(writes)
  })

  // A FORGED REQUEST — no button involved. Each of these posts straight at a
  // card that has work on it.
  it.each([
    ['a quote', { quotes: [quote('q-b', 'eng-b'), quote('q-a', 'eng-a')] }],
    ['a draft quote', { quotes: [quote('q-b', 'eng-b'), quote('q-a', 'eng-a', { status: 'draft' })] }],
    ['a job', { jobs: [job('j-a', 'eng-a')] }],
    ['a job deleted in Jobber (the row is still a job)', { jobs: [job('j-a', 'eng-a', { status: 'deleted' })] }],
    ['an invoice', { invoices: [invoice('i-a', 'eng-a')] }],
  ])('REFUSED on a card with %s, whatever the other card holds', async (_label, extra) => {
    setup(heather(extra as any))
    // every row in every table (a table that was only read stays empty)
    const everyRow = () => JSON.stringify(Object.entries(h.db.snapshot()).filter(([, rows]: any) => rows.length > 0))
    const before = everyRow()
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(409)
    expect(body.error).toBe('card_has_work')
    expect(h.db.writes).toEqual([])
    expect(everyRow()).toBe(before)
  })

  it('REFUSED on a card with money invoiced and no invoice row', async () => {
    setup(heather({ engagements: [card('eng-a', { created_at: T(2 * DAY), total_invoiced: 865.2 }), card('eng-b', { created_at: T(DAY), stage: 'Estimate' })] }))
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(409)
    expect(body.error).toBe('card_has_work')
    expect(h.db.writes).toEqual([])
  })

  it('REFUSED on the card that HAS the work (the forged request aimed at the wrong card)', async () => {
    setup(heather())
    const { status, body } = await closeDup('eng-b')
    expect(status).toBe(409)
    expect(body.error).toBe('card_has_work')
    expect(row('eng-b').stage).toBe('Estimate')
    expect(h.db.writes).toEqual([])
  })

  it.each([
    ['there is no other card', { engagements: [card('eng-a')], service_requests: [sr('sr-a', '6001', 'eng-a')], quotes: [] }],
    ['the other card has no work either', { quotes: [], engagements: [card('eng-a', { created_at: T(2 * DAY) }), card('eng-b', { created_at: T(DAY) })] }],
    ['the other card is closed', { engagements: [card('eng-a', { created_at: T(2 * DAY) }), card('eng-b', { created_at: T(DAY), stage: 'Closed Won' })] }],
    ['the other card is at another location', { engagements: [card('eng-a', { created_at: T(2 * DAY) }), card('eng-b', { created_at: T(DAY), stage: 'Estimate', location_uuid: OTHER_LOC_UUID })] }],
    ['the other card already had its quote before this request arrived (repeat business)', {
      engagements: [card('eng-b', { created_at: T(90 * DAY), stage: 'Estimate' }), card('eng-a', { created_at: T(DAY) })],
      quotes: [quote('q-b', 'eng-b', { created_at: T(80 * DAY) })],
    }],
  ])('REFUSED when %s', async (_label, extra) => {
    setup(heather(extra as any))
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(409)
    expect(body.error).toBe('no_other_card_with_work')
    expect(row('eng-a').stage).toBe('Request')
    expect(h.db.writes).toEqual([])
  })

  it('READ-ONLY USERS CLOSE NOTHING: a lite_user is refused, 403', async () => {
    setup(heather(), { id: 'lite-1', role: 'lite_user', location_id: LOC_UUID })
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden_read_only_role')
    expect(row('eng-a').stage).toBe('Request')
    expect(h.db.writes).toEqual([])
  })

  it.each([
    ['paused', { lifecycle_status: 'paused' }],
    ['inactive', { subscription_status: 'inactive' }],
  ])('READ-ONLY LOCATIONS CLOSE NOTHING: an owner at a %s location is refused, 403', async (_label, over) => {
    setup({ ...heather(), locations: [{ ...baseLocations()[0], ...over }] })
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden_read_only_location')
    expect(h.db.writes).toEqual([])
  })

  it('an owner from another location is refused', async () => {
    setup(heather(), { id: 'owner-2', role: 'owner', location_id: OTHER_LOC_UUID })
    const { status, body } = await closeDup('eng-a')
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden_wrong_location')
    expect(h.db.writes).toEqual([])
  })

  it('nobody signed in is refused', async () => {
    setup(heather())
    h.user = null
    expect((await closeDup('eng-a')).status).toBe(401)
    expect(h.db.writes).toEqual([])
  })

  it('a database error while checking for work refuses — it never reads as "no work"', async () => {
    setup(heather())
    const from = h.db.from
    let asked = 0
    // Only the FIRST read of jobs fails (the floor's). Every later read is
    // real, so if the floor shrugged the error off the close would go through.
    h.db.from = (t: string) => (t === 'jobs' && ++asked === 1
      ? { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }
      : from(t))
    const { status } = await closeDup('eng-a')
    expect(status).toBe(500)
    expect(asked).toBe(1)
    expect(row('eng-a').stage).toBe('Request')
    expect(h.db.writes).toEqual([])
  })

  it('the route takes nothing from the browser: it never reads the request body', () => {
    const src = readFileSync('app/api/engagements/[id]/close-duplicate/route.ts', 'utf8')
    expect(src).not.toMatch(/req\.json|_req\.json|request\.json|searchParams/)
  })
})

// ── the self-close ──────────────────────────────────────────────────────────
describe('a hand-made card whose Jobber request is deleted', () => {
  const ctx = (req: string) => ({ topic: 'REQUEST_DESTROY', itemId: req, occurredAt: NOW, location })
  // The New Braunfels card: made by hand, adopted our Send's request, and the
  // owner had logged a reach-out on it before deleting the spare request.
  const handMade = (over: Record<string, any[]> = {}) => ({
    engagements: [card('eng-m', { founded_by: 'manual', created_at: T(36 * DAY) })],
    service_requests: [sr('sr-m', '6001', 'eng-m', { requested_at: T(35 * DAY) })],
    touchpoints: [{ id: 'tp-1', engagement_id: 'eng-m', lead_id: 'lead-pat', kind: 'reach_out', label: 'Reach-out', user_id: 'owner-1', occurred_at: T(34 * DAY) }],
    lead_notes: [{ id: 'n-1', engagement_id: 'eng-m', lead_id: 'lead-pat', kind: 'job', text: 'Called, left a message' }],
    engagement_assignees: [{ engagement_id: 'eng-m', hub_user_id: 'owner-1' }],
    ...over,
  })

  it('with nothing else on it → closes itself, and says why', async () => {
    setup(handMade())
    const res = await handlers.handleRequestDestroy(ctx('6001'))
    expect(res.processed).toBe(true)
    expect(row('eng-m')).toMatchObject({
      stage: 'Closed Lost', closed_reason: 'request_destroyed', closed_at: NOW,
      closed_note: 'The Jobber request on this card was deleted, and nothing else was on it.',
    })
    expect(h.db.rows('service_requests')).toEqual([])
    expect(res.note).toContain('closed empty hand-made engagement eng-m')
  })

  it('what someone had written on it stays: the logged call, the note and who was on it', async () => {
    setup(handMade())
    await handlers.handleRequestDestroy(ctx('6001'))
    expect(h.db.rows('touchpoints').map((t: any) => t.id)).toEqual(['tp-1'])
    expect(h.db.rows('lead_notes').map((n: any) => n.id)).toEqual(['n-1'])
    expect(h.db.rows('engagement_assignees')).toHaveLength(1)
    expect(writesTo('engagements').map((w: any) => w.op)).toEqual(['update']) // closed, never deleted
  })

  it.each([
    ['a quote', { quotes: [quote('q-m', 'eng-m')] }],
    ['a job', { jobs: [job('j-m', 'eng-m')] }],
    ['an invoice', { invoices: [invoice('i-m', 'eng-m')] }],
    ['an assessment booked on the card', { assessments: [{ id: 'as-1', engagement_id: 'eng-m', lead_id: 'lead-pat', service_request_id: null }] }],
    ['a second request', { service_requests: [sr('sr-m', '6001', 'eng-m'), sr('sr-n', '6009', 'eng-m')] }],
  ])('holding %s → left open, exactly as it was', async (_label, extra) => {
    setup(handMade(extra as any))
    const before = JSON.stringify(row('eng-m'))
    const res = await handlers.handleRequestDestroy(ctx('6001'))
    expect(JSON.stringify(row('eng-m'))).toBe(before)
    expect(writesTo('engagements')).toEqual([])
    expect(res.note).toContain('other children remain')
  })

  it('already closed by hand → not touched again', async () => {
    setup(handMade({ engagements: [card('eng-m', { founded_by: 'manual', stage: 'Closed Lost', closed_reason: 'Price too high', closed_at: T(5) })] }))
    await handlers.handleRequestDestroy(ctx('6001'))
    expect(row('eng-m').closed_reason).toBe('Price too high')
    expect(writesTo('engagements')).toEqual([])
  })

  it('a request-founded card closes exactly as it always did (same reason, same note)', async () => {
    setup({ engagements: [card('eng-r')], service_requests: [sr('sr-r', '6001', 'eng-r')] })
    const res = await handlers.handleRequestDestroy(ctx('6001'))
    expect(row('eng-r')).toMatchObject({ stage: 'Closed Lost', closed_reason: 'request_destroyed', closed_note: 'Founding Jobber request was deleted; no other work on this engagement.' })
    expect(res.note).toContain('closed empty engagement eng-r (request_destroyed)')
  })

  it('a request-founded card with only an assessment on it still closes, as before (the stricter test is for hand-made cards only)', async () => {
    setup({ engagements: [card('eng-r')], service_requests: [sr('sr-r', '6001', 'eng-r')], assessments: [{ id: 'as-1', engagement_id: 'eng-r', lead_id: 'lead-pat', service_request_id: null }] })
    await handlers.handleRequestDestroy(ctx('6001'))
    expect(row('eng-r').stage).toBe('Closed Lost')
  })

  it.each(['quote', 'job'])('a %s-founded card is still never closed', async (founder) => {
    setup({ engagements: [card('eng-q', { founded_by: founder })], service_requests: [sr('sr-q', '6001', 'eng-q')] })
    const res = await handlers.handleRequestDestroy(ctx('6001'))
    expect(row('eng-q').stage).toBe('Request')
    expect(res.note).toContain(`founded_by=${founder}`)
  })
})

// ── what did NOT move ───────────────────────────────────────────────────────
describe('the 60-minute join still joins', () => {
  const ctx = (req: string) => ({ topic: 'REQUEST_CREATE', itemId: req, occurredAt: NOW, location })
  it('a second request 3 minutes after the first lands on the first card: one card, two requests, no flag', async () => {
    setup({ engagements: [card('eng-a', { created_at: T(3) })], service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(3), created_at: T(3) })] })
    h.requests = { '6002': jobberRequest('6002', { createdAt: T(0) }) }
    await handlers.handleRequestCreate(ctx('6002'))
    expect(h.db.rows('engagements')).toHaveLength(1)
    expect(h.db.rows('service_requests').map((r: any) => r.engagement_id)).toEqual(['eng-a', 'eng-a'])
    expect((await getCard('eng-a')).body.twin).toBeNull()
  })
  it('26 hours later still founds a second card (nothing is attached automatically) — and now both say so', async () => {
    setup({ engagements: [card('eng-a', { created_at: T(26 * 60) })], service_requests: [sr('sr-a', '6001', 'eng-a', { requested_at: T(26 * 60), created_at: T(26 * 60) })] })
    h.requests = { '6002': jobberRequest('6002', { createdAt: T(0) }) }
    await handlers.handleRequestCreate(ctx('6002'))
    const cards = h.db.rows('engagements')
    expect(cards).toHaveLength(2)
    const second = cards.find((e: any) => e.id !== 'eng-a')
    expect((await getCard('eng-a')).body.twin).toMatchObject({ role: 'neither', other: { id: second.id } })
    expect((await getCard(second.id)).body.twin).toMatchObject({ role: 'neither', other: { id: 'eng-a' } })
  })
})

describe('nothing here closes, merges or writes on its own', () => {
  it('the rule and the reader contain no write of any kind', () => {
    for (const f of ['components/hive/shared/twinCards.js', 'lib/engagement-twins.ts']) {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/\.(update|insert|upsert|delete)\(|fetch\(|rpc\(/)
    }
  })
  it('the only engagement writes in the new route are the one guarded close', () => {
    const src = readFileSync('app/api/engagements/[id]/close-duplicate/route.ts', 'utf8').replace(/\/\/.*$/gm, '')
    expect(src.match(/\.update\(/g)).toHaveLength(1)
    expect(src.match(/\.insert\(/g)).toHaveLength(1) // the stage_change trail line
    expect(src).not.toMatch(/\.(delete|upsert)\(/)
    expect(src).not.toMatch(/from '@\/lib\/jobber|jobberGraphQL|jobberMutation|fetch\(/) // nothing goes to Jobber
    // the close is filtered to this card, and to a card that is still open
    expect(src).toMatch(/\.eq\('id', id\)\s*\.not\('stage', 'in', '\("Closed Won","Closed Lost"\)'\)/)
  })
  it('the card route gained a read and nothing else: no new write', () => {
    const src = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function PATCH'))
    expect(get).not.toMatch(/\.(update|insert|upsert|delete)\(/)
  })
})

// Take my lines back out, put the old ones back, and each file must be, byte
// for byte, the file at fd680ea. Anything else touched in them fails this.
describe('nothing else in the files this touched changed, by fingerprint (against fd680ea)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  const undo = (file: string, steps: [string, string][]) => steps.reduce((s, [now, was]) => {
    expect(s.split(now).length - 1, `${file}: expected exactly once: ${now.slice(0, 60)}…`).toBe(1)
    return s.replace(now, was)
  }, readFileSync(file, 'utf8'))

  it('components/hive/HiveShell.jsx — one prop handed to the card', () => {
    const back = undo('components/hive/HiveShell.jsx', [
      ['          onOpenClient={openClient}\n          onOpenEngagement={openEngagement}\n          onChanged={applyEngagementPatch}\n', '          onOpenClient={openClient}\n          onChanged={applyEngagementPatch}\n'],
      // Network & Nurture slice 9 (2026-11-20), on purpose: the shell hands the
      // Client List the Network gate, so the Nurturing band follows it.
      ['  nurturingMoved = false,\n  onOpenNurturing = null,\n', ''],
      ['          nurturingMoved={nurturingMoved}\n          onOpenNurturing={onOpenNurturing}\n', ''],
    ])
    expect(sha(back)).toBe('71fdb20cd1fc04750cce7f21fe127067ee73b89a3f77877b418c902bd851875c')
  })

  it('components/hive/shared/engagementStatus.js — one label', () => {
    const back = undo('components/hive/shared/engagementStatus.js', [[
      `  // "Close as duplicate" (shared/twinCards.js): an empty card closed because
  // the client's other open card holds the work. Same rule as above — the
  // literal repeats here, display only.
  duplicate_card: 'Duplicate card',
`, ''],
    ])
    expect(sha(back)).toBe('ad9185d2fd359f2928fdf0d4349b480aa870f2c06119f184754cb427b530939f')
  })

  it('components/hive/shared/ClosedSummary.jsx — the duplicate note reads in full', () => {
    const back = undo('components/hive/shared/ClosedSummary.jsx', [[
      `  // A card closed as a duplicate (shared/twinCards.js): its note is the
  // whole account of where the work went, so it reads in full too.
  const fullNote = overBalance || writtenOff || e.closed_reason === 'duplicate_card'
`, '  const fullNote = overBalance || writtenOff\n'],
    ])
    expect(sha(back)).toBe('65770f75eea990a17266f6631df528d4aaf7dcd07d48e1132b8b19c2e3ed0b32')
  })

  it('app/api/engagements/[id]/route.ts — the GET gained `twin`; PATCH is untouched', () => {
    const back = undo('app/api/engagements/[id]/route.ts', [
      ["import { loadTwinForEngagement } from '@/lib/engagement-twins'\n", ''],
      [`//   the panel's "Also on this client" block — all from ONE sibling query),
//   + \`twin\`: the two-open-cards flag (lib/engagement-twins.ts), null on
//   almost every card. Fetched by EngagementPanel on open so the`, `//   the panel's "Also on this client" block — all from ONE sibling query). Fetched by EngagementPanel on open so the`],
      [`  // TWO OPEN CARDS FOR ONE CLIENT (components/hive/shared/twinCards.js). Only
  // asked when this card is open and the client has another open card — the
  // sibling query above already knows — so an ordinary card costs nothing
  // extra. Display only and fail-soft: a failed read shows no flag rather
  // than taking the card down. Nothing here writes.
  let twin: Awaited<ReturnType<typeof loadTwinForEngagement>> = null
  if (otherOpen > 0 && isOpen(engagementOut.stage)) {
    try {
      twin = await loadTwinForEngagement({ id, client_id: engagement.client_id, stage: engagementOut.stage })
    } catch (err) {
      console.error('[engagements GET] twin-card read failed (card still served)', { id, err })
    }
  }

`, ''],
      ['    drip,\n    twin,\n    client: {', '    drip,\n    client: {'],
    ])
    expect(sha(back)).toBe('4fe688649c84e10b8c77935e7ca425320568c0a7d54f160ae8a676d7faadb3ef')
  })

  it('lib/jobber-webhook-handlers.ts — four hunks, all inside the deleted-request tidy', () => {
    const back = undo('lib/jobber-webhook-handlers.ts', [
      [`//   • Only an engagement left with nothing is closed, and it is SOFT-closed
//     (Closed Lost / closed_reason='request_destroyed'), never deleted — the
//     engagement's assignee join is ON DELETE CASCADE, so a delete would
//     erase the crew (the #66 trap). Engagements still holding other children
//     are left exactly as-is, stage untouched.
//   • A HAND-MADE card (founded_by='manual') closes the same way since
//     2026-11-13, but on a stricter test: it must hold NOTHING — no other
//     request, no quote, job or invoice, and no assessment. Until then it was
//     always left open, which is how an owner at New Braunfels deleted the
//     spare request in Jobber on 14 Oct 2026 (the right repair) and still had
//     an empty card on her board: her card had begun life hand-made and
//     adopted the request (#67). Notes and logged calls do not hold a card
//     open — hers had a logged reach-out — and they stay on the closed card,
//     which Reopen brings back. Quote- and job-founded engagements keep their
//     own meaning and are still left.
`, `//   • Only a request-founded engagement left with nothing is closed, and it
//     is SOFT-closed (Closed Lost / closed_reason='request_destroyed'),
//     never deleted — the engagement's assignee join is ON DELETE CASCADE, so
//     a delete would erase the crew (the #66 trap). Manual containers
//     (founded_by='manual') and engagements still holding other children are
//     left exactly as-is, stage untouched.
`],
      [`  // Only an engagement this request FOUNDED, or a hand-made card that had
  // adopted it, is a candidate to close. A quote/job-founded engagement keeps
  // its own meaning even with this SR gone.
  const handMade = eng.founded_by === 'manual'
  if (eng.founded_by !== 'request' && !handMade) {
`, `  // Only an engagement this request FOUNDED is a candidate to close. A manual
  // container (or a quote/job-founded engagement) keeps its own meaning even
  // with this SR gone.
  if (eng.founded_by !== 'request') {
`],
      [`    (await anyRows('invoices', 'engagement_id', engId)) ||
    // A hand-made card is closed only when it holds nothing at all, so an
    // assessment still on it (booked on the card, not on this request) keeps
    // it open. Request-founded cards are judged exactly as before.
    (handMade && (await anyRows('assessments', 'engagement_id', engId)))
  if (stillHasChildren) {`, `    (await anyRows('invoices', 'engagement_id', engId))
  if (stillHasChildren) {`],
      [`      closed_note: handMade
        ? 'The Jobber request on this card was deleted, and nothing else was on it.'
        : 'Founding Jobber request was deleted; no other work on this engagement.',`, `      closed_note: 'Founding Jobber request was deleted; no other work on this engagement.',`],
      [`  return handMade
    ? \`REQUEST_DESTROY: deleted stale SR \${sr.id}; closed empty hand-made engagement \${engId} (request_destroyed)\`
    : \`REQUEST_DESTROY: deleted stale SR \${sr.id}; closed empty engagement \${engId} (request_destroyed)\``, `  return \`REQUEST_DESTROY: deleted stale SR \${sr.id}; closed empty engagement \${engId} (request_destroyed)\``],
    ])
    expect(sha(back)).toBe('4252fc55e6b33424cfb62f03a8a7fbfa9db022d0dc6701114c68eca69e528208')
  })
})
