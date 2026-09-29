// @vitest-environment happy-dom
//
// NETWORK Phase 3 — the person record (NetworkPersonRecord), the module
// that retires Classic's PartnerPanel. Mount tests:
//
//   A) BADGES derive from FACTS: Refers-us appears only once the rollup
//      confirms real referrals; Potential-customer from the warm/Customer
//      signal; Client from is_customer — deep-linking via
//      customer_lead_id (a legacy flag with no link renders unlinked).
//   B) STAGE RAIL is the partner vocabulary, editable — clicking a
//      segment PATCHes stage via the host's onUpdate. Never engagement
//      stages.
//   C) STATS: '—' while /referrals is pending; the real joined numbers
//      once it resolves.
//   D) TOUCHPOINTS: TouchpointModal is mounted VERBATIM and THIS record
//      owns the POST — /api/touchpoints with partner_id (the one
//      writer); a confirmed write updates the local last-talked state.
//   E) WHAT'S NEXT: steps render, checking one PATCHes nextSteps.
//   F) CUSTOMER PATH: "Add as client" matches an existing client FIRST
//      (no duplicate lead), else POSTs /api/leads and stores the REAL id.
//      Only ONE exact email/phone match at the partner's location links by
//      itself; a name match never does — it lists, nobody chosen, with a
//      "none of these" exit. Other locations are never offered.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkPersonRecord from '@/components/hive/NetworkPersonRecord'
import { deriveNetworkBadges } from '@/components/hive/shared/networkKit'
import { T } from '@/components/hive/shared/tokens'
import { matchPartnerToClients } from '@/components/hive/shared/clientMatch'

// The DB re-check (queryLeadMatches) — rows the test puts here come back
// from the fake supabase chain, whatever the filter.
let dbRows: any[] = []
vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const chain: any = {
      from: () => chain, select: () => chain, or: () => chain, not: () => chain,
      range: () => chain, eq: () => chain,
      then: (res: any, rej: any) => Promise.resolve({ data: dbRows, error: null }).then(res, rej),
    }
    return chain
  },
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const PARTNER = {
  id: 'p1', name: 'Karen Martinez', type: 'partner', locationId: 'loc-1',
  title: 'Agent', company: 'Meridian Realty', companyId: 'co1',
  phone: '(816) 555-0916', email: 'karen@meridian.com', website: '',
  specialties: ['real-estate'], stage: 'Building', tags: [],
  lastContactedAt: daysAgo(5), isCustomer: false, customerLeadId: null,
  howWeMet: 'Denver Expo', metDate: 'Nov 2024',
  addresses: [], notes: [], nextSteps: [
    { id: 'ns1', text: 'Send gift', date: '2026-07-20', done: false },
  ], referrals: [], activity: [], isDeleted: false,
}

const REFERRALS = {
  partner: { id: 'p1', name: 'Karen Martinez', type: 'partner' },
  referred: [
    { id: 'L1', name: 'Lisa Patel', created_at: daysAgo(20), converted: true, revenue: 1200, engagement_count: 1, status: 'client' },
    { id: 'L2', name: 'Mark Johnson', created_at: daysAgo(10), converted: false, revenue: 0, engagement_count: 1, status: 'active' },
  ],
  totals: { count: 2, converted: 1, revenue: 1200 },
  total: 2,
}

let host: HTMLDivElement
let root: Root
let fetchMock: any
let fetchCalls: Array<{ url: string; init: any }>

const installFetch = (handlers: Record<string, any> = {}) => {
  fetchCalls = []
  fetchMock = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    fetchCalls.push({ url: u, init })
    for (const [frag, resp] of Object.entries(handlers)) {
      if (u.includes(frag)) {
        const r = typeof resp === 'function' ? (resp as any)(u, init) : resp
        if (r instanceof Promise) return r
        return { ok: true, status: 200, json: async () => r }
      }
    }
    if (u.includes('/referrals')) return { ok: true, status: 200, json: async () => REFERRALS }
    if (u.includes('/timeline')) return { ok: true, status: 200, json: async () => ({ touchpoints: [] }) }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
}

const mount = async (props: any = {}) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<NetworkPersonRecord partner={PARTNER} companies={[{ id: 'co1', name: 'Meridian Realty' }]} people={[]} {...props} />)
  })
  await act(async () => {}) // flush fetches
}

beforeEach(() => { installFetch(); dbRows = [] })
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

describe('A) badges derive from facts', () => {
  it('Refers us appears only on a CONFIRMED referral count; potential/client from their signals', () => {
    expect(deriveNetworkBadges({ partner: PARTNER, referralCount: null })).toEqual([]) // unknown ≠ refers
    expect(deriveNetworkBadges({ partner: PARTNER, referralCount: 0 })).toEqual([])
    expect(deriveNetworkBadges({ partner: PARTNER, referralCount: 2 }).map(b => b.key)).toEqual(['refers'])
    expect(deriveNetworkBadges({ partner: { ...PARTNER, tags: ['warm'] }, referralCount: 0 }).map(b => b.key)).toEqual(['potential'])
    const client = deriveNetworkBadges({ partner: { ...PARTNER, isCustomer: true, customerLeadId: 'lead-9' }, referralCount: 0 })
    expect(client[0]).toMatchObject({ key: 'client', clientLeadId: 'lead-9' })
    // Legacy flag with no link → badge still shows, unlinked.
    expect(deriveNetworkBadges({ partner: { ...PARTNER, isCustomer: true }, referralCount: 0 })[0].clientLeadId).toBe(null)
  })

  it('renders them: Refers us appears after the rollup lands; Client deep-links', async () => {
    await mount({ partner: { ...PARTNER, isCustomer: true, customerLeadId: 'lead-9' } })
    expect(host.querySelector('[data-badge="refers"]')).toBeTruthy()
    const clientBadge = host.querySelector('[data-badge="client"]') as HTMLAnchorElement
    expect(clientBadge).toBeTruthy()
    expect(clientBadge.getAttribute('href')).toBe('/clients/lead-9')
  })
})

describe('B) stage rail — the partner vocabulary, editable', () => {
  it('renders the five relationship stages and PATCHes on click', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate })
    const rail = host.querySelector('[data-testid="stage-rail"]')!
    const segs = [...rail.querySelectorAll('[data-stage-seg]')].map(s => s.getAttribute('data-stage-seg'))
    expect(segs).toEqual(['New Contact', 'Reaching Out', 'Building', 'Active Partner', 'Dormant'])
    // Never the engagement vocabulary.
    expect(segs).not.toContain('Request')
    expect(segs).not.toContain('Closed Won')
    // Building = index 2 → three filled segments.
    expect(rail.querySelectorAll('[data-filled="true"]')).toHaveLength(3)
    await act(async () => { (rail.querySelector('[data-stage-seg="Active Partner"]') as HTMLElement).click() })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', stage: 'Active Partner' }))
  })

  it('segments come from the stages prop (lookups) — a Configure-added stage appears; clicks write the KEY, labels display', async () => {
    const onUpdate = vi.fn()
    const STAGES = [
      { key: 'New Contact', label: 'New Contact' },
      { key: 'Building', label: 'Building the Relationship' },
      { key: 'Champion', label: 'Champion' }, // admin-added 6th-style value
    ]
    await mount({ onUpdate, stages: STAGES })
    const rail = host.querySelector('[data-testid="stage-rail"]')!
    const segs = [...rail.querySelectorAll('[data-stage-seg]')]
    expect(segs.map(s => s.getAttribute('data-stage-seg'))).toEqual(['New Contact', 'Building', 'Champion'])
    // stored KEY 'Building' fills via key match while the segment shows the label
    expect(segs[1].textContent).toContain('Building the Relationship')
    expect(rail.querySelectorAll('[data-filled="true"]')).toHaveLength(2)
    await act(async () => { (rail.querySelector('[data-stage-seg="Champion"]') as HTMLElement).click() })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ stage: 'Champion' }))
  })

  it("an off-list stored value ('Customer'/legacy) still renders beside an unfilled rail — never vanishes, never coerced", async () => {
    await mount({ partner: { ...PARTNER, stage: 'Customer' }, stages: [{ key: 'New Contact', label: 'New Contact' }] })
    const rail = host.querySelector('[data-testid="stage-rail"]')!
    expect(rail.querySelectorAll('[data-filled="true"]')).toHaveLength(0)
    expect(rail.textContent).toContain('Current: Customer')
  })
})

describe('C) honest stats', () => {
  it("'—' while the rollup is pending — never a fake zero", async () => {
    installFetch({ '/referrals': () => new Promise(() => {}) }) // never resolves
    await mount()
    const stats = host.querySelector('[data-testid="person-stats"]')!
    expect(stats.textContent).toContain('—')
    expect(stats.textContent).not.toContain('$0')
  })

  it('real joined numbers once resolved; referred leads deep-link', async () => {
    await mount()
    const stats = host.querySelector('[data-testid="person-stats"]')!
    expect(stats.textContent).toContain('2')
    expect(stats.textContent).toContain('$1,200')
    const referred = host.querySelector('[data-testid="leads-referred"]')!
    const lisa = [...referred.querySelectorAll('a')].find(a => a.textContent!.includes('Lisa Patel'))!
    expect(lisa.getAttribute('href')).toBe('/clients/L1')
    expect(lisa.textContent).toContain('$1,200')
  })
})

describe('D) touchpoints — the record owns the POST', () => {
  it('logs via /api/touchpoints with partner_id and reconciles last-talked', async () => {
    const onUpdate = vi.fn()
    installFetch({
      '/api/touchpoints': { touchpoint: { id: 'tp-9', occurred_at: daysAgo(0) } },
    })
    await mount({ onUpdate })
    await act(async () => {
      ([...host.querySelectorAll('button')].find(b => b.textContent === '+ Log touchpoint') as HTMLElement).click()
    })
    // The VERBATIM modal is up (its method tiles + verb-restating button).
    const logBtn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Log call')!
    expect(logBtn).toBeTruthy()
    await act(async () => { logBtn.click() })
    const post = fetchCalls.find(c => c.url.includes('/api/touchpoints') && c.init?.method === 'POST')!
    expect(post).toBeTruthy()
    const body = JSON.parse(post.init.body)
    expect(body).toMatchObject({ partner_id: 'p1', kind: 'reach_out', method: 'call' })
    expect(body).not.toHaveProperty('lead_id')
    // last-talked reconciled into state (state-only; lastContactedAt is
    // not a PATCHable field).
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ lastContactedAt: expect.any(String) }))
  })
})

describe("E) what's next", () => {
  it('renders open steps and checking one PATCHes nextSteps', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate })
    const section = host.querySelector('[data-testid="next-steps"]')!
    expect(section.textContent).toContain('Send gift')
    await act(async () => {
      (section.querySelector('[aria-label="Mark done: Send gift"]') as HTMLElement).click()
    })
    const patched = onUpdate.mock.calls[0][0]
    expect(patched.nextSteps.find((s: any) => s.id === 'ns1').done).toBe(true)
  })
})

describe('F) customer path — link, never a blind copy', () => {
  const client = (over: any = {}) => ({ id: 'lead-77', name: 'Karen Martinez', email: 'karen@meridian.com', phone: '', locationId: 'loc-1', isJunk: false, ...over })
  const openAddAsClient = async () => {
    await act(async () => {
      (host.querySelector('[aria-label="Partner actions"]') as HTMLElement).click()
    })
    const item = [...document.querySelectorAll('button')].find(b => b.textContent!.includes('Add as client'))!
    await act(async () => { item.click() })
    await act(async () => {})
  }
  const choiceRows = () => [...host.querySelectorAll('[aria-label="Possible clients"] [role="listitem"]')] as HTMLElement[]
  const leadPosts = () => fetchCalls.filter(c => c.url.includes('/api/leads') && c.init?.method === 'POST')

  it('an exact email match links straight through: their REAL id, no lead POST, no list', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate, people: [client()] })
    await openAddAsClient()
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ isCustomer: true, customerLeadId: 'lead-77' }))
    expect(leadPosts()).toHaveLength(0)
    expect(host.querySelector('[data-testid="link-choices"]')).toBeNull()
  })

  it('email on file but not matching → the phone is still tried (exact digits, any formatting)', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate, people: [client({ id: 'lead-ph', email: 'other@x.com', phone: '816-555-0916' })] })
    await openAddAsClient()
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-ph' }))
  })

  it('an exact match NOT loaded on screen is found by the DB re-check', async () => {
    const onUpdate = vi.fn()
    dbRows = [{ id: 'lead-db', name: 'Karen Martinez', email: 'karen@meridian.com', phone: null, location_uuid: 'loc-1', is_junk: null }]
    await mount({ onUpdate, people: [] })
    await openAddAsClient()
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-db' }))
    expect(leadPosts()).toHaveLength(0)
  })

  it('a name match never links on its own — even a single one: it is listed, nobody chosen', async () => {
    const onUpdate = vi.fn()
    const karen = { ...PARTNER, name: 'Karen', email: '', phone: '' }
    await mount({ onUpdate, partner: karen, people: [client({ id: 'lead-k', name: 'Karen Smith', email: 'ks@x.com' })] })
    await openAddAsClient()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(leadPosts()).toHaveLength(0)
    expect(choiceRows().map(r => r.textContent)).toEqual([expect.stringContaining('Karen Smith')])
  })

  it('a partial phone never matches, and 2 letters inside a name never match', async () => {
    const onUpdate = vi.fn()
    installFetch({ '/api/leads': (u: string, init: any) => (init?.method === 'POST' ? { lead: { id: 'lead-new-2' } } : {}) })
    const partner = { ...PARTNER, name: 'Al', email: '', phone: '555-0916' }
    await mount({ onUpdate, partner, people: [
      client({ id: 'lead-a', name: 'Alice Walker', email: '', phone: '(816) 555-0916' }), // phone CONTAINS 5550916
      client({ id: 'lead-b', name: 'Sally Albright', email: '' }),
    ] })
    await openAddAsClient()
    expect(choiceRows()).toHaveLength(0)
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-new-2' }))
  })

  it('the Shelby case: two people sharing a first name are both listed with a way to tell them apart, nobody chosen', async () => {
    const onUpdate = vi.fn()
    const shelby = { ...PARTNER, name: 'Shelby', email: '', phone: '' }
    await mount({ onUpdate, partner: shelby, people: [
      client({ id: 'lead-s1', name: 'Shelby Grant', email: 'sgrant@mail.com', phone: '503-555-0101' }),
      client({ id: 'lead-s2', name: 'Shelby Owens', email: 'owens.s@mail.com', phone: '503-555-0202' }),
    ] })
    await openAddAsClient()
    expect(onUpdate).not.toHaveBeenCalled()
    const rows = choiceRows()
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('s···@mail.com')
    expect(rows[0].textContent).toContain('0101')
    expect(rows[1].textContent).toContain('o···@mail.com')
    expect(rows[1].textContent).toContain('0202')
    // The owner picks the second Shelby — THAT one links.
    await act(async () => { rows[1].click() })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-s2' }))
  })

  it('two people on one phone list instead of linking the first', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate, partner: { ...PARTNER, email: '' }, people: [
      client({ id: 'lead-h1', name: 'Karen Martinez', email: '', phone: '8165550916' }),
      client({ id: 'lead-h2', name: 'Luis Martinez', email: '', phone: '+1 (816) 555-0916' }),
    ] })
    await openAddAsClient()
    expect(onUpdate).not.toHaveBeenCalled()
    expect(choiceRows()).toHaveLength(2)
  })

  it('"None of these" exists and creates a new client; Cancel does nothing', async () => {
    const onUpdate = vi.fn()
    installFetch({ '/api/leads': (u: string, init: any) => (init?.method === 'POST' ? { lead: { id: 'lead-new-3' } } : {}) })
    await mount({ onUpdate, partner: { ...PARTNER, email: '', phone: '' }, people: [client({ email: 'x@y.com' })] })
    await openAddAsClient()
    const none = [...host.querySelectorAll('button')].find(b => b.textContent === 'None of these — add as a new client')!
    expect(none).toBeTruthy()
    await act(async () => { none.click() })
    await act(async () => {})
    expect(leadPosts()).toHaveLength(1)
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-new-3' }))
    expect(host.querySelector('[data-testid="link-choices"]')).toBeNull()
  })

  it('a client at another location is never offered or linked, even on an exact email', async () => {
    const onUpdate = vi.fn()
    installFetch({ '/api/leads': (u: string, init: any) => (init?.method === 'POST' ? { lead: { id: 'lead-new-4' } } : {}) })
    dbRows = [] // the DB re-check is location-scoped
    await mount({ onUpdate, people: [
      client({ id: 'lead-far', locationId: 'loc-2' }),               // same email, other location
      client({ id: 'lead-far2', locationId: 'loc-2', email: '' }),   // same name, other location
    ] })
    await openAddAsClient()
    expect(choiceRows()).toHaveLength(0)
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-far' }))
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-far2' }))
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ customerLeadId: 'lead-new-4' }))
  })

  it('no match → POST /api/leads and store the REAL created id (the Classic copy stored nothing)', async () => {
    const onUpdate = vi.fn()
    installFetch({
      '/api/leads': (u: string, init: any) => (init?.method === 'POST'
        ? { lead: { id: 'lead-new-1', name: 'Karen Martinez' } }
        : {}),
    })
    await mount({ onUpdate, people: [] })
    await openAddAsClient()
    const post = leadPosts()[0]
    expect(JSON.parse(post.init.body)).toMatchObject({ name: 'Karen Martinez', location_id: 'loc-1' })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ isCustomer: true, customerLeadId: 'lead-new-1' }))
  })
})

describe('F) matchPartnerToClients — the pure rule', () => {
  const P = { name: 'Karen Martinez', email: 'Karen@Meridian.com ', phone: '1-816-555-0916', locationId: 'loc-1' }
  const c = (id: string, over: any = {}) => ({ id, name: 'Nobody', email: '', phone: '', locationId: 'loc-1', ...over })

  it('tries every key: email, phone and whole-word name each count', () => {
    const r = matchPartnerToClients([
      c('e', { email: 'karen@meridian.com' }),
      c('n', { name: 'Karen Martinez-Lopez' }), // words, not substrings — "martinez-lopez" splits
    ], P)
    expect(r.auto!.person.id).toBe('e')
    expect(r.candidates.map(h => [h.person.id, h.matchedOn])).toEqual([['e', ['email']], ['n', ['name']]])
  })

  it('email to one person and phone to another is a conflict → no auto', () => {
    const r = matchPartnerToClients([c('e', { email: 'karen@meridian.com' }), c('p', { phone: '816.555.0916' })], P)
    expect(r.auto).toBeNull()
    expect(r.candidates).toHaveLength(2)
  })

  it('no location → nothing, never a cross-location guess', () => {
    expect(matchPartnerToClients([c('e', { email: 'karen@meridian.com', locationId: null })], { ...P, locationId: null }))
      .toEqual({ auto: null, candidates: [] })
  })

  it('junk rows are skipped; NULL is_junk stays in', () => {
    const r = matchPartnerToClients([c('j', { email: 'karen@meridian.com', isJunk: true }), c('ok', { email: 'karen@meridian.com', isJunk: null })], P)
    expect(r.auto!.person.id).toBe('ok')
  })
})

// ═══ partnership vocabulary (tag system 2B) ═══════════════════
// Tier + specialties become editable after creation via the shared
// PickerModal; tags ride the SAME TagsRow pairing ClientProfile uses,
// against the partner_tags junction — never the dead partners.tags column.
describe('F) partnership — tier, specialties, tags', () => {
  const TIERS = [{ id: 'referral-partner', label: 'Referral Partner' }, { id: 'power-partner', label: 'Power Partner' }]
  const SPECS = [{ id: 'real-estate', label: 'Realtor' }, { id: 'senior-living', label: 'Senior Living' }]
  const TIER_LOOKUPS = {
    lookups: [
      { id: 'uuid-rp', label: 'Referral Partner', category: 'partner_tiers', location_id: null, is_active: true, attrs: { key: 'referral-partner' } },
      { id: 'uuid-pp', label: 'Power Partner', category: 'partner_tiers', location_id: null, is_active: true, attrs: { key: 'power-partner' } },
    ],
    location: { id: 'loc-1', name: 'Denver' },
  }

  it('renders stored keys as labels (tier + specialties) and junction tags from /api/partner-tags — the dead array column is never read', async () => {
    installFetch({ '/api/partner-tags': { tags: [{ id: 'tag-1', label: 'Snowbird' }] } })
    await mount({
      partner: { ...PARTNER, tier: 'referral-partner', tags: ['stale-array-value'] },
      tiers: TIERS, specialties: SPECS,
    })
    const section = host.querySelector('[data-testid="partnership"]')!
    expect(section.textContent).toContain('Referral Partner')  // tier key → label
    expect(section.textContent).toContain('Realtor')           // specialty key → label
    expect(section.textContent).toContain('Snowbird')          // junction tag
    expect(section.textContent).not.toContain('stale-array-value')
  })

  it('tier PickerModal (single) saves the attrs.key through the PATCH path', async () => {
    const onUpdate = vi.fn()
    installFetch({ '/api/lookups': TIER_LOOKUPS, '/api/partner-tags': { tags: [] } })
    await mount({ onUpdate, tiers: TIERS, specialties: SPECS })
    await act(async () => { (host.querySelector('[aria-label="Edit tier"]') as HTMLElement).click() })
    const dialog = host.querySelector('[role="dialog"]')!
    const row = [...dialog.querySelectorAll('button')].find(b => b.textContent!.includes('Power Partner'))!
    await act(async () => { row.click() })
    const save = [...dialog.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Save')!
    await act(async () => { save.click() })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', tier: 'power-partner' }))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('specialties PickerModal carries the 8 cap (maxSelected) so the user is told before saving', async () => {
    installFetch({
      '/api/lookups': {
        lookups: Array.from({ length: 10 }, (_, i) => ({ id: `u${i}`, label: `Spec ${i}`, category: 'partner_specialties', location_id: null, is_active: true, attrs: { key: `spec-${i}` } })),
        location: { id: 'loc-1', name: 'Denver' },
      },
      '/api/partner-tags': { tags: [] },
    })
    await mount({ partner: { ...PARTNER, specialties: [] }, tiers: TIERS, specialties: SPECS })
    await act(async () => { (host.querySelector('[aria-label="Edit specialties"]') as HTMLElement).click() })
    const dialog = host.querySelector('[role="dialog"]')!
    for (let i = 0; i < 9; i++) {
      const row = [...dialog.querySelectorAll('button')].find(b => b.textContent!.trim() === `Spec ${i}`)!
      await act(async () => { row.click() })
    }
    expect(dialog.textContent).toContain('Up to 8 can be selected')
    expect(dialog.querySelectorAll('[aria-checked="true"]')).toHaveLength(8)
  })

  it('read-only hides every partnership edit affordance', async () => {
    installFetch({ '/api/partner-tags': { tags: [] } })
    await mount({ readOnly: true, tiers: TIERS, specialties: SPECS })
    expect(host.querySelector('[aria-label="Edit tier"]')).toBeNull()
    expect(host.querySelector('[aria-label="Edit specialties"]')).toBeNull()
    expect(host.querySelector('[aria-label="Add tag"]')).toBeNull()
  })
})
