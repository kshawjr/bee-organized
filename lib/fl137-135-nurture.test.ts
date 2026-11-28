// FL-137 + FL-135 (Kevin, 2026-11-28): when people join Nurturing and
// Mailchimp. One test (or more) per pin Kevin asked for:
//   1. A ticked close puts someone in Nurturing immediately
//   2. An unticked close keeps them out for good, catch-all included
//   3. No box on Junk Lead or Duplicate
//   4. Closed Won never reaches Nurturing by any route
//   5. Adding from the Nurturing tab does not create an Inbox item and cannot be auto-closed
//   6. A Mailchimp add is refused while a signup flow is live, one person or many
//   8. Nothing already closed lost moves because of this change
// (Pin 7, the Clients "Nurturing" group agreeing with the tab, is not built:
// it was sized first and stopped for Kevin — 506 people differ.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ writes: [] as Array<{ table: string; patch: any; filters: any[] }>, tables: {} as Record<string, any[]> }))
vi.mock('./supabase-service', () => {
  const from = (table: string) => {
    const filters: any[] = []
    let op = 'select', patch: any = null, head = false
    const rows = () => (h.tables[table] || []).filter((r) => filters.every(([k, col, val]) =>
      k === 'eq' ? r[col] === val : k === 'in' ? (val as any[]).includes(r[col]) : k === 'is' ? (r[col] ?? null) === val : true))
    const q: any = {
      select: (_c?: string, o?: any) => { if (o?.head) head = true; return q },
      eq: (c: string, v: any) => { filters.push(['eq', c, v]); return q },
      in: (c: string, v: any[]) => { filters.push(['in', c, v]); return q },
      is: (c: string, v: any) => { filters.push(['is', c, v]); return q },
      not: () => q, order: () => q, limit: () => q, like: () => q, range: () => q,
      update: (p: any) => { op = 'update'; patch = p; return q },
      maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
      then: (ok: any, bad: any) => {
        if (op === 'update') { h.writes.push({ table, patch, filters: [...filters] }); return Promise.resolve({ data: null, error: null }).then(ok, bad) }
        if (head) return Promise.resolve({ count: rows().length, error: null }).then(ok, bad)
        return Promise.resolve({ data: rows(), error: null }).then(ok, bad)
      },
    }
    return q
  }
  return { supabaseService: { from, rpc: async () => ({ data: false, error: null }) } }
})

import { nurturingVerdict, foldActivity, nurturingSql, type NurtureLead } from './network/nurturing'
import { nurtureBoxShows, NURTURING_ADD_SOURCE } from '@/components/hive/shared/nurtureBox'
import { saveCloseBox, saveAutoCloseChoice } from './nurture-choice'
import { addOneLeadToMailchimp } from './mailchimp-sync'
import { planAdd, newNurtureRow } from './network/nurturing-add'
import { enquiryState, factsFromRows } from './enquiry-exit'
import { pastClientCheck } from './drip-lifecycle'

const TEST_LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'   // Mailchimp open
const OTHER_LOC = 'e7b05e53-7bd7-48de-a13b-10018c8b1b08'  // Mailchimp coming soon
const NOW = new Date('2026-11-28T12:00:00Z')
const DAY = 86400e3
const ago = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString()
const lead = (x: Partial<NurtureLead> = {}): NurtureLead => ({ id: 'L1', created_at: ago(400), location_id: 'loc_x', ...x })
const fold = (o: { quoteDaysAgo?: number; job?: boolean; won?: boolean; open?: boolean; lost?: boolean } = {}) => foldActivity(
  [], o.quoteDaysAgo != null ? [{ lead_id: 'L1', status: 'sent', sent_at: ago(o.quoteDaysAgo) }] : [],
  o.job ? [{ lead_id: 'L1', status: 'active' }] : [],
  [...(o.won ? [{ client_id: 'L1', closed_at: ago(10), stage: 'Closed Won' }] : []), ...(o.open ? [{ client_id: 'L1', closed_at: null, stage: 'Request' }] : []), ...(o.lost ? [{ client_id: 'L1', closed_at: ago(1), stage: 'Closed Lost' }] : [])],
)
const v = (l: NurtureLead, f = fold()) => nurturingVerdict(l, f, NOW)

beforeEach(() => { h.writes.length = 0; h.tables = {} })

describe('1. a ticked close puts someone in Nurturing immediately', () => {
  it('in today, though added yesterday, quoted last week, with a job and a payment (a write-off)', () => {
    const l = lead({ created_at: ago(1), paid_amount: 500, nurture_choice: 'in' })
    expect(v(l, fold({ quoteDaysAgo: 7, job: true, lost: true }))).toMatchObject({ nurturing: true, chosen: true })
    // Without the choice the catch-all would keep them out on every one of those.
    expect(v({ ...l, nurture_choice: null }, fold({ quoteDaysAgo: 7, job: true, lost: true })).nurturing).toBe(false)
  })
  it('the box ticked saves Nurturing "in" — and Mailchimp "in" where Mailchimp is open', async () => {
    const r = await saveCloseBox({ leadId: 'L1', locationUuid: TEST_LOC, reason: 'Price too high', ticked: true, by: 'u1' })
    expect(r).toMatchObject({ nurture: 'in', mailchimp: 'in', saved: true })
    expect(h.writes.map((w) => w.patch)).toEqual([
      expect.objectContaining({ nurture_choice: 'in', nurture_choice_how: 'closed_lost', nurture_choice_by: 'u1' }),
      expect.objectContaining({ mailchimp_choice: 'in', mailchimp_choice_how: 'closed_lost', mailchimp_choice_by: 'u1' }),
    ])
  })
  it('where Mailchimp is coming soon, the box decides Nurturing only (nothing is saved for Mailchimp)', async () => {
    const r = await saveCloseBox({ leadId: 'L1', locationUuid: OTHER_LOC, reason: 'Price too high', ticked: true, by: 'u1' })
    expect(r).toMatchObject({ nurture: 'in', mailchimp: null })
    expect(h.writes).toHaveLength(1)
  })
  it('the SQL lets an owner\'s "in" past the catch-all', () => {
    expect(nurturingSql()).toContain("and (l.nurture_choice = 'in' or (")
  })
})

describe('2. an unticked close keeps them out for good, catch-all included', () => {
  it('out, though the catch-all says in (old, quiet, never a job)', () => {
    expect(v(lead())).toMatchObject({ nurturing: true })
    expect(v(lead({ nurture_choice: 'out' }))).toMatchObject({ nurturing: false, why: 'owner_said_no' })
    // …and years later, still out.
    expect(nurturingVerdict(lead({ nurture_choice: 'out' }), fold(), new Date('2031-01-01T00:00:00Z')).nurturing).toBe(false)
  })
  it('the box left unticked is an answer: Nurturing "out" and Mailchimp "out"', async () => {
    const r = await saveCloseBox({ leadId: 'L1', locationUuid: TEST_LOC, reason: 'No response', ticked: false, by: 'u1' })
    expect(r).toMatchObject({ nurture: 'out', mailchimp: 'out' })
    expect(h.writes.map((w) => w.patch.nurture_choice ?? w.patch.mailchimp_choice)).toEqual(['out', 'out'])
  })
  it('the SQL keeps an "out" out', () => {
    expect(nurturingSql()).toContain("and l.nurture_choice is distinct from 'out'")
  })
})

describe('3. no box on Junk Lead or Duplicate', () => {
  it.each(['Junk Lead', 'junk lead', 'duplicate', 'Duplicate', 'duplicate_card'])('no box for "%s", and nothing is saved even if an answer is sent', async (reason) => {
    expect(nurtureBoxShows(reason)).toBe(false)
    expect(await saveCloseBox({ leadId: 'L1', locationUuid: TEST_LOC, reason, ticked: true, by: 'u1' })).toBeNull()
    expect(h.writes).toEqual([])
  })
  it.each(['Price too high', 'No response', 'Could not reach', 'Went with competitor', 'We declined the job', 'Other', 'written_off'])('every other reason has the box — "%s" (write-offs too)', (reason) => {
    expect(nurtureBoxShows(reason)).toBe(true)
  })
  it('a close with no answer sent saves nothing: the catch-all decides, as before', async () => {
    expect(await saveCloseBox({ leadId: 'L1', locationUuid: TEST_LOC, reason: 'No response', ticked: undefined, by: 'u1' })).toBeNull()
    expect(h.writes).toEqual([])
  })
})

describe('4. Closed Won never reaches Nurturing, by any route', () => {
  it('a won card keeps them out — even with the owner\'s "in"', () => {
    expect(v(lead({ nurture_choice: 'in' }), fold({ won: true }))).toMatchObject({ nurturing: false, why: 'won' })
    expect(v(lead(), fold({ won: true }))).toMatchObject({ nurturing: false, why: 'won' })
  })
  it('in the SQL the won check stands outside the "in" door', () => {
    const s = nurturingSql()
    const won = s.indexOf("e.stage = 'Closed Won'"), door = s.indexOf("l.nurture_choice = 'in'")
    expect(won).toBeGreaterThan(0)
    expect(won).toBeLessThan(door)
    expect(s.slice(s.indexOf('and (l.nurture_choice'))).not.toContain('Closed Won')
  })
  it('a Won close never carries the box (only Lost and write-off send it)', () => {
    const src = readFileSync('components/hive/shared/closeEngagement.js', 'utf8')
    expect(src).toContain("if (closeAs !== CLOSED_WON && typeof nurture === 'boolean') body.nurture = nurture")
    const route = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    expect(route).toContain("if (stageChanged && patch.stage === 'Closed Lost') {\n    box = await saveCloseBox(")
  })
})

describe('5. adding from the Nurturing tab: no Inbox item, never auto-closed', () => {
  const loc = { id: TEST_LOC, slug: 'loc_test' }
  const plan = planAdd({ firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '', sendMailchimp: false, sendWelcome: false }, loc)
  const row = newNurtureRow(plan as any, loc, 'u1', NOW.toISOString())
  it('the record is in Nurturing from the first second, by the owner\'s choice', () => {
    expect(row).toMatchObject({ import_source: NURTURING_ADD_SOURCE, nurture_choice: 'in', nurture_choice_how: 'nurturing_add', nurture_choice_by: 'u1' })
    expect(v({ id: 'L1', created_at: NOW.toISOString(), location_id: 'loc_test', nurture_choice: 'in' })).toMatchObject({ nurturing: true })
    expect(row).not.toHaveProperty('mailchimp_choice') // its box was left unticked
  })
  it('it is not an enquiry: not open, not in the Inbox', () => {
    const st = enquiryState(factsFromRows({ lead: row as any }))
    expect(st).toMatchObject({ isEnquiry: false, open: false, inbox: false })
    // The same person typed in as an enquiry would be.
    expect(enquiryState(factsFromRows({ lead: { ...row, import_source: 'manual' } as any }))).toMatchObject({ open: true, inbox: true })
  })
  it('the auto-close only ever reads enquiries (import_source manual), so it never sees them', () => {
    const src = readFileSync('lib/auto-close.ts', 'utf8')
    expect(src).toContain(".eq('import_source', 'manual')")
  })
  it('the welcome email can greet them: they are not taken for a past client', async () => {
    expect(await pastClientCheck('L1', { import_source: NURTURING_ADD_SOURCE, paid_amount: 0 })).toEqual({ past: false, failed: false })
    expect((await pastClientCheck('L1', { import_source: 'jobber', paid_amount: 0 })).past).toBe(true)
  })
  it('both boxes start unticked, and the route sends nothing but the two it was asked for', () => {
    const dlg = readFileSync('components/network/NurtureAddDialog.jsx', 'utf8')
    expect(dlg).toContain('const [sendMailchimp, setSendMailchimp] = useState(false)')
    expect(dlg).toContain('const [sendWelcome, setSendWelcome] = useState(false)')
    const route = readFileSync('app/api/network/nurturing/add/route.ts', 'utf8')
    const imports = route.split('\n').filter((l) => l.startsWith('import ')).join('\n')
    for (const sender of ['slack', 'lead-alert', 'drip', 'jobber', 'resend', 'notif']) expect(imports.toLowerCase()).not.toContain(sender)
    expect(route).toContain('const welcome = plan.welcome ? await scheduleWelcomeEmail(')
    expect(route).toContain('const mc = plan.mailchimp ? await sendChosenToMailchimp(')
  })
  it('a Mailchimp tick sent from a location where Mailchimp is coming soon is ignored', () => {
    const p = planAdd({ firstName: 'Pat', email: 'pat@example.com', sendMailchimp: true }, { id: OTHER_LOC, slug: 'loc_chattanooga' })
    expect(p).toMatchObject({ ok: true, mailchimp: false })
  })
})

// ── 6. the one-person Mailchimp add ──────────────────────────
const flows = (o: { live?: string[]; unreadable?: boolean } = {}) => async () => (o.unreadable ? { ok: false } : {
  ok: true, mustPause: (o.live || []).map((name) => ({ name, status: 'sending', live: true, start: 'signup', startWords: 'when someone signs up' })),
  tagFlows: [], kevinConditional: [], signupFlows: [], fingerprint: `f:${(o.live || []).join(',')}`,
}) as any
function world(leadOver: Record<string, any> = {}) {
  h.tables = {
    leads: [{ id: 'L1', email: 'pat@example.com', first_name: 'Pat', last_name: 'Lee', location_uuid: TEST_LOC, location_id: 'loc_test', is_junk: false, archived_at: null,
      marketing_opt_out: false, marketing_unsubscribed_at: null, mailchimp_choice: 'in', import_source: 'manual', created_at: ago(40), jobber_request_id: '123', ...leadOver }],
    locations: [{ id: TEST_LOC, location_id: 'loc_test', mailchimp_connected: true, mailchimp_access_token: 'tok-abcdefghijklmnop', mailchimp_server_prefix: 'us1', mailchimp_list_id: 'aud1', mailchimp_sync_live: true, mailchimp_first_sync_at: ago(1) }],
    marketing_unsubscribes: [], mailchimp_refusals: [], engagements: [], touchpoints: [], lead_tags: [], service_requests: [], quotes: [], jobs: [], partners: [],
  }
}
const mc = () => {
  const calls: Array<{ url: string; method: string }> = []
  const f = async (url: string, init: any) => {
    calls.push({ url, method: init.method })
    if (init.method === 'GET') return { status: 404, text: async () => '{}', headers: { get: () => null } }
    return { status: 200, text: async () => JSON.stringify({ new_members: [{ email_address: 'pat@example.com' }], errors: [] }), headers: { get: () => null } }
  }
  return { calls, f, posts: () => calls.filter((c) => c.method === 'POST') }
}
const deps = (m: ReturnType<typeof mc>, fl = flows()) => ({ fetchImpl: m.f as any, readFlowsImpl: fl, loadSuppressed: async () => new Set<string>(), sleep: async () => {}, now: () => NOW.getTime() })

describe('6. a Mailchimp add is refused while a sign-up flow is live, one person or many', () => {
  it('everything clear → one add, update_existing false', async () => {
    world(); const m = mc()
    const r = await addOneLeadToMailchimp('L1', deps(m))
    expect(r).toMatchObject({ sent: true, outcome: 'added' })
    expect(m.posts()).toHaveLength(1)
  })
  it('one person, a welcome journey live → refused, nothing sent to Mailchimp', async () => {
    world(); const m = mc()
    const r = await addOneLeadToMailchimp('L1', deps(m, flows({ live: ['Welcome new subscribers'] })))
    expect(r).toMatchObject({ sent: false, outcome: 'signup_flows_live', flows: ['Welcome new subscribers'] })
    expect(m.posts()).toEqual([])
  })
  it('the flows cannot be read → refused ("couldn\'t check" is never "nothing live")', async () => {
    world(); const m = mc()
    expect(await addOneLeadToMailchimp('L1', deps(m, flows({ unreadable: true })))).toMatchObject({ outcome: 'mailchimp_unreadable' })
    expect(m.posts()).toEqual([]) // (2026-11-28) the only call is the read asking if they are already there
  })
  it('(fix, 2026-11-28 — Sophie Stephens) already in Mailchimp while a journey is live → "already there", never "refused"', async () => {
    world(); const m = mc()
    const f = async (url: string, init: any) => { m.calls.push({ url, method: init.method }); return { status: 200, text: async () => '{"status":"subscribed"}', headers: { get: () => null } } }
    let flowsRead = 0
    const fl = async () => { flowsRead++; return (await flows({ live: ['Welcome new subscribers'] })()) }
    expect(await addOneLeadToMailchimp('L1', { ...deps(m, fl as any), fetchImpl: f as any })).toMatchObject({ sent: false, outcome: 'already_there' })
    expect(flowsRead).toBe(0)
    expect(m.posts()).toEqual([])
  })
  it('the batch refuses for the same reason (its own pin, re-checked here)', () => {
    const src = readFileSync('lib/mailchimp-sync.ts', 'utf8')
    expect(src).toContain("return refuse('signup_flows_live', { mustPause: flows.mustPause.map(flowLine), howToPause: HOW_TO_PAUSE })")
    expect(src).toContain("if (flows.mustPause.length) return out('signup_flows_live', { flows: flows.mustPause.map((f) => f.name) })")
  })
  it('nobody goes without an owner\'s "in"; never while still a request; never where Mailchimp is coming soon', async () => {
    world({ mailchimp_choice: null }); let m = mc()
    expect(await addOneLeadToMailchimp('L1', deps(m))).toMatchObject({ outcome: 'not_chosen' })
    world({ jobber_request_id: null }); m = mc()
    expect(await addOneLeadToMailchimp('L1', deps(m))).toMatchObject({ outcome: 'still_an_enquiry' })
    world({ location_uuid: OTHER_LOC }); m = mc()
    expect(await addOneLeadToMailchimp('L1', deps(m))).toMatchObject({ outcome: 'not_open' })
    expect(m.posts()).toEqual([])
  })
  it('already in Mailchimp (any status) → left exactly as they were', async () => {
    world(); const m = mc()
    const f = async (url: string, init: any) => { m.calls.push({ url, method: init.method }); return { status: 200, text: async () => '{"status":"unsubscribed"}', headers: { get: () => null } } }
    expect(await addOneLeadToMailchimp('L1', { ...deps(m), fetchImpl: f as any })).toMatchObject({ outcome: 'already_there' })
    expect(m.posts()).toEqual([])
  })
  it('said no to marketing → refused', async () => {
    world({ marketing_opt_out: true }); const m = mc()
    expect(await addOneLeadToMailchimp('L1', deps(m))).toMatchObject({ outcome: 'said_no' })
    expect(m.calls).toEqual([])
  })
})

describe('the 35-day auto-close adds to both', () => {
  it('Nurturing "in" always; Mailchimp "in" where Mailchimp is open', async () => {
    expect(await saveAutoCloseChoice('L1', TEST_LOC, { now: () => NOW.getTime() })).toEqual({ mailchimp: true })
    expect(h.writes.map((w) => w.patch)).toEqual([
      expect.objectContaining({ nurture_choice: 'in', nurture_choice_how: 'auto_close', nurture_choice_by: null }),
      expect.objectContaining({ mailchimp_choice: 'in', mailchimp_choice_how: 'auto_close', mailchimp_choice_by: null }),
    ])
    h.writes.length = 0
    expect(await saveAutoCloseChoice('L1', OTHER_LOC)).toEqual({ mailchimp: false })
    expect(h.writes).toHaveLength(1)
  })
  it('the cron sends to Mailchimp only after a real close, never on a dry run', () => {
    const src = readFileSync('app/api/cron/auto-close/route.ts', 'utf8')
    expect(src.indexOf('sendChosenToMailchimp(item.leadId')).toBeGreaterThan(src.indexOf('if (dryRun) {'))
    expect(src).toContain('if (r.mailchimpChosen) {')
  })
})

describe('8. nothing already closed lost moves because of this change', () => {
  // The rule as it was on main (6622909), for someone with no choice.
  const before = (l: NurtureLead, o: Parameters<typeof fold>[0]) => {
    if (l.archived_at || l.is_junk) return false
    if (new Date(l.created_at!).getTime() >= NOW.getTime() - 30 * DAY) return false
    if (o?.job) return false
    if ((Number(l.paid_amount) || 0) > 0 || l.invoice_paid_at || o?.won) return false
    if (o?.open) return false
    if (o?.quoteDaysAgo != null && o.quoteDaysAgo <= 90) return false
    return true
  }
  it('with no choice, every combination gets the same answer as before', () => {
    let n = 0
    for (const created of [5, 29, 31, 400]) for (const quoteDaysAgo of [undefined, 10, 89, 91, 300]) for (const job of [false, true])
      for (const won of [false, true]) for (const open of [false, true]) for (const lost of [false, true]) for (const paid of [0, 50]) for (const archived of [false, true]) {
        const l = lead({ created_at: ago(created), paid_amount: paid, archived_at: archived ? ago(1) : null })
        const o = { quoteDaysAgo, job, won, open, lost }
        expect(v(l, fold(o)).nurturing, JSON.stringify({ created, ...o, paid, archived })).toBe(before(l, o))
        n++
      }
    expect(n).toBe(1280) // 4 ages × 5 quote dates × 2⁶ yes/no facts
  })
  it('nothing writes a choice except the four doors (Closed Lost box, auto-close, Send to Jobber box, Nurturing Add)', () => {
    const hits: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const x = join(d, f); if (statSync(x).isDirectory()) walk(x); else if (/\.(ts|tsx|js|jsx)$/.test(f) && !/\.test\./.test(f)) { const s = readFileSync(x, 'utf8'); if (/(nurture|mailchimp)_choice:\s*['"a-z(]/.test(s) || /(nurture|mailchimp)_choice_at:/.test(s)) hits.push(x) } } }
    for (const d of ['app', 'lib', 'components', 'scripts']) walk(d)
    expect(hits.sort()).toEqual(['lib/network/nurturing-add.ts', 'lib/nurture-choice.ts'])
  })
})
