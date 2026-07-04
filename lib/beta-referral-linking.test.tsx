// @vitest-environment happy-dom
// Referral-source referrer linking in the beta (NewClientSheet +
// ClientProfile). Covers:
//   - Source='Referral' opens the ReferrerPicker; three sections
//     populate (clients from the people prop, partners/contacts from
//     /api/partners split on type)
//   - match: a client row writes referred_by_kind='lead' + id; a
//     partner row writes kind='partner' + id
//   - match-or-create: inline-create partner AND contact → POST
//     /api/partners with the right type → auto-selected, kind='partner'
//     (contacts store as 'partner' too — the kind enum has two values)
//   - Clients section is MATCH-ONLY: exactly two create rows, none for
//     clients
//   - Referral with NO referrer saves nulls — founding never blocked
//   - switching source off Referral clears a picked referrer
//   - forward display: ClientProfile says "Referred by <NAME>" for both
//     a partner referrer and a lead referrer (not just "via partner")
//   - reverse display: "Referred us" lists the people this client
//     referred
//   - EDIT surface (existing leads): Add referrer / edit / clear from
//     the profile's Marketing card — set PATCHes kind+id AND
//     source='Referral' (the coupling); clear nulls both fields and
//     does NOT touch source (the asymmetry); client referrers write
//     kind='lead'; inline-create works from the profile; the client
//     never appears as their own referrer
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NewClientSheet from '@/components/hive/NewClientSheet'
import ClientProfile from '@/components/hive/ClientProfile'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(40),
  isJunk: false,
  outreachTimeline: [],
  ...over,
})

const LOOKUPS = { sources: ['Manual', 'Website', 'Referral'], projectTypes: ['Client'] }

const PARTNER_ROWS = [
  { id: 'pt-1', name: 'Karen Partner', title: '', company: 'Staging Co', type: 'partner', isDeleted: false },
  { id: 'ct-1', name: 'Carl Contact', title: '', company: '', type: 'contact', isDeleted: false },
]

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
})
let createdBodies: any[] = []
let partnerPosts: any[] = []
let patchBodies: any[] = []
let profilePayload: any = null
const installFetch = () => {
  createdBodies = []
  partnerPosts = []
  patchBodies = []
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/partners') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      partnerPosts.push(body)
      return jsonRes({ id: `pt-new-${partnerPosts.length}`, name: body.name, type: body.type, isDeleted: false }, 201)
    }
    if (u.includes('/api/partners')) return jsonRes(PARTNER_ROWS)
    if (u.includes('/api/leads/') && opts.method === 'PATCH') {
      patchBodies.push(JSON.parse(opts.body))
      return jsonRes({ ok: true })
    }
    if (u.includes('/api/leads') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      createdBodies.push(body)
      return jsonRes({ lead: { id: 'lead-new-1', ...body, is_junk: null, created_at: new Date(now).toISOString(), addresses: [] } }, 201)
    }
    if (u.includes('/profile')) return jsonRes(profilePayload)
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// ── DOM helpers ────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const flush = () => act(async () => {})
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (input: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const selectValue = (sel: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLSelectElement.prototype, 'value')!.set!
  setter.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const buttonContaining = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

beforeEach(() => installFetch())
afterEach(() => { document.body.style.overflow = ''; profilePayload = null })

// Drives the sheet to frame C ('Fresh Person' matches nobody) and flips
// Source to Referral — the picker's partners fetch resolves inside flush.
const openReferralFrameC = async (people: any[]) => {
  const onCreated = vi.fn()
  const mounted = await mount(
    <NewClientSheet people={people} locFilter="loc-uuid-1" currentUserId="user-1" lookupOptions={LOOKUPS} onClose={() => {}} onCreated={onCreated} />
  )
  await type(mounted.host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
  await selectValue(mounted.host.querySelector('select[aria-label="Source"]')!, 'Referral')
  await flush()
  return { ...mounted, onCreated }
}

describe('NewClientSheet — referral picker', () => {
  it("Source='Referral' opens the picker with three populated sections", async () => {
    const sarah = person()
    const { host, unmount } = await openReferralFrameC([sarah])
    expect(host.querySelector('input[aria-label="Search referrers"]')).toBeTruthy()
    const text = host.textContent || ''
    // Section heads + one row from each universe.
    expect(text).toContain('Partners')
    expect(text).toContain('Contacts')
    expect(text).toContain('Clients')
    expect(text).toContain('Karen Partner')
    expect(text).toContain('Carl Contact')
    expect(text).toContain('Sarah Mitchell')
    await unmount()
  })

  it("selecting a CLIENT writes referred_by_kind='lead' + the lead id", async () => {
    const sarah = person()
    const { host, unmount, onCreated } = await openReferralFrameC([sarah])
    await click(buttonContaining(host, 'Sarah Mitchell')!)
    // Chip confirms the pick; the picker closed.
    expect(host.textContent).toContain('Sarah Mitchell')
    expect(host.querySelector('input[aria-label="Search referrers"]')).toBeFalsy()
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies).toHaveLength(1)
    expect(createdBodies[0]).toMatchObject({
      source: 'Referral',
      referred_by_kind: 'lead',
      referred_by_id: sarah.id,
    })
    expect(onCreated).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it("selecting a PARTNER writes referred_by_kind='partner' + the partner id", async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await click(buttonContaining(host, 'Karen Partner')!)
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies[0]).toMatchObject({
      referred_by_kind: 'partner',
      referred_by_id: 'pt-1',
    })
    await unmount()
  })

  it('inline-creates a PARTNER: POST /api/partners type=partner, auto-selected as kind=partner', async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Pro')
    await click(buttonContaining(host, 'as partner')!)
    expect(partnerPosts).toEqual([{ name: 'New Pro', type: 'partner', location_id: 'loc-uuid-1' }])
    expect(host.textContent).toContain('New Pro') // the chip
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies[0]).toMatchObject({
      referred_by_kind: 'partner',
      referred_by_id: 'pt-new-1',
    })
    await unmount()
  })

  it("inline-creates a CONTACT: POST type=contact but STILL kind='partner' (two-value enum)", async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Neighbor')
    await click(buttonContaining(host, 'as contact')!)
    expect(partnerPosts).toEqual([{ name: 'New Neighbor', type: 'contact', location_id: 'loc-uuid-1' }])
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies[0]).toMatchObject({
      referred_by_kind: 'partner', // never a 'contact' kind
      referred_by_id: 'pt-new-1',
    })
    await unmount()
  })

  it('Clients section is MATCH-ONLY: exactly two create rows, none for clients', async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'Somebody')
    const createRows = [...host.querySelectorAll('button')].filter(b => (b.textContent || '').includes('Create “Somebody”'))
    expect(createRows).toHaveLength(2)
    expect(createRows.map(b => b.textContent).join(' ')).not.toContain('client')
    await unmount()
  })

  it("Referral with NO referrer saves nulls — founding isn't blocked", async () => {
    const { host, unmount, onCreated } = await openReferralFrameC([person()])
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies).toHaveLength(1)
    expect(createdBodies[0]).toMatchObject({
      source: 'Referral',
      referred_by_kind: null,
      referred_by_id: null,
    })
    expect(onCreated).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('switching source OFF Referral clears a picked referrer', async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await click(buttonContaining(host, 'Karen Partner')!)
    await selectValue(host.querySelector('select[aria-label="Source"]')!, 'Website')
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies[0]).toMatchObject({
      source: 'Website',
      referred_by_kind: null,
      referred_by_id: null,
    })
    await unmount()
  })
})

// ── ClientProfile display ──────────────────────────────────
const profileWith = (clientOver: any = {}, over: any = {}) => ({
  client: {
    id: 'lead-1', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(90), source: 'Referral', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: 'Client', location_name: 'Denver',
    ...clientOver,
  },
  referred_us: [],
  contacts: [],
  engagements: [],
  touchpoints: [],
  buzz_notes: [],
  job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
  ...over,
})

describe('ClientProfile — referral display', () => {
  it('forward: resolves a PARTNER referrer to a name — "Referred by Karen Partner"', async () => {
    profilePayload = profileWith({ referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred by Karen Partner')
    expect(host.textContent).not.toContain('Referred via')
    await unmount()
  })

  it('forward: resolves a LEAD referrer to a name — "Referred by Sarah Mitchell"', async () => {
    profilePayload = profileWith({ referred_by_kind: 'lead', referred_by_id: 'p-1', referred_by_name: 'Sarah Mitchell' })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred by Sarah Mitchell')
    await unmount()
  })

  it('forward: dangling referrer id degrades to the kind, never blank', async () => {
    profilePayload = profileWith({ referred_by_kind: 'partner', referred_by_id: 'gone', referred_by_name: null })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred by a partner')
    await unmount()
  })

  it('reverse: "Referred us" lists the people this client referred', async () => {
    profilePayload = profileWith({}, {
      referred_us: [
        { id: 'r1', name: 'Alice Alvarez', created_at: daysAgo(10) },
        { id: 'r2', name: 'Bob Baker', created_at: daysAgo(3) },
      ],
    })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred us · 2')
    expect(host.textContent).toContain('Alice Alvarez')
    expect(host.textContent).toContain('Bob Baker')
    await unmount()
  })

  it('reverse: section hidden entirely when nobody was referred', async () => {
    profilePayload = profileWith()
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).not.toContain('Referred us')
    await unmount()
  })
})

// ── ClientProfile edit surface (existing leads) ────────────
const mountProfile = async (clientOver: any = {}, people: any[] = []) => {
  profilePayload = profileWith(clientOver)
  const mounted = await mount(<ClientProfile clientId="lead-1" people={people} onClose={() => {}} />)
  await flush()
  return mounted
}

describe('ClientProfile — referrer add/edit/clear on an existing lead', () => {
  it("no referrer: 'Add referrer' opens the picker; picking a partner PATCHes kind+id AND source='Referral'; the line updates", async () => {
    const sarah = person()
    const { host, unmount } = await mountProfile({ source: 'webform' }, [sarah])
    expect(host.textContent).toContain('Source: webform')
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush() // partners fetch
    expect(host.querySelector('input[aria-label="Search referrers"]')).toBeTruthy()
    await click(buttonContaining(host, 'Karen Partner')!)
    // Exact body — the source coupling must ride the SAME patch.
    expect(patchBodies).toEqual([{ referred_by_kind: 'partner', referred_by_id: 'pt-1', source: 'Referral' }])
    expect(host.textContent).toContain('Referred by Karen Partner')
    expect(host.querySelector('input[aria-label="Search referrers"]')).toBeFalsy() // picker closed
    await unmount()
  })

  it("existing referrer: edit swaps to a CLIENT referrer — PATCH kind='lead' + the lead id", async () => {
    const sarah = person()
    const { host, unmount } = await mountProfile(
      { referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' },
      [sarah],
    )
    await click(host.querySelector('button[aria-label="Edit referrer"]')!)
    await flush()
    await click(buttonContaining(host, 'Sarah Mitchell')!)
    expect(patchBodies).toEqual([{ referred_by_kind: 'lead', referred_by_id: sarah.id, source: 'Referral' }])
    expect(host.textContent).toContain('Referred by Sarah Mitchell')
    await unmount()
  })

  it('clear nulls BOTH fields and does NOT revert source (the asymmetry)', async () => {
    const { host, unmount } = await mountProfile(
      { source: 'Referral', referred_by_kind: 'partner', referred_by_id: 'pt-1', referred_by_name: 'Karen Partner' },
    )
    await click(host.querySelector('button[aria-label="Clear referrer"]')!)
    // Exact body — no source key may appear in the clear patch.
    expect(patchBodies).toEqual([{ referred_by_kind: null, referred_by_id: null }])
    expect(host.textContent).not.toContain('Referred by')
    expect(host.textContent).toContain('Source: referral') // untouched
    await unmount()
  })

  it("inline-create works from the profile too: contact → POST /api/partners then PATCH kind='partner'", async () => {
    const { host, unmount } = await mountProfile({ source: 'webform' })
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Neighbor')
    await click(buttonContaining(host, 'as contact')!)
    expect(partnerPosts).toEqual([{ name: 'New Neighbor', type: 'contact', location_id: 'loc-uuid-1' }])
    expect(patchBodies).toEqual([{ referred_by_kind: 'partner', referred_by_id: 'pt-new-1', source: 'Referral' }])
    expect(host.textContent).toContain('Referred by New Neighbor')
    await unmount()
  })

  it('the client never appears as their own referrer option', async () => {
    const self = person({ id: 'lead-1', name: 'Dana Client' })
    const other = person({ name: 'Other Person' })
    const { host, unmount } = await mountProfile({ source: 'webform' }, [self, other])
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    const rowButtons = [...host.querySelectorAll('button')].filter(b => (b.textContent || '').includes('Dana Client'))
    expect(rowButtons).toHaveLength(0)
    expect(buttonContaining(host, 'Other Person')).toBeTruthy()
    await unmount()
  })
})
