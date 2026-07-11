// @vitest-environment happy-dom
//
// Card restore build 2 — v4/v2 LAYOUTS (Kevin's 7/10 blessed designs).
// Restructure + sizing pins:
//   1) METRIC BAND aggregates — pure math (lib/profile-aggregates):
//      OWING spans ALL engagements INCLUDING closed (the closed-debt
//      drift fix); Invoiced = all-engagements total_invoiced sum.
//   2) TAB structure both cards — Overview · Timeline (count) · Files;
//      counts render muted, aria-labels unchanged.
//   3) MASTHEAD persistence — the panel's client+deal identity stays
//      visible on every tab.
//   4) DRIP BANNER visibility matrix — live/paused → shown;
//      stopped/completed/absent → hidden (route ships null); closed
//      engagement → ClosedSummary owns the slot.
//   5) MODAL WIDTH — 840px desktop for ClientProfile + EngagementPanel;
//      PersonCard keeps 740.
//   6) PREV/NEXT — chevrons navigate the opener's sibling ordering;
//      hidden entirely without one; ends disable.
//   7) PersonCard type-pill ABSENCE (source pin; the DOM half lives in
//      beta-card-field-edits).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import PersonCard from '@/components/hive/PersonCard'
import { profileAggregates } from '@/lib/profile-aggregates'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const inDays = (n: number) => new Date(now + n * 86400000).toISOString()

const LOOKUPS = { sources: ['Webform', 'Website'], projectTypes: ['Client', 'Move'] }

const person = (over: any = {}) => ({
  id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
  source: 'Webform', locationId: 'loc-uuid-1', created: daysAgo(40),
  isJunk: false, outreachTimeline: [], ...over,
})

const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(400), source: 'Webform', paused: false, marketing_opt_out: false,
    snoozed_until: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [], contacts: [], engagements: over.engagements || [],
  touchpoints: over.touchpoints || [], buzz_notes: [], job_notes: over.job_notes || [],
  tags: over.tags || [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0, ...(over.aggregates || {}) },
})

const engagementPayload = (over: any = {}) => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(30), stage_entered_at: daysAgo(30), location_uuid: 'loc-uuid-1',
    project_type: 'Client', description: null,
    closed_at: null, closed_reason: null, closed_note: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
    ...(over.engagement || {}),
  },
  children: {
    service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [],
    notes: over.notes || [], touchpoints: over.touchpoints || [],
    ...(over.children || {}),
  },
  drip: over.drip !== undefined ? over.drip : null,
  client: {
    id: 'lead-9', name: 'Dana Client', location_name: 'Denver', email: 'dana@x.com', phone: null,
    address: null, city: null, state: null, zip: null,
    request_details: null, source: 'Webform',
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
    ...(over.client || {}),
  },
})

const jsonRes = (body: any) => ({ ok: true, status: 200, json: async () => body })
let profileBody: any
let engBody: any
const installFetch = () => {
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/engagements/')) return jsonRes(engBody)
    if (u.includes('/profile')) return jsonRes(profileBody)
    return jsonRes({})
  })
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const tabButton = (host: Element, label: string) =>
  [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === `${label} tab`)

const mountProfile = async (props: any = {}) =>
  mount(<ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}} lookupOptions={LOOKUPS} {...props} />)
const mountPanel = async (props: any = {}) =>
  mount(<EngagementPanel engagementId="eng-1" people={[]} onClose={() => {}} setToast={() => {}} lookupOptions={LOOKUPS} {...props} />)

beforeEach(() => {
  document.body.innerHTML = ''
  profileBody = profilePayload()
  engBody = engagementPayload()
  installFetch()
})

// ═══ 1) metric-band aggregates — the pure route math ═══════════
describe('profileAggregates (lib/profile-aggregates)', () => {
  const engs = [
    { stage: 'Job in Progress', total_paid: 100, total_invoiced: 400, balance_owing: 300, quotes: [] },
    { stage: 'Closed Won', total_paid: 900, total_invoiced: 900, balance_owing: 0, quotes: [] },
    // The drift case: CLOSED with debt (written_off exists because
    // close ≠ paid) — its owing must NOT vanish.
    { stage: 'Closed Lost', total_paid: 0, total_invoiced: 250, balance_owing: 250, quotes: [] },
  ]

  it('OWING includes closed-engagement debt (the closed-debt-vanishes fix)', () => {
    expect(profileAggregates(engs).owing).toBe(550) // 300 open + 250 CLOSED
  })

  it('Invoiced sums total_invoiced across ALL engagements; Collected = total_paid sum; pipeline stays open-scoped', () => {
    const a = profileAggregates(engs)
    expect(a.invoiced).toBe(1550)
    expect(a.lifetime_paid).toBe(1000)
    expect(a.open_pipeline).toBe(400) // the open engagement's invoiced value only
    expect(a.open_count).toBe(1)
    expect(a.total_count).toBe(3)
  })

  it('open_pipeline falls back to the best quote pre-invoicing', () => {
    const a = profileAggregates([{ stage: 'Estimate', total_paid: 0, total_invoiced: 0, balance_owing: 0, quotes: [{ total: 750 }, { total: 500 }] }])
    expect(a.open_pipeline).toBe(750)
  })

  it('the profile route computes aggregates through this module (source pin)', () => {
    const route = readFileSync('app/api/clients/[id]/profile/route.ts', 'utf8')
    expect(route).toContain("from '@/lib/profile-aggregates'")
    expect(route).toContain('profileAggregates(withChildren)')
  })
})

// ═══ 2) tab structure — both cards ═════════════════════════════
describe('tab structure (v4/v2)', () => {
  it('ClientProfile: Overview · Timeline (count) · Files (count) — counts render muted, aria-labels unchanged', async () => {
    profileBody = profilePayload({
      touchpoints: [
        { id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1), engagement_id: null, user_label: 'K' },
        { id: 't2', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(2), engagement_id: null, user_label: 'K' },
      ],
      job_notes: [{ id: 'n1', text: 'note', user_label: 'K', created_at: daysAgo(1), engagement_id: null }],
    })
    const { host, unmount } = await mountProfile()
    expect(tabButton(host, 'Timeline')!.textContent).toContain('3') // 2 touches + 1 note
    expect(tabButton(host, 'Files')!.textContent).toContain('0')
    await unmount()
  })

  it('EngagementPanel: Timeline count = engagement-scoped notes + touchpoints', async () => {
    engBody = engagementPayload({
      notes: [{ id: 'n1', text: 'x', user_label: 'K', created_at: daysAgo(1) }],
      touchpoints: [{ id: 't1', kind: 'reach_out', method: 'call', label: 'Reach-out', occurred_at: daysAgo(1), user_label: 'K' }],
    })
    const { host, unmount } = await mountPanel()
    expect(tabButton(host, 'Timeline')!.textContent).toContain('2')
    expect(tabButton(host, 'Files')).toBeTruthy()
    await unmount()
  })
})

// ═══ 3) masthead persists across tabs ══════════════════════════
describe('masthead persistence', () => {
  it('panel: client name + title + stage chip + value stay visible on the Files tab', async () => {
    engBody = engagementPayload({ engagement: { total_invoiced: 1200 } })
    const { host, unmount } = await mountPanel()
    await click(tabButton(host, 'Files')!)
    expect(host.querySelector('h2')!.textContent).toBe('Dana Client')
    expect(host.textContent).toContain('Kitchen + Pantry')
    expect(host.textContent).toContain('$1,200')
    expect(host.textContent).toContain('No files yet')
    await unmount()
  })

  it('profile: metric band + header stay visible on the Files tab', async () => {
    profileBody = profilePayload({ aggregates: { lifetime_paid: 4200 } })
    const { host, unmount } = await mountProfile()
    await click(tabButton(host, 'Files')!)
    expect(host.querySelector('[aria-label="Metrics"]')).toBeTruthy()
    expect(host.textContent).toContain('$4,200')
    await unmount()
  })
})

// ═══ 4) drip banner visibility matrix ══════════════════════════
describe('drip banner (v2 — display only, Build-3 pause)', () => {
  const banner = (host: Element) => host.querySelector('[aria-label="Drip banner"]')

  it("LIVE drip → 'Drip · step N of M · next {date}'", async () => {
    engBody = engagementPayload({ drip: { path_name: 'Standard nurture', current_step: 2, total_steps: 5, next_send_at: inDays(3), paused: false } })
    const { host, unmount } = await mountPanel()
    const b = banner(host)!
    expect(b).toBeTruthy()
    expect(b.textContent).toContain('Drip · step 2 of 5')
    expect(b.textContent).toContain('next')
    expect(b.textContent).not.toContain('paused')
    await unmount()
  })

  it("PAUSED drip → still shown, '· paused' suffix", async () => {
    engBody = engagementPayload({ drip: { path_name: null, current_step: 1, total_steps: 4, next_send_at: null, paused: true } })
    const { host, unmount } = await mountPanel()
    expect(banner(host)!.textContent).toContain('paused')
    await unmount()
  })

  it('stopped/completed/absent → the route ships drip:null and the banner is GONE (no empty band)', async () => {
    engBody = engagementPayload({ drip: null })
    const { host, unmount } = await mountPanel()
    expect(banner(host)).toBeNull()
    await unmount()
  })

  it('closed engagement → ClosedSummary owns the slot; no drip banner even if a row leaked through', async () => {
    engBody = engagementPayload({
      engagement: { stage: 'Closed Lost', closed_at: daysAgo(3), closed_reason: 'lost_no_response' },
      drip: { path_name: null, current_step: 1, total_steps: 4, next_send_at: inDays(2), paused: false },
    })
    const { host, unmount } = await mountPanel()
    expect(banner(host)).toBeNull()
    expect(host.textContent).toContain('Closed lost')
    await unmount()
  })

  it('route pin: the drip select is the ACTIVE-row filter (stopped/completed excluded at the source)', () => {
    const route = readFileSync('app/api/engagements/[id]/route.ts', 'utf8')
    expect(route).toContain("from('lead_drip_progress')")
    expect(route).toMatch(/\.is\('stopped_at', null\)/)
    expect(route).toMatch(/\.is\('completed_at', null\)/)
  })
})

// ═══ 5) modal width ════════════════════════════════════════════
describe('modal width (desktop)', () => {
  const modalOf = (host: Element) => host.querySelector('.bee-overlay-modal') as HTMLElement

  it('ClientProfile + EngagementPanel run 840px; PersonCard keeps 740', async () => {
    const cp = await mountProfile()
    expect(modalOf(cp.host).style.maxWidth).toBe('840px')
    await cp.unmount()

    const ep = await mountPanel()
    expect(modalOf(ep.host).style.maxWidth).toBe('840px')
    await ep.unmount()

    const pc = await mount(<PersonCard person={person()} onClose={() => {}} setToast={() => {}} lookupOptions={LOOKUPS} />)
    expect(modalOf(pc.host).style.maxWidth).toBe('740px')
    await pc.unmount()
  })

  it('both cards stack the two-column grid under ~700px (media-query source pin)', () => {
    for (const f of ['components/hive/ClientProfile.jsx', 'components/hive/EngagementPanel.jsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toContain('.bee-card-cols')
      expect(src, f).toMatch(/@media \(max-width: 700px\)[^}]*grid-template-columns: 1fr/)
    }
  })
})

// ═══ 6) prev/next navigation ═══════════════════════════════════
describe('prev/next chevrons (opener ordering)', () => {
  it('chevrons navigate within siblings; ends disable', async () => {
    const nav: string[] = []
    const sibs = ['lead-1', 'lead-9', 'lead-22']
    const { host, unmount } = await mountProfile({ siblings: sibs, onNavigate: (id: string) => nav.push(id) })
    const prev = host.querySelector('button[aria-label="Previous client"]') as HTMLButtonElement
    const next = host.querySelector('button[aria-label="Next client"]') as HTMLButtonElement
    expect(prev).toBeTruthy()
    expect(next).toBeTruthy()
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(false)
    await click(next)
    await click(prev)
    expect(nav).toEqual(['lead-22', 'lead-1'])
    await unmount()
  })

  it('first-in-list disables prev; last disables next', async () => {
    const first = await mountProfile({ siblings: ['lead-9', 'lead-22'], onNavigate: () => {} })
    expect((first.host.querySelector('button[aria-label="Previous client"]') as HTMLButtonElement).disabled).toBe(true)
    expect((first.host.querySelector('button[aria-label="Next client"]') as HTMLButtonElement).disabled).toBe(false)
    await first.unmount()

    const last = await mountProfile({ siblings: ['lead-1', 'lead-9'], onNavigate: () => {} })
    expect((last.host.querySelector('button[aria-label="Next client"]') as HTMLButtonElement).disabled).toBe(true)
    await last.unmount()
  })

  it('no siblings (panel swap, fresh create) → chevrons hidden entirely', async () => {
    const { host, unmount } = await mountProfile()
    expect(host.querySelector('button[aria-label="Previous client"]')).toBeNull()
    expect(host.querySelector('button[aria-label="Next client"]')).toBeNull()
    await unmount()
  })

  it('the directory passes its visible row ordering; HiveShell threads it (source pins)', () => {
    expect(readFileSync('components/hive/ClientDirectory.jsx', 'utf8')).toContain('onOpenClient(p.id, rows.map(r => r.p.id))')
    const shell = readFileSync('components/hive/HiveShell.jsx', 'utf8')
    expect(shell).toContain('siblings={overlay.siblings ?? null}')
    expect(shell).toContain('onNavigate=')
  })
})

// ═══ 7) PersonCard type pill — source pin ══════════════════════
describe('PersonCard (build-2 straggler)', () => {
  it('no Type pill in source — project type is deal-scoped; Source stays (leads are pre-deal)', () => {
    const src = readFileSync('components/hive/PersonCard.jsx', 'utf8')
    expect(src).not.toContain('label="Type"')
    expect(src).toContain('label="Source"')
  })

  it('invoice inset ghosts (v2): Record payment / Send reminder render DISABLED with the coming tooltip', async () => {
    engBody = engagementPayload({
      children: { invoices: [{ id: 'i1', jobber_invoice_id: '990551221', total: 4400, status: 'paid', balance_owing: 0, paid_amount: 4400, issued_at: daysAgo(9), paid_at: daysAgo(2) }] },
    })
    const { host, unmount } = await mountPanel()
    for (const label of ['Record payment', 'Send reminder']) {
      const btn = [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === label) as HTMLButtonElement
      expect(btn, label).toBeTruthy()
      expect(btn.disabled).toBe(true)
      expect(btn.title).toContain('Coming')
    }
    expect(host.textContent).toContain('INV-551221')
    await unmount()
  })
})
