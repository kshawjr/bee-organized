// @vitest-environment happy-dom
//
// Clients at scale, slice 2 — nobody being worked is missing from the list
// (lib/hub-working-clients.ts, app/_hub-page.tsx, ClientGroupedList.jsx).
//
// On a cut-off load the page also loads every older client who belongs in a
// band other than Nurturing. Pinned here:
//   1) an open engagement → Active, however old the record
//   2) won work → Client, however old; paid history → Past; no email or
//      phone → No contact; an open enquiry → New / Attempting
//   3) a client who would be Nurturing is NOT dragged in
//   4) a location under the ceiling loads exactly what it loads today — same
//      rows by fingerprint, and not one extra query
//   5) another location's clients cannot be pulled in
//   6) junk and archived stay out, through the shared predicate
//   7) the Nurturing header tells the truth, or says the list is partial
//   8) the search still asks for everything older than the ORDINARY load
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { fetchWorkingClients, keepWorkingClients, clientsCutoffFor, WORKING_CLIENTS_MAX } from '@/lib/hub-working-clients'
import { hydrateClients } from '@/lib/client-search'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import ClientGroupedList, { CLIENT_SEARCH_DEBOUNCE_MS } from '@/components/hive/ClientGroupedList'
import { fakeDb } from '@/lib/fake-postgrest.test.harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_A = '11111111-1111-4111-8111-111111111111'
const LOC_B = '22222222-2222-4222-8222-222222222222'
const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString()
const RESUB = 'Webform resubmission'

const lead = (over: any) => ({
  id: over.id, name: over.id, first_name: null, last_name: null, email: `${over.id}@x.com`, phone: '610-555-0000',
  location_uuid: LOC_A, location_id: 'loc_a', is_junk: null, archived_at: null,
  created_at: daysAgo(700), import_source: 'jobber_initial', stage: 'Nurturing', addresses: [],
  paid_amount: 0, jobber_request_id: null, jobber_job_id: null,
  ...over,
})

// The newest clients — what the ordinary (cut-off) load holds.
const LOADED = () => [
  lead({ id: 'new-1', created_at: daysAgo(10) }),
  lead({ id: 'new-2', created_at: daysAgo(20) }),
  lead({ id: 'new-open', created_at: daysAgo(30) }),
]
function world() {
  const leads = [
    ...LOADED(),
    // ── older than the load ──
    lead({ id: 'old-open' }),                                            // open engagement
    lead({ id: 'old-won' }),                                             // Closed Won
    lead({ id: 'old-paid', paid_amount: 450 }),                          // paid history, no engagement
    lead({ id: 'old-nocontact', email: null, phone: '' }),               // nothing to reach them on
    lead({ id: 'old-enquiry', import_source: 'manual', created_at: daysAgo(650) }),   // never answered
    lead({ id: 'old-resub' }),                                           // Jobber client who filled in the form again
    lead({ id: 'old-reached', import_source: 'manual', created_at: daysAgo(640) }),   // enquiry, called since
    // would-be Nurturing — must NOT be loaded
    lead({ id: 'old-plain' }),                                           // imported contact, nothing else
    lead({ id: 'old-lost' }),                                            // Closed Lost only
    lead({ id: 'old-manual-closed', import_source: 'manual', created_at: daysAgo(650) }), // enquiry, closed since
    lead({ id: 'old-emailonly', phone: null }),                          // reachable by email
    // suppressed — must stay out whatever they carry
    lead({ id: 'old-junk-open', is_junk: true }),
    lead({ id: 'old-archived-won', archived_at: daysAgo(40) }),
    lead({ id: 'old-archived-paid', archived_at: daysAgo(40), paid_amount: 900 }),
    // another location entirely
    lead({ id: 'b-open', location_uuid: LOC_B, location_id: 'loc_b' }),
    lead({ id: 'b-paid', location_uuid: LOC_B, location_id: 'loc_b', paid_amount: 900 }),
    lead({ id: 'b-manual', location_uuid: LOC_B, location_id: 'loc_b', import_source: 'manual' }),
  ]
  const eng = (id: string, client_id: string, stage: string, location_uuid = LOC_A, closed_at: string | null = null) =>
    ({ id, client_id, stage, location_uuid, total_paid: stage === 'Closed Won' ? 800 : 0, total_invoiced: 0, closed_at, created_at: daysAgo(60) })
  return {
    leads,
    engagements: [
      eng('e1', 'new-open', 'Request'),
      eng('e2', 'old-open', 'Job in Progress'),
      eng('e3', 'old-won', 'Closed Won', LOC_A, daysAgo(300)),
      eng('e4', 'old-lost', 'Closed Lost', LOC_A, daysAgo(300)),
      eng('e5', 'old-manual-closed', 'Closed Lost', LOC_A, daysAgo(600)),
      eng('e6', 'old-junk-open', 'Request'),
      eng('e7', 'old-archived-won', 'Closed Won', LOC_A, daysAgo(300)),
      // an engagement row stamped LOC_A whose client lives at LOC_B
      eng('e8', 'b-open', 'Request', LOC_A),
      eng('e9', 'b-open', 'Request', LOC_B),
    ],
    touchpoints: [
      { id: 't1', lead_id: 'old-resub', location_uuid: LOC_A, kind: 'system', label: RESUB, occurred_at: daysAgo(3) },
      { id: 't2', lead_id: 'old-reached', location_uuid: LOC_A, kind: 'reach_out', method: 'call', label: 'Called', occurred_at: daysAgo(600) },
      // a resubmission row stamped LOC_A for a LOC_B client
      { id: 't3', lead_id: 'b-manual', location_uuid: LOC_A, kind: 'system', label: RESUB, occurred_at: daysAgo(3) },
    ],
    lookups: [], lead_tags: [], lead_notes: [], lead_contacts: [], assessments: [], service_requests: [], quotes: [],
    jobs: [], invoices: [], lead_assignees: [], partners: [],
  } as Record<string, any[]>
}

// The page's steps, with the same functions: ordinary rows + the extras →
// mapped by the page load's mapper → the Nurturing extras dropped.
async function load(w = world(), truncated = true, loaded = LOADED()) {
  const { db, calls } = fakeDb(w)
  const working = await fetchWorkingClients(db, { truncated, locationUuid: LOC_A, loadedRows: loaded })
  const mapped = await hydrateClients(db, [...loaded, ...working.extraRows])
  const people = keepWorkingClients(mapped, working, NOW)
  const band = (id: string) => {
    const p = people.find((x: any) => x.id === id)
    return p ? deriveClientStatus(p, working.openClientIds, NOW, null) : undefined
  }
  return { working, people, band, calls, ids: people.map((p: any) => p.id).sort() }
}

describe('a cut-off load also loads everyone being worked', () => {
  it('an open engagement → Active, however old the record', async () => {
    const r = await load()
    expect(r.band('old-open')).toBe('Active')
  })

  it('won work → Client, however old the record', async () => {
    const r = await load()
    expect(r.band('old-won')).toBe('Client')
  })

  it('paid history → Past; no email or phone → No contact; an open enquiry → New or Attempting', async () => {
    const r = await load()
    expect(r.band('old-paid')).toBe('Past')
    expect(r.band('old-nocontact')).toBe('no_contact')
    expect(r.band('old-enquiry')).toBe('New')
    expect(r.band('old-resub')).toBe('New')
    expect(r.band('old-reached')).toBe('Attempting')
  })

  it('every band but Nurturing is complete: the load agrees with deriving EVERY client at the location', async () => {
    const w = world()
    const r = await load(w)
    const { db } = fakeDb(w)
    const everyone = await hydrateClients(db, w.leads.filter(l => l.location_uuid === LOC_A && l.is_junk !== true && l.archived_at == null))
    const truth = everyone
      .filter((p: any) => deriveClientStatus(p, r.working.openClientIds, NOW, null) !== 'Nurturing')
      .map((p: any) => p.id).sort()
    const got = r.people.filter((p: any) => r.band(p.id) !== 'Nurturing').map((p: any) => p.id).sort()
    expect(got).toEqual(truth)
    expect(truth).toContain('old-open')
  })
})

describe('a client who would be Nurturing is not dragged in', () => {
  it('an old contact with no marker is never even read; one with a marker but a Nurturing verdict is dropped', async () => {
    const r = await load()
    // never candidates
    for (const id of ['old-plain', 'old-lost', 'old-emailonly']) expect(r.working.extraIds.has(id), id).toBe(false)
    // a candidate (hand-entered lead) that the derivation calls Nurturing
    expect(r.working.extraIds.has('old-manual-closed')).toBe(true)
    expect(r.ids).not.toContain('old-manual-closed')
    // the extras that stayed are exactly the non-Nurturing ones
    expect(r.ids).toEqual(['new-1', 'new-2', 'new-open', 'old-enquiry', 'old-nocontact', 'old-open', 'old-paid', 'old-reached', 'old-resub', 'old-won'])
    for (const id of r.ids.filter(i => i.startsWith('old-'))) expect(r.band(id), id).not.toBe('Nurturing')
  })

  it('a client from the ordinary load is never dropped, Nurturing or not', async () => {
    const r = await load()
    expect(r.band('new-1')).toBe('Nurturing')
    expect(r.ids).toContain('new-1')
  })
})

describe('a location under the ceiling is untouched', () => {
  const fingerprint = (rows: any[]) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')

  it('no query at all, nothing added, the same rows by fingerprint and the same people array', async () => {
    const loaded = world().leads.filter(l => l.location_uuid === LOC_A)
    const before = fingerprint(loaded)
    let queries = 0
    const db = { from: () => { queries++; throw new Error('a complete load must not query') } }
    const working = await fetchWorkingClients(db, { truncated: false, locationUuid: LOC_A, loadedRows: loaded })
    expect(queries).toBe(0)
    expect(working.extraRows).toEqual([])
    expect(working.extraIds.size).toBe(0)
    expect(working.complete).toBe(true)
    // the page's two follow-on steps, as written there
    if (working.extraRows.length > 0) loaded.push(...working.extraRows)
    expect(fingerprint(loaded)).toBe(before)
    const people = loaded.map(l => ({ id: l.id }))
    expect(keepWorkingClients(people, working)).toBe(people)       // same array, not a copy
    expect(clientsCutoffFor(false, working, people.length)).toBeNull()
  })

  it('the page only ever switches it on with its own cut-off flag, and calls it once', () => {
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    expect(src.split('fetchWorkingClients(').length - 1).toBe(1)
    const at = src.indexOf('await fetchWorkingClients(supabaseService, {')
    const call = src.slice(at, at + 200)
    expect(call).toContain('truncated: leadsTruncated, locationUuid: scopeLocationUuid, loadedRows: leadsRaw,')
    expect(src).toContain('if (leadsRaw && working.extraRows.length > 0) leadsRaw.push(...working.extraRows)')
    expect(src).toContain('initialPeople = keepWorkingClients(initialPeople, working)')
    expect(src).toContain('initialClientsCutoff = clientsCutoffFor(leadsTruncated, working, initialPeople.length)')
    // the extras join BEFORE the child rows are read and the board names are built
    expect(at).toBeLessThan(src.indexOf('const leadIds = leadsRaw.map((l: any) => l.id)'))
    expect(at).toBeLessThan(src.indexOf('for (const l of leadsRaw) leadInfoById[l.id]'))
  })

  it('a franchise load with no single location does nothing either', async () => {
    const db = { from: () => { throw new Error('no') } }
    const working = await fetchWorkingClients(db, { truncated: true, locationUuid: null, loadedRows: LOADED() })
    expect(working.extraRows).toEqual([])
  })
})

describe('only this location, and never junk or archived', () => {
  it("another location's clients cannot be pulled in — even when an engagement or touchpoint row points at them", async () => {
    const r = await load()
    for (const id of ['b-open', 'b-paid', 'b-manual']) {
      expect(r.working.extraIds.has(id), id).toBe(false)
      expect(r.ids).not.toContain(id)
    }
    for (const c of r.calls.filter(c => c.table === 'leads')) expect(c.filters).toContain(`eq:location_uuid:${LOC_A}`)
    for (const c of r.calls.filter(c => c.table === 'engagements' && !c.filters.some(f => f.startsWith('in:')))) expect(c.filters).toContain(`eq:location_uuid:${LOC_A}`)
  })

  it('junk and archived stay out, and every leads read went through the shared predicate', async () => {
    const r = await load()
    for (const id of ['old-junk-open', 'old-archived-won', 'old-archived-paid']) expect(r.working.extraIds.has(id), id).toBe(false)
    const leadReads = r.calls.filter(c => c.table === 'leads')
    expect(leadReads.length).toBeGreaterThanOrEqual(5)   // 3 marker reads, the count, the rows
    for (const c of leadReads) {
      expect(c.filters).toContain('not:is_junk:is:true')
      expect(c.filters).toContain('is:archived_at:null')
    }
    const code = readFileSync('lib/hub-working-clients.ts', 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).toContain("import { applyLeadActiveFilter } from './lead-suppression'")
    expect(code).not.toMatch(/is_junk|archived_at/)
  })
})

describe('what the page tells the list', () => {
  it('counts exactly the clients that are not listed — all of them Nurturing', async () => {
    const r = await load()
    const cut = clientsCutoffFor(true, r.working, r.people.length)!
    // 14 active clients at LOC_A; 10 listed; the 4 left are the would-be Nurturing
    expect(r.working.totalActive).toBe(14)
    expect(cut.notListed).toBe(4)
    expect(cut.loadedBackTo).toBe(LOADED()[2].created_at)   // the ORDINARY load's oldest, not the extras'
  })

  it('a failed read makes no claim: incomplete, and no number for the list', async () => {
    const { db } = fakeDb(world())
    const real = db.from
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(db as any).from = (t: string) => t === 'engagements'
      ? { select: () => ({ eq: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }
      : real(t)
    const working = await fetchWorkingClients(db, { truncated: true, locationUuid: LOC_A, loadedRows: LOADED() })
    expect(working.complete).toBe(false)
    expect(clientsCutoffFor(true, working, 5)).toEqual({ loadedBackTo: LOADED()[2].created_at, notListed: null })
    // the page still renders with what it could read
    expect(working.extraIds.has('old-paid')).toBe(true)
    expect(errs).toHaveBeenCalled()
    errs.mockRestore()
  })

  it('the guard: more candidates than the limit is reported, not silently trimmed', async () => {
    const w = world()
    for (let i = 0; i < WORKING_CLIENTS_MAX + 5; i++) w.leads.push(lead({ id: `bulk-${i}`, paid_amount: 10 }))
    const { db } = fakeDb(w)
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    const working = await fetchWorkingClients(db, { truncated: true, locationUuid: LOC_A, loadedRows: LOADED() })
    // the limit applies to candidate ids; the four that fail the fence fall out after it
    expect(working.extraRows.length).toBeLessThanOrEqual(WORKING_CLIENTS_MAX)
    expect(working.extraRows.length).toBeGreaterThan(WORKING_CLIENTS_MAX - 10)
    expect(working.complete).toBe(false)
    expect(working.extraIds.has('old-open')).toBe(true)   // working clients first
    errs.mockRestore()
  })
})

// ── the screen ───────────────────────────────────────────────────────────────
describe('the Client List on a cut-off load', () => {
  let host: HTMLDivElement, root: any, fetchMock: any
  const CUT = daysAgo(300)
  const person = (over: any) => ({ id: over.id, name: over.id, email: 'a@x.com', phone: '1', locationId: LOC_A, created: daysAgo(10), tagIds: [], outreachTimeline: [], importSource: 'jobber_initial', ...over })
  const PEOPLE = () => [
    person({ id: 'Nora Newer' }),
    person({ id: 'Nell Newer' }),
    // an older working client the page loaded as well
    person({ id: 'Wendy Old', created: daysAgo(700), wonEngagements: { count: 1, value: 800, lastClosedAt: daysAgo(300) } }),
  ]
  const mount = async (props: any = {}) => {
    await act(async () => {
      root.render(<ClientGroupedList people={PEOPLE()} engagements={[]} locFilter={LOC_A} locations={[]} tags={[]} searchLocationId={LOC_A} {...props} />)
    })
  }
  const header = (label: string) => host.querySelector(`[aria-label="${label} group"]`)?.textContent
  const type = async (value: string) => {
    const input = host.querySelector('input[aria-label="Search clients"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ people: [], total: 0, capped: false }) }))
    ;(globalThis as any).fetch = fetchMock
  })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers() })

  it('the Nurturing header counts everyone, and says where the rest are', async () => {
    await mount({ leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 13924 } })
    expect(header('Nurturing')).toContain('13,926')
    // slice 3: the rest are now reached with Show more, and the line says so
    expect(host.querySelector('[data-testid="clients-nurturing-browse-hint"]')!.textContent)
      .toBe('Open this group to go through them A to Z, a page at a time — or type a name, email or phone in the search box.')
    // the complete bands show their plain count and carry no such line
    expect(header('Client')).toContain('· 1')
    expect(host.querySelectorAll('[data-testid="clients-nurturing-browse-hint"]').length).toBe(1)
    expect(host.querySelector('[data-testid="clients-list-partial"]')).toBeNull()
  })

  it('the Nurturing band still shows when none of its clients are in the list', async () => {
    await act(async () => {
      const props: any = { people: [PEOPLE()[2]], engagements: [], locFilter: LOC_A, locations: [], tags: [], leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 50 } }
      root.render(<ClientGroupedList {...props} />)
    })
    expect(header('Nurturing')).toContain('· 50')
  })

  it('when the page could not establish the count, no band claims one — the list says it is partial', async () => {
    await mount({ leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: null } })
    expect(header('Nurturing')).toContain('· 2')
    expect(host.querySelector('[data-testid="clients-nurturing-unlisted"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-list-partial"]')!.textContent).toContain("older ones aren't listed here")
  })

  it('a complete load says none of this', async () => {
    await mount({ leadsTruncated: false, clientsCutoff: null })
    expect(header('Nurturing')).toContain('· 2')
    expect(host.querySelector('[data-testid="clients-nurturing-unlisted"]')).toBeNull()
    expect(host.querySelector('[data-testid="clients-list-partial"]')).toBeNull()
  })

  it('a search shows its own matches — the unlisted count is not added to them', async () => {
    await mount({ leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 13924 } })
    await type('nora')
    expect(header('Nurturing')).toContain('· 1')
    expect(host.querySelector('[data-testid="clients-nurturing-unlisted"]')).toBeNull()
  })

  it('the search asks for everything older than the ORDINARY load, not older than the oldest extra', async () => {
    await mount({ leadsTruncated: true, clientsCutoff: { loadedBackTo: CUT, notListed: 13924 } })
    await type('smith')
    await act(async () => { await vi.advanceTimersByTimeAsync(CLIENT_SEARCH_DEBOUNCE_MS + 5) })
    const url = new URL(fetchMock.mock.calls[0][0], 'http://x')
    expect(url.searchParams.get('olderThan')).toBe(CUT)   // not Wendy Old's 700-day-old date
  })

  it('the cut-off facts are threaded from the page to the list', () => {
    const page = readFileSync('app/_hub-page.tsx', 'utf8')
    expect(page).toContain('initialClientsCutoff={initialClientsCutoff}')
    const hub = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(hub).toContain('locationRequired={!!initialAllOverview} clientsCutoff={initialClientsCutoff||null}')
    expect(hub).toContain('locationRequired={!!allOverview} clientsCutoff={clientsCutoff}')
    expect(hub.split('clientsCutoff={initialClientsCutoff||null}').length - 1).toBe(2)
    expect(hub).toContain('          clientsCutoff={clientsCutoff}\n          locationRequired={locationRequired}')
    const shell = readFileSync('components/hive/HiveShell.jsx', 'utf8')
    expect(shell).toContain('          clientsCutoff={clientsCutoff}\n')
  })
})
