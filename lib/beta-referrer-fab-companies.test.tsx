// @vitest-environment happy-dom
//
// Referrer field follow-ups after the Network merge — MOUNT tests (per the
// allOverview lesson), not source pins. Three gaps closed:
//
//   1) THE MOBILE FAB — Home's quick-capture FAB (phones only; hidden
//      ≥768px) opened Classic NewLeadModal, the last REACHABLE mount of the
//      pre-merge referrer picker. It now opens the beta NewClientSheet —
//      the same create experience the desktop shell's ＋ opens.
//   2) COMPANIES AS REFERRERS — referred_by_kind='company' was accepted by
//      validation and resolved by both read routes, but no UI could produce
//      the row. ReferrerPicker now has a Companies section (kind='company');
//      the round-trip's server half is network-company-referral-roundtrip.
//   3) THE CREATE DOOR'S STAGE — the picker's one-tap "＋ Add … to your
//      network" now seeds stage='New Contact' (POST-body pin lives in
//      beta-referral-linking); HERE the mount-level consequence: a
//      picker-created-shaped row matches a stage-filtered saved view, while
//      a legacy NULL-stage row is exactly the invisible one.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

import App, { PartnersScreen } from '@/components/BeeHub'
import NewClientSheet from '@/components/hive/NewClientSheet'
import ReferrerField from '@/components/hive/shared/ReferrerField'

const LOC = 'loc-uuid-1'
const LOOKUPS = { sources: ['Manual', 'Website', 'Referral'], projectTypes: ['Client'] }
const PARTNER_ROWS = [
  { id: 'pt-1', name: 'Karen Partner', title: '', company: 'Staging Co', type: 'partner', isDeleted: false },
]
const COMPANY_ROWS = [
  { id: 'co-1', name: 'Acme Restoration', industry: 'Restoration', isDeleted: false },
  { id: 'co-dead', name: 'Ghost Corp', industry: '', isDeleted: true },
]

// ── fetch mock (referral-linking pattern, + /api/companies) ────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let createdBodies: any[] = []
let patchBodies: any[] = []
const installFetch = () => {
  createdBodies = []
  patchBodies = []
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/companies')) return jsonRes(COMPANY_ROWS)
    if (u.includes('/api/partners') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      return jsonRes({ id: 'pt-new-1', name: body.name, type: body.type, stage: body.stage, isDeleted: false }, 201)
    }
    if (u.includes('/api/partners')) return jsonRes(PARTNER_ROWS)
    if (u.includes('/api/leads/') && opts.method === 'PATCH') {
      patchBodies.push(JSON.parse(opts.body))
      return jsonRes({ ok: true })
    }
    if (u.includes('/api/leads') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      createdBodies.push(body)
      return jsonRes({ lead: { id: 'lead-new-1', ...body, is_junk: null, created_at: new Date().toISOString(), addresses: [] } }, 201)
    }
    if (u.includes('/api/lookups')) return jsonRes({ lookups: [
      { category: 'lead_sources', label: 'Manual', is_active: true },
      { category: 'lead_sources', label: 'Referral', is_active: true },
      { category: 'project_types', label: 'Client', is_active: true },
    ] })
    if (u.includes('/api/network/summary')) return jsonRes({ referrers: [], totals: { count: 0, converted: 0, revenue: 0 } })
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// happy-dom v20 ships no localStorage — stub (established pattern).
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

// ── DOM helpers ────────────────────────────────────────────
let cleanup: Array<() => void> = []
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(ui) })
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}
const flush = (rounds = 4) => (async () => {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
})()
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
const buttonContaining = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

beforeEach(() => {
  installFetch()
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
})
afterEach(() => {
  cleanup.forEach(fn => fn())
  cleanup = []
  document.body.style.overflow = ''
  vi.unstubAllGlobals()
})

// ═══ 1) The mobile FAB opens the BETA create flow ═══════════════════
describe('Home quick-capture FAB', () => {
  const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
  const appProps = {
    initialRoute: 'home',
    initialRole: 'franchise',
    initialFranchiseRole: 'owner',
    initialLocFilter: KC,
    initialScopeLocationId: KC,
    initialAllOverview: null,
    initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
    initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
    initialPeople: [], initialBinPeople: [], initialTransferPeople: [], initialEngagements: [],
    initialPartners: [], initialCompanies: [], initialGuideSlides: [], initialManualSlides: [],
    initialTierPrices: [],
    currentUser: { id: 'u2', email: 'owner@x.com', name: 'Owner', role: 'owner', locationId: KC },
    currentLocation: { id: KC, name: 'Kansas City', jobber_connected: false, jobber_account_id: null, last_sync_status: null, token_expiry: null },
    currentSubscription: null,
  }

  it('opens NewClientSheet (beta), not Classic Quick Capture', async () => {
    const host = await mount(React.createElement(App as any, appProps))
    await flush(8)
    const fab = document.querySelector('.mobile-fab')
    expect(fab).toBeTruthy()
    await click(fab!)
    await flush()
    // Beta sheet marker: the anti-dupe lookup field frame A always renders.
    expect(document.querySelector('input[aria-label="Search clients"]')).toBeTruthy()
    // Classic NewLeadModal's quick phase is gone from the FAB path — the
    // last reachable mount of the pre-merge referrer picker.
    expect(document.body.textContent).not.toContain('Quick Capture')
    expect(host.textContent).toBeTruthy()
  })

  it('the sheet reaches the MERGED referrer picker (Network + Companies + Clients)', async () => {
    await mount(React.createElement(App as any, appProps))
    await flush(8)
    await click(document.querySelector('.mobile-fab')!)
    await flush()
    await type(document.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
    await flush()
    await selectValue(document.querySelector('select[aria-label="Source"]')!, 'Referral')
    await flush()
    // Selecting Referral auto-opens the merged picker (same behavior the
    // desktop shell's sheet has — one create experience, both form factors).
    expect(document.querySelector('input[aria-label="Search referrers"]')).toBeTruthy()
    const text = document.body.textContent || ''
    expect(text).toContain('Companies')
    expect(text).toContain('Acme Restoration')
  })
})

// ═══ 2) Companies are selectable referrers (kind='company') ═════════
describe('ReferrerPicker — Companies section', () => {
  const person = { id: 'p-1', name: 'Sarah Mitchell', email: 'sarah@email.com', phone: '(561) 555-0199', locationId: LOC, created: new Date().toISOString(), isJunk: false, outreachTimeline: [] }

  const openReferralFrameC = async () => {
    const host = await mount(
      <NewClientSheet people={[person]} locFilter={LOC} currentUserId="user-1" lookupOptions={LOOKUPS} onClose={() => {}} onCreated={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'Fresh Person')
    await selectValue(host.querySelector('select[aria-label="Source"]')!, 'Referral')
    await flush()
    return host
  }

  it('renders the Companies section; deleted companies excluded', async () => {
    const host = await openReferralFrameC()
    const text = host.textContent || ''
    expect(text).toContain('Companies')
    expect(text).toContain('Acme Restoration')
    expect(text).toContain('Restoration')          // the industry sub-line
    expect(text).not.toContain('Ghost Corp')       // deleted_at rows never render
  })

  it("selecting a company → create POST carries referred_by_kind='company' + the company id", async () => {
    const host = await openReferralFrameC()
    await click(buttonContaining(host, 'Acme Restoration')!)
    // Picked chip replaces the picker.
    expect(host.textContent).toContain('Acme Restoration')
    await click(buttonContaining(host, 'Create — opens card')!)
    await flush()
    expect(createdBodies).toHaveLength(1)
    expect(createdBodies[0]).toMatchObject({
      referred_by_kind: 'company',
      referred_by_id: 'co-1',
      source: 'Referral',
    })
  })

  it("EDIT surface (ReferrerField): picking a company PATCHes kind='company' + source coupling", async () => {
    const lead = { id: 'lead-77', referred_by_kind: null, referred_by_id: null, referred_by_name: null, source: 'Webform' }
    const host = await mount(
      <ReferrerField lead={lead} locationUuid={LOC} people={[]} />
    )
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await click(buttonContaining(host, 'Acme Restoration')!)
    await flush()
    expect(patchBodies).toEqual([
      { referred_by_kind: 'company', referred_by_id: 'co-1', source: 'Referral' },
    ])
  })

  it("display fallback: a name-less company referrer reads 'a company', not 'a partner'", async () => {
    const lead = { id: 'lead-78', referred_by_kind: 'company', referred_by_id: 'co-1', referred_by_name: null, source: 'Referral' }
    const host = await mount(
      <ReferrerField lead={lead} locationUuid={LOC} people={[]} />
    )
    expect(host.textContent).toContain('Referred by a company')
  })
})

// ═══ 3) Picker-created partners match stage-filtered views ══════════
describe('stage seed — created partners are visible to stage filters', () => {
  const VIEWS_KEY = 'bee_network_saved_views'
  // Shaped exactly like the picker's create round-trip: POST body
  // { name, type:'partner', stage:'New Contact' } → mapPartnerRow client row.
  const pickerBorn = { id: 'pt-new-1', name: 'Fresh Referrer', type: 'partner', stage: 'New Contact', title: '', company: '', specialties: [], tags: [], isDeleted: false }
  // The pre-fix shape: stage NULL → matches no stage filter (the bug).
  const nullStage = { id: 'pt-old-1', name: 'Invisible Ida', type: 'partner', stage: '', title: '', company: '', specialties: [], tags: [], isDeleted: false }

  it("a 'New Contact' saved view shows the picker-born row and hides the NULL-stage one", async () => {
    lsStore.set(VIEWS_KEY, JSON.stringify({
      views: [{ id: 'v1', name: 'Fresh Contacts', filters: { stageFilter: 'New Contact', tierFilter: '', specFilter: '', tagFilter: '' } }],
      activeViewId: null,
    }))
    const host = await mount(
      <PartnersScreen onNavigate={() => {}} partners={[pickerBorn, nullStage]} setPartners={() => {}} companies={[]} />
    )
    await flush()
    // Bands start collapsed — expand every band header before reading rows.
    const expandAll = async () => {
      for (const hdr of [...host.querySelectorAll('[role="button"][aria-expanded="false"]')]) {
        await click(hdr)
      }
      await flush()
    }
    await expandAll()
    // Unfiltered: both render.
    expect(host.textContent).toContain('Fresh Referrer')
    expect(host.textContent).toContain('Invisible Ida')
    // Apply the stage-filtered saved view.
    const pill = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Fresh Contacts')
    expect(pill).toBeTruthy()
    await click(pill!)
    await flush()
    await expandAll()
    expect(host.textContent).toContain('Fresh Referrer')      // seeded stage matches
    expect(host.textContent).not.toContain('Invisible Ida')   // NULL stage = invisible (the bug this pins)
  })
})
