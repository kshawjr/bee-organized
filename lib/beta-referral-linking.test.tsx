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
import { mergePartnerRow } from '@/lib/crm'
import { readFileSync } from 'node:fs'

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
let partnerPostFail = false
const installFetch = () => {
  createdBodies = []
  partnerPosts = []
  patchBodies = []
  partnerPostFail = false
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/partners') && opts.method === 'POST') {
      if (partnerPostFail) return jsonRes({ error: 'forbidden' }, 403)
      const body = JSON.parse(opts.body)
      partnerPosts.push(body)
      return jsonRes({ id: `pt-new-${partnerPosts.length}`, name: body.name, type: body.type, locationId: body.location_id, isDeleted: false }, 201)
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
  it("Source='Referral' opens the picker with the merged Network section + Clients (Phase 2)", async () => {
    const sarah = person()
    const { host, unmount } = await openReferralFrameC([sarah])
    expect(host.querySelector('input[aria-label="Search referrers"]')).toBeTruthy()
    const text = host.textContent || ''
    // ONE merged Network section (partner + legacy contact rows together)
    // + the match-only Clients section. The type split is gone.
    expect(text).toContain('Network')
    expect(text).toContain('Clients')
    expect(text).not.toContain('Partners')
    expect(text).toContain('Karen Partner')
    expect(text).toContain('Carl Contact')  // legacy type='contact' — same pool
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

  it('inline-creates a NETWORK row: ONE create door, POST type=partner, auto-selected as kind=partner', async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Pro')
    await click(buttonContaining(host, 'to your network')!)
    // stage seed: picker-born partners start INSIDE the pipeline — a NULL
    // stage matches no stage filter and hides from every saved view.
    expect(partnerPosts).toEqual([{ name: 'New Pro', type: 'partner', location_id: 'loc-uuid-1', stage: 'New Contact' }])
    expect(host.textContent).toContain('New Pro') // the chip
    await click(buttonByText(host, 'Create — opens card')!)
    expect(createdBodies[0]).toMatchObject({
      referred_by_kind: 'partner',
      referred_by_id: 'pt-new-1',
    })
    await unmount()
  })

  it('Clients section is MATCH-ONLY: exactly one create row (network), none for clients', async () => {
    const { host, unmount } = await openReferralFrameC([person()])
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'Somebody')
    const createRows = [...host.querySelectorAll('button')].filter(b => (b.textContent || '').includes('“Somebody”'))
    expect(createRows).toHaveLength(1)
    expect(createRows[0].textContent).toContain('to your network')
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

  it('forward: route-flagged removed referrer says "a removed referrer"', async () => {
    profilePayload = profileWith({ referred_by_kind: 'partner', referred_by_id: 'gone', referred_by_name: null, referred_by_missing: true })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred by a removed referrer')
    await unmount()
  })

  it('reverse: total count comes from referred_us_total, not the row count', async () => {
    // 7 rows returned, but the client actually referred 300 (past the
    // fetch ceiling). Header shows the true total; "show more" reveals
    // the rest of the page; the truncation note is honest about the cap.
    const rows = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, name: `Ref ${i}`, created_at: daysAgo(i) }))
    profilePayload = profileWith({}, { referred_us: rows, referred_us_total: 300 })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred us · 300')
    // First 6 shown, one collapsed behind "Show 1 more".
    expect(host.textContent).toContain('Ref 0')
    expect(host.textContent).not.toContain('Ref 6')
    const more = buttonContaining(host, 'Show 1 more')!
    expect(more).toBeTruthy()
    await click(more)
    expect(host.textContent).toContain('Ref 6')
    expect(host.textContent).toContain('Showing first 7 of 300')
    await unmount()
  })

  it('reverse: no "show more" and no total-fallback drama for a small list', async () => {
    profilePayload = profileWith({}, {
      referred_us: [{ id: 'r1', name: 'Alice Alvarez', created_at: daysAgo(10) }],
      referred_us_total: 1,
    })
    const { host, unmount } = await mount(<ClientProfile clientId="lead-1" onClose={() => {}} />)
    await flush()
    expect(host.textContent).toContain('Referred us · 1')
    const showMore = [...host.querySelectorAll('button')].find(b => /Show \d+ more/.test(b.textContent || ''))
    expect(showMore).toBeFalsy()
    expect(host.textContent).not.toContain('Showing first')
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
  // Since 7/23 the field only mounts on a referral-sourced lead
  // (beta-referrer-visibility). Starting from the VARIANT label proves
  // two things at once: the gate accepts an admin lookup that isn't the
  // canonical spelling, and the write still canonicalizes to 'Referral'.
  it("no referrer: 'Add referrer' opens the picker; picking a partner PATCHes kind+id AND source='Referral'; the line updates", async () => {
    const sarah = person()
    const { host, unmount } = await mountProfile({ source: 'Client Referral' }, [sarah])
    expect(host.textContent).toContain('Source: Client Referral')
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
    // untouched (raw label since the editable SourceField — no more lowercasing)
    expect(host.textContent).toContain('Source: Referral')
    await unmount()
  })

  it("inline-create works from the profile too: one network door → POST /api/partners then PATCH kind='partner'", async () => {
    const { host, unmount } = await mountProfile({ source: 'Referral' })
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Neighbor')
    await click(buttonContaining(host, 'to your network')!)
    expect(partnerPosts).toEqual([{ name: 'New Neighbor', type: 'partner', location_id: 'loc-uuid-1', stage: 'New Contact' }])
    expect(patchBodies).toEqual([{ referred_by_kind: 'partner', referred_by_id: 'pt-new-1', source: 'Referral' }])
    expect(host.textContent).toContain('Referred by New Neighbor')
    await unmount()
  })

  it('the client never appears as their own referrer option', async () => {
    const self = person({ id: 'lead-1', name: 'Dana Client' })
    const other = person({ name: 'Other Person' })
    const { host, unmount } = await mountProfile({ source: 'Referral' }, [self, other])
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    const rowButtons = [...host.querySelectorAll('button')].filter(b => (b.textContent || '').includes('Dana Client'))
    expect(rowButtons).toHaveLength(0)
    expect(buttonContaining(host, 'Other Person')).toBeTruthy()
    await unmount()
  })
})

// ── onPartnerCreated seam (Classic visibility for beta creates) ─────
describe('onPartnerCreated seam', () => {
  it('NewClientSheet inline-create hands the CONFIRMED row up (real id/type/location, not a stub)', async () => {
    const onPartnerCreated = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" lookupOptions={LOOKUPS}
        onClose={() => {}} onCreated={() => {}} onPartnerCreated={onPartnerCreated} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
    await selectValue(host.querySelector('select[aria-label="Source"]')!, 'Referral')
    await flush()
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Pro')
    await click(buttonContaining(host, 'to your network')!)
    expect(onPartnerCreated).toHaveBeenCalledTimes(1)
    // The POST response verbatim — id/type/locationId from the server.
    expect(onPartnerCreated.mock.calls[0][0]).toMatchObject({
      id: 'pt-new-1', type: 'partner', locationId: 'loc-uuid-1', name: 'New Pro',
    })
    await unmount()
  })

  it('create failure surfaces a toast AND a visible inline error — never a silent no-op', async () => {
    const onPartnerCreated = vi.fn()
    const setToast = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} locFilter="loc-uuid-1" currentUserId="user-1" lookupOptions={LOOKUPS}
        onClose={() => {}} onCreated={() => {}} onPartnerCreated={onPartnerCreated} setToast={setToast} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
    await selectValue(host.querySelector('select[aria-label="Source"]')!, 'Referral')
    await flush()
    partnerPostFail = true
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'Doomed')
    await click(buttonContaining(host, 'to your network')!)
    expect(onPartnerCreated).not.toHaveBeenCalled() // no phantom rows on failure
    expect(setToast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', msg: expect.stringContaining('partner') }))
    expect(host.textContent).toContain('Create failed')
    await unmount()
  })

  it('§8.5: the picker/field reach Classic ONLY via the callback — no PartnersContext/BeeHub imports', () => {
    for (const f of ['components/hive/ReferrerPicker.jsx', 'components/hive/shared/ReferrerField.jsx']) {
      const src = readFileSync(f, 'utf8')
      // Imports only — comments may (and do) mention the rule by name.
      const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
      expect(importLines, f).not.toContain('PartnersContext')
      expect(importLines, f).not.toContain('BeeHub')
      expect(src, f).not.toContain('useContext') // no ambient state at all
      expect(src).toContain('onPartnerCreated')
    }
  })
})

// ── mergePartnerRow — BeeHub's state-only merge (the seam's Classic half)
describe('mergePartnerRow', () => {
  const existing = [{ id: 'pt-1', name: 'Karen Partner', type: 'partner', locationId: 'loc-uuid-1' }]

  it('prepends a confirmed row; dedups by id; ignores rows without an id', () => {
    const row = { id: 'pt-new-1', name: 'New Pro', type: 'partner', locationId: 'loc-uuid-1' }
    const merged = mergePartnerRow(existing, row)
    expect(merged.map(p => p.id)).toEqual(['pt-new-1', 'pt-1'])
    expect(mergePartnerRow(merged, row)).toBe(merged) // idempotent — no duplicate
    expect(mergePartnerRow(existing, { name: 'no id' })).toBe(existing)
    expect(mergePartnerRow(existing, null)).toBe(existing)
  })

  it("lands in the ONE merged Network pool — the partner/contact type split is gone (Phase 2)", () => {
    const merged = mergePartnerRow(
      mergePartnerRow(existing, { id: 'pt-new-1', name: 'New Pro', type: 'partner', locationId: 'loc-uuid-1' }),
      { id: 'ct-new-1', name: 'New Neighbor', type: 'contact', locationId: 'loc-uuid-1' },
    )
    // The Network list's exact scoping: locFilter + isDeleted, NO type
    // filter — a legacy 'contact' row and a 'partner' row sit in the same
    // pool (both store referred_by_kind='partner' when picked).
    const locFilter = 'loc-uuid-1'
    const networkPool = (locFilter === 'all' ? merged : merged.filter((p: any) => p.locationId === locFilter)).filter((p: any) => !p.isDeleted)
    expect(networkPool.map((p: any) => p.name)).toEqual(['New Neighbor', 'New Pro', 'Karen Partner'])
    // And a location-scoped view elsewhere hides it — correct scoping.
    const otherLoc = merged.filter((p: any) => p.locationId === 'loc-uuid-2')
    expect(otherLoc).toEqual([])
  })
})

