// @vitest-environment happy-dom
// Lead-detail card field edits (EngagementPanel + the shared
// leadColsToPersonFields translator). The old PersonCard field-edit
// describes retired with the component (#136) — the live-surface
// equivalents are beta-card-restore (ClientProfile SourceField:
// optimistic PATCH + None-clear) and beta-referral-linking
// (ClientProfile referrer add/edit/clear incl. the source coupling and
// inline-create).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
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
// The client columns the /profile fetch answers with. Tests that drive
// the referrer flow set a referral source here — since 7/23 the field
// only mounts on a referral-sourced lead (beta-referrer-visibility).
let profileClientOver: any = {}
const installFetch = () => {
  leadPatches = []
  engPatches = []
  partnerPosts = []
  leadPatchFail = false
  profileClientOver = {}
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
    if (u.includes('/profile')) return jsonRes(profilePayload(profileClientOver))
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
  it('Source pill is GONE from the panel (single home since card-restore 1: ClientProfile — source is person-scoped first-touch)', async () => {
    const { host, unmount } = await mountPanel()
    expect(buttonContaining(host, 'Source: Webform')).toBeUndefined()
    expect(buttonContaining(host, 'Source · add')).toBeUndefined()
    // Type stays — deal-scoped, riding the header area now as a quiet
    // editable meta value (no bordered "Type: …" box).
    const typeCell = host.querySelector('[aria-label="Edit type"]')!
    expect(typeCell).toBeTruthy()
    expect(typeCell.textContent).toContain('Client')
    // The lead-level Source WRITE path lives on ClientProfile's
    // SourceField (beta-card-restore covers it).
    await unmount()
  })

  it('Type None PATCHes the ENGAGEMENT with project_type null and the value clears to the empty state', async () => {
    const { host, unmount } = await mountPanel()
    await click(host.querySelector('[aria-label="Edit type"]') as HTMLElement)
    await click(buttonByText(host, 'None')!)
    expect(engPatches).toEqual([{ project_type: null }])
    expect(leadPatches).toEqual([]) // engagement field — never the lead's
    expect((host.querySelector('[aria-label="Edit type"]') as HTMLElement).textContent).toContain('Add type')
    await unmount()
  })

  it('the panel carries NO person-scoped edit rows (build 2 person-vs-deal): no referrer, no contact fields — those live on ClientProfile, one View-profile tap away', async () => {
    const { host, unmount } = await mountPanel()
    expect(host.querySelector('button[aria-label="Add referrer"]')).toBeNull()
    expect(host.querySelector('a[href^="tel:"]:not([href=""])')).toBeNull() // no contact rows (the action-bar Call needs client.phone, null here)
    expect(host.textContent).not.toContain('Key facts')
    await unmount()
  })

})
