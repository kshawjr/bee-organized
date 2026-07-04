// @vitest-environment happy-dom
// Lead-detail card field edits (PersonCard / EngagementPanel /
// ClientProfile). Covers the three-fix batch:
//   FIX 1 — ReferrerField extraction: the shared referrer add/edit/clear
//     renders on PersonCard AND EngagementPanel (ClientProfile's own
//     rendering is covered in beta-referral-linking.test.tsx post-
//     refactor); EngagementPanel writes the LEAD's columns via
//     PATCH /api/leads/<lead id>, never an engagement field.
//   FIX 2 — display updates optimistically on save (Source pill flips
//     immediately), reverts on PATCH failure, and the confirmed patch
//     propagates out through onLeadPatched (the shell→people seam) +
//     the leadColsToPersonFields translator.
//   FIX 3 — every meta select offers None; picking it PATCHes null and
//     the display clears (no stale person-prop resurface); Source can be
//     cleared independently AFTER the referrer coupling set it — the
//     coupling never re-locks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import PersonCard from '@/components/hive/PersonCard'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'lead-9',
  name: 'Dana Client',
  email: 'dana@x.com',
  phone: '(561) 555-0100',
  source: 'Webform',
  locationId: 'loc-uuid-1',
  created: daysAgo(40),
  isJunk: false,
  outreachTimeline: [],
  ...over,
})

const LOOKUPS = { sources: ['Webform', 'Website', 'Referral'], projectTypes: ['Client', 'Move'] }

const PARTNER_ROWS = [
  { id: 'pt-1', name: 'Karen Partner', title: '', company: 'Staging Co', type: 'partner', isDeleted: false },
]

const profilePayload = (clientOver: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(40), source: 'Webform', paused: false, marketing_opt_out: false,
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
})

const engagementPayload = () => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(5), stage_entered_at: daysAgo(5), location_uuid: 'loc-uuid-1',
    project_type: 'Client', description: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: null,
    request_details: null, source: 'Webform',
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  },
})

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let leadPatches: Array<{ url: string, body: any }> = []
let engPatches: any[] = []
let partnerPosts: any[] = []
let leadPatchFail = false
const installFetch = () => {
  leadPatches = []
  engPatches = []
  partnerPosts = []
  leadPatchFail = false
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/partners') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      partnerPosts.push(body)
      return jsonRes({ id: `pt-new-${partnerPosts.length}`, name: body.name, type: body.type, isDeleted: false }, 201)
    }
    if (u.includes('/api/partners')) return jsonRes(PARTNER_ROWS)
    if (u.includes('/api/leads/') && opts.method === 'PATCH') {
      if (leadPatchFail) return jsonRes({ error: 'boom' }, 500)
      leadPatches.push({ url: u, body: JSON.parse(opts.body) })
      return jsonRes({ ok: true })
    }
    if (u.includes('/api/engagements/') && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body)
      engPatches.push(body)
      return jsonRes({
        id: 'eng-1', stage: 'Request', prev_stage: 'Request', title: 'Kitchen + Pantry',
        description: body.description ?? null,
        project_type: body.project_type !== undefined ? body.project_type : 'Client',
        changed: true,
      })
    }
    if (u.includes('/api/engagements/')) return jsonRes(engagementPayload())
    if (u.includes('/profile')) return jsonRes(profilePayload())
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
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const buttonContaining = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

beforeEach(() => installFetch())
afterEach(() => { document.body.style.overflow = '' })

// ═══ the translator (the propagation seam's pure half) ═════
describe('leadColsToPersonFields', () => {
  it('maps the edited columns to Person keys and DROPS unknowns', () => {
    expect(leadColsToPersonFields({
      source: 'Referral',
      project_type: 'Move',
      referred_by_kind: 'partner',
      referred_by_id: 'pt-1',
      referred_by_name: 'Karen', // display-only column name — not a Person key
      totally_unknown: 'x',
    })).toEqual({
      source: 'Referral',
      project: 'Move',
      referredByKind: 'partner',
      referredBy: 'pt-1',
    })
  })

  it('carries nulls through (a None-clear must propagate as null, not vanish)', () => {
    expect(leadColsToPersonFields({ source: null })).toEqual({ source: null })
  })
})

// ═══ PersonCard ════════════════════════════════════════════
const mountPersonCard = async (over: any = {}) => {
  const onLeadPatched = vi.fn()
  const setToast = vi.fn()
  const mounted = await mount(
    <PersonCard person={person()} people={[person({ id: 'p-other', name: 'Other Person' })]}
      onClose={() => {}} setToast={setToast} onLeadPatched={onLeadPatched} lookupOptions={LOOKUPS} {...over} />
  )
  await flush() // profile fetch
  return { ...mounted, onLeadPatched, setToast }
}

describe('PersonCard — field edits', () => {
  it('Source pick updates the pill IMMEDIATELY, PATCHes the lead, and propagates via onLeadPatched', async () => {
    const { host, unmount, onLeadPatched } = await mountPersonCard()
    await click(buttonContaining(host, 'Source: Webform')!)
    await click(buttonByText(host, 'Website')!)
    expect(buttonContaining(host, 'Source: Website')).toBeTruthy() // optimistic
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { source: 'Website' } }])
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { source: 'Website' })
    await unmount()
  })

  it('reverts the display and toasts on PATCH failure — no propagation', async () => {
    const { host, unmount, onLeadPatched, setToast } = await mountPersonCard()
    leadPatchFail = true
    await click(buttonContaining(host, 'Source: Webform')!)
    await click(buttonByText(host, 'Website')!)
    expect(buttonContaining(host, 'Source: Webform')).toBeTruthy() // reverted
    expect(onLeadPatched).not.toHaveBeenCalled()
    expect(setToast).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
    await unmount()
  })

  it('None clears Source: PATCH null, pill shows the empty state — the stale person-prop never resurfaces', async () => {
    const { host, unmount } = await mountPersonCard()
    await click(buttonContaining(host, 'Source: Webform')!)
    await click(buttonByText(host, 'None')!)
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { source: null } }])
    // person.source is 'Webform' — the old ?? fallback would show it again.
    expect(buttonContaining(host, 'Source: Webform')).toBeFalsy()
    expect(buttonContaining(host, 'Source · add')).toBeTruthy()
    await unmount()
  })

  it('None clears Type too: PATCH { project_type: null }', async () => {
    const { host, unmount } = await mountPersonCard()
    await click(buttonContaining(host, 'Type: Client')!)
    await click(buttonByText(host, 'None')!)
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { project_type: null } }])
    expect(buttonContaining(host, 'Type · add')).toBeTruthy()
    await unmount()
  })

  it('has the shared ReferrerField: add referrer PATCHes kind+id AND source (the coupling)', async () => {
    const { host, unmount, onLeadPatched } = await mountPersonCard()
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush() // partners fetch
    await click(buttonContaining(host, 'Karen Partner')!)
    expect(leadPatches).toEqual([{
      url: expect.stringContaining('/api/leads/lead-9'),
      body: { referred_by_kind: 'partner', referred_by_id: 'pt-1', source: 'Referral' },
    }])
    expect(host.textContent).toContain('Referred by Karen Partner')
    expect(buttonContaining(host, 'Source: Referral')).toBeTruthy() // coupling reflected on the pill
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { referred_by_kind: 'partner', referred_by_id: 'pt-1', source: 'Referral' })
    await unmount()
  })

  it('inline-create from the card hands the CONFIRMED partner row up onPartnerCreated (the Classic seam)', async () => {
    const onPartnerCreated = vi.fn()
    const { host, unmount } = await mountPersonCard({ onPartnerCreated })
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await type(host.querySelector('input[aria-label="Search referrers"]')!, 'New Neighbor')
    await click(buttonContaining(host, 'as contact')!)
    expect(onPartnerCreated).toHaveBeenCalledTimes(1)
    expect(onPartnerCreated.mock.calls[0][0]).toMatchObject({ id: 'pt-new-1', type: 'contact', name: 'New Neighbor' })
    await unmount()
  })

  it("the coupling doesn't re-lock: Source clears to None AFTER a referrer set it, referrer stays", async () => {
    const { host, unmount } = await mountPersonCard()
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await click(buttonContaining(host, 'Karen Partner')!)
    await click(buttonContaining(host, 'Source: Referral')!)
    await click(buttonByText(host, 'None')!)
    expect(leadPatches[1]).toEqual({ url: expect.stringContaining('/api/leads/lead-9'), body: { source: null } })
    expect(buttonContaining(host, 'Source · add')).toBeTruthy()
    expect(host.textContent).toContain('Referred by Karen Partner') // untouched
    await unmount()
  })
})

// ═══ EngagementPanel ═══════════════════════════════════════
const mountPanel = async () => {
  const onLeadPatched = vi.fn()
  const setToast = vi.fn()
  const mounted = await mount(
    <EngagementPanel engagementId="eng-1" people={[person({ id: 'p-other', name: 'Other Person' })]}
      onClose={() => {}} setToast={setToast} onLeadPatched={onLeadPatched} lookupOptions={LOOKUPS} />
  )
  await flush() // engagement fetch
  return { ...mounted, onLeadPatched, setToast }
}

describe('EngagementPanel — field edits', () => {
  it('Source pick updates immediately and PATCHes the LEAD (client id), propagating out', async () => {
    const { host, unmount, onLeadPatched } = await mountPanel()
    await click(buttonContaining(host, 'Source: Webform')!)
    await click(buttonByText(host, 'Website')!)
    expect(buttonContaining(host, 'Source: Website')).toBeTruthy()
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { source: 'Website' } }])
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { source: 'Website' })
    await unmount()
  })

  it('Type None PATCHes the ENGAGEMENT with project_type null and the pill clears', async () => {
    const { host, unmount } = await mountPanel()
    await click(buttonContaining(host, 'Type: Client')!)
    await click(buttonByText(host, 'None')!)
    expect(engPatches).toEqual([{ project_type: null }])
    expect(leadPatches).toEqual([]) // engagement field — never the lead's
    expect(buttonContaining(host, 'Type · add')).toBeTruthy()
    await unmount()
  })

  it("has the shared ReferrerField and writes the LEAD's columns — /api/leads/<lead id>, never an engagement field", async () => {
    const { host, unmount, onLeadPatched } = await mountPanel()
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await click(buttonContaining(host, 'Karen Partner')!)
    expect(leadPatches).toEqual([{
      url: expect.stringContaining('/api/leads/lead-9'), // the lead beneath, NOT eng-1
      body: { referred_by_kind: 'partner', referred_by_id: 'pt-1', source: 'Referral' },
    }])
    expect(engPatches).toEqual([])
    expect(host.textContent).toContain('Referred by Karen Partner')
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { referred_by_kind: 'partner', referred_by_id: 'pt-1', source: 'Referral' })
    await unmount()
  })

  it('clear from the panel nulls the referrer fields only (source untouched)', async () => {
    const { host, unmount } = await mountPanel()
    await click(host.querySelector('button[aria-label="Add referrer"]')!)
    await flush()
    await click(buttonContaining(host, 'Karen Partner')!)
    await click(host.querySelector('button[aria-label="Clear referrer"]')!)
    expect(leadPatches[1].body).toEqual({ referred_by_kind: null, referred_by_id: null })
    expect(buttonContaining(host, 'Source: Referral')).toBeTruthy() // not reverted
    await unmount()
  })
})
