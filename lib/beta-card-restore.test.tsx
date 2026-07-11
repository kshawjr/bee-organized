// @vitest-environment happy-dom
//
// Card restore, cheap tier (build 1 of 3 — Kevin's 7/10 mockup session,
// blessed client v4 / engagement v2). Render-only: no new actions, no
// layout restructure. Covers:
//
//   1) CLIENT-level 'Open in Jobber' — the confirmed bug: the profile
//      route never ships job_url, so the old jobs-scan href was always
//      null. Now derived from leads.jobber_client_id (classic's
//      /clients/{id} pattern); BOTH consumers (key-facts 'open' link +
//      action-row button) come alive.
//   2) PER-RECORD ↗ deep links on the panel's records checklist —
//      stored *_url first, jobber_*_id-derived fallback, absent when
//      neither (assessments have no url/id columns by schema).
//   3) CLOSED REASON rendered — profile closed rows (+ closed_note
//      italic) and the panel's shared ClosedSummary under the header.
//      The beta-stage-control literal pin stays intact: the panel
//      itself never contains 'closed_reason'.
//   4) INVOICE detail — the classic INV- number joins the '$X of $Y
//      paid' row line.
//   5) SOURCE/TYPE single home (person-vs-deal split): source edits on
//      ClientProfile Key Facts ONLY (SourceField — ContactField anatomy
//      over MetaSelect options); project_type on the panel HEADER only.
//   6) DAYS-IN-STAGE — latest stage_change touchpoint anchor,
//      created_at fallback, muted beside the panel's stage chip; not
//      rendered for terminal stages (ClosedSummary owns that spot).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { jobberClientUrl, recordJobberUrl } from '@/components/hive/shared/jobberLinks'
import { daysInStage, closedReasonLabel, invoiceNumber } from '@/components/hive/shared/engagementStatus'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const LOOKUPS = { sources: ['Webform', 'Website', 'Referral'], projectTypes: ['Client', 'Move'] }

// ── payloads (the beta-card-field-edits idiom) ─────────────────
const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(400), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: 'Client', location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [],
  contacts: [],
  engagements: over.engagements || [],
  touchpoints: [],
  buzz_notes: [],
  job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: (over.engagements || []).length },
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
    service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [],
    ...(over.children || {}),
  },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: null,
    address: null, city: null, state: null, zip: null,
    request_details: null, source: 'Webform',
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
    ...(over.client || {}),
  },
})

// ── fetch mock ────────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let leadPatches: Array<{ url: string, body: any }> = []
let profileBody: any = profilePayload()
let engBody: any = engagementPayload()
const installFetch = () => {
  leadPatches = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/leads/') && opts.method === 'PATCH') {
      leadPatches.push({ url: u, body: JSON.parse(opts.body) })
      return jsonRes({ ok: true })
    }
    if (u.includes('/api/engagements/')) return jsonRes(engBody)
    if (u.includes('/profile')) return jsonRes(profileBody)
    return jsonRes({})
  })
}

// ── DOM helpers ───────────────────────────────────────────────
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
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const jobberAnchors = (host: Element) =>
  [...host.querySelectorAll('a')].filter(a => (a.getAttribute('href') || '').includes('secure.getjobber.com'))

const mountProfile = async (props: any = {}) => {
  const onLeadPatched = vi.fn()
  const mounted = await mount(
    <ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}}
      onLeadPatched={onLeadPatched} lookupOptions={LOOKUPS} {...props} />
  )
  await flush()
  return { ...mounted, onLeadPatched }
}
const mountPanel = async (props: any = {}) => {
  const mounted = await mount(
    <EngagementPanel engagementId="eng-1" people={[]} onClose={() => {}} setToast={() => {}}
      lookupOptions={LOOKUPS} {...props} />
  )
  await flush()
  return mounted
}

beforeEach(() => {
  document.body.innerHTML = ''
  profileBody = profilePayload()
  engBody = engagementPayload()
  installFetch()
})

// ═══ 1) link derivation — pure ═════════════════════════════════
describe('jobberLinks — derivation', () => {
  it('client URL from jobber_client_id (classic /clients/{id}); null unlinked', () => {
    expect(jobberClientUrl('jc-77')).toBe('https://secure.getjobber.com/clients/jc-77')
    expect(jobberClientUrl(null)).toBeNull()
    expect(jobberClientUrl(undefined)).toBeNull()
  })

  it('record URL: stored *_url wins, jobber id derives the fallback path, neither → null', () => {
    expect(recordJobberUrl('quote', { quote_url: 'https://secure.getjobber.com/quotes/421', jobber_quote_id: '999' }))
      .toBe('https://secure.getjobber.com/quotes/421')
    expect(recordJobberUrl('quote', { quote_url: null, jobber_quote_id: '421' }))
      .toBe('https://secure.getjobber.com/quotes/421')
    expect(recordJobberUrl('request', { jobber_request_id: '15' })).toBe('https://secure.getjobber.com/requests/15')
    expect(recordJobberUrl('job', { jobber_job_id: '773' })).toBe('https://secure.getjobber.com/jobs/773')
    expect(recordJobberUrl('invoice', { jobber_invoice_id: '551' })).toBe('https://secure.getjobber.com/invoices/551')
    expect(recordJobberUrl('job', { title: 'local job' })).toBeNull()
    expect(recordJobberUrl('assessment', { id: 'a1' })).toBeNull() // no url/id columns exist
  })
})

// ═══ 1) client-level Open in Jobber — the confirmed bug ════════
describe('ClientProfile — client-level Jobber link', () => {
  it('href derives from jobber_client_id even with ZERO child job_url (the route never ships one); both consumers live', async () => {
    profileBody = profilePayload({
      client: { jobber_client_id: 'jc-77' },
      engagements: [{
        id: 'e1', title: 'Pantry refresh', stage: 'Job in Progress', created_at: daysAgo(10),
        total_invoiced: 0, total_paid: 0, balance_owing: 0,
        quotes: [], jobs: [{ id: 'j1', status: 'active' }], invoices: [], assessments: [],
      }],
    })
    const { host, unmount } = await mountProfile()
    const anchors = jobberAnchors(host)
    // key-facts 'open' + action-row 'Open in Jobber' — both alive, both /clients/
    expect(anchors.length).toBe(2)
    for (const a of anchors) expect(a.getAttribute('href')).toBe('https://secure.getjobber.com/clients/jc-77')
    expect(anchors.some(a => (a.textContent || '').includes('Open in Jobber'))).toBe(true)
    await unmount()
  })

  it('unlinked client: no Jobber anchors at all', async () => {
    const { host, unmount } = await mountProfile()
    expect(jobberAnchors(host)).toEqual([])
    await unmount()
  })
})

// ═══ 2) per-record ↗ links on the panel checklist ══════════════
describe('EngagementPanel — per-record Jobber links', () => {
  it('each Jobber-backed record row carries a quiet trailing ↗ (stored URL or id-derived); assessments and local records carry none', async () => {
    engBody = engagementPayload({
      engagement: { stage: 'Job in Progress' },
      children: {
        service_requests: [{ id: 'sr1', requested_at: daysAgo(20), request_url: 'https://secure.getjobber.com/requests/15' }],
        quotes: [{ id: 'q1', total: 900, status: 'approved', sent_at: daysAgo(15), approved_at: daysAgo(12), quote_url: null, jobber_quote_id: '421' }],
        jobs: [{ id: 'j1', title: 'Kitchen', status: 'active', scheduled_start: daysAgo(2), job_url: 'https://secure.getjobber.com/jobs/773' }],
        invoices: [{ id: 'i1', total: 4400, status: 'sent', balance_owing: 4400, paid_amount: 0, issued_at: daysAgo(1), invoice_url: 'https://secure.getjobber.com/invoices/551' }],
        assessments: [{ id: 'a1', scheduled_at: daysAgo(18), status: 'completed', completed_at: daysAgo(18) }],
      },
    })
    const { host, unmount } = await mountPanel()
    const rowLinks = [...host.querySelectorAll('a[aria-label="Open in Jobber"]')]
    expect(rowLinks.map(a => a.getAttribute('href')).sort()).toEqual([
      'https://secure.getjobber.com/invoices/551',
      'https://secure.getjobber.com/jobs/773',
      'https://secure.getjobber.com/quotes/421', // id-derived — quote_url was null
      'https://secure.getjobber.com/requests/15',
    ])
    // 4 linked records + the action-row deep link; the assessment row has none.
    expect(rowLinks.every(a => a.getAttribute('target') === '_blank')).toBe(true)
    await unmount()
  })

  it('a LOCAL engagement (no Jobber ids/urls) renders zero record links', async () => {
    const { host, unmount } = await mountPanel()
    expect(host.querySelectorAll('a[aria-label="Open in Jobber"]').length).toBe(0)
    await unmount()
  })
})

// ═══ 3) closed reason rendered ═════════════════════════════════
describe('closed reason + note', () => {
  it('closedReasonLabel: picker vocabulary + machine stamps + tolerant fallback (the column is asymmetric — display only)', () => {
    expect(closedReasonLabel('lost_no_response')).toBe('No response')
    expect(closedReasonLabel('lost_competitor')).toBe('Went with someone else')
    expect(closedReasonLabel('written_off')).toBe('Written off')
    expect(closedReasonLabel('stale_on_import')).toBe('Stale on import')
    expect(closedReasonLabel('won')).toBe('Won')
    expect(closedReasonLabel('some_future_value')).toBe('some future value')
    expect(closedReasonLabel(null)).toBeNull()
  })

  it('ClientProfile closed rows show the reason + italic note; a won row never echoes the redundant "Won" reason', async () => {
    profileBody = profilePayload({
      engagements: [
        {
          id: 'e-lost', title: 'Garage overhaul', stage: 'Closed Lost', created_at: daysAgo(90),
          closed_at: daysAgo(30), closed_reason: 'lost_no_response', closed_note: 'Went quiet after the quote',
          total_invoiced: 0, total_paid: 0, balance_owing: 0,
        },
        {
          id: 'e-won', title: 'Pantry refresh', stage: 'Closed Won', created_at: daysAgo(200),
          closed_at: daysAgo(100), closed_reason: 'won', closed_note: null,
          total_invoiced: 900, total_paid: 900, balance_owing: 0,
        },
      ],
    })
    const { host, unmount } = await mountProfile()
    expect(host.textContent).toContain('No response')
    expect(host.textContent).toContain('Went quiet after the quote')
    // 'won Mar 2026' stays; ' · Won' (the redundant reason) must not join it
    expect(host.textContent).not.toContain('· Won')
    await unmount()
  })

  it("EngagementPanel (closed): ClosedSummary sits under the header — reason + note render; 'days in stage' does NOT", async () => {
    engBody = engagementPayload({
      engagement: {
        stage: 'Closed Lost', closed_at: daysAgo(14),
        closed_reason: 'lost_competitor', closed_note: 'Chose a cheaper bid',
      },
    })
    const { host, unmount } = await mountPanel()
    expect(host.textContent).toContain('Closed lost')
    expect(host.textContent).toContain('Went with someone else')
    expect(host.textContent).toContain('Chose a cheaper bid')
    expect(host.textContent).not.toContain('days in stage')
    await unmount()
  })

  it('the profile route SHIPS closed_note (select pin — rendering needs the column)', () => {
    const route = readFileSync('app/api/clients/[id]/profile/route.ts', 'utf8')
    expect(route).toMatch(/closed_reason, closed_note/)
  })
})

// ═══ 4) invoice detail line ════════════════════════════════════
describe('EngagementPanel — invoice row detail', () => {
  it("the classic INV- number joins '$X of $Y paid' + issued/paid dates", async () => {
    engBody = engagementPayload({
      engagement: { stage: 'Final Processing', total_invoiced: 4400, balance_owing: 0, total_paid: 4400 },
      children: {
        invoices: [{
          id: 'i1', jobber_invoice_id: '990551221', total: 4400, status: 'paid',
          balance_owing: 0, paid_amount: 4400, issued_at: daysAgo(9), paid_at: daysAgo(2),
        }],
      },
    })
    const { host, unmount } = await mountPanel()
    expect(host.textContent).toContain('INV-551221') // last 6 of the Jobber id, uppercased
    expect(host.textContent).toContain('$4,400 of $4,400 paid')
    expect(host.textContent).toContain('issued')
    expect(host.textContent).toContain('paid')
    await unmount()
  })

  it('invoiceNumber matches the classic people-mapper derivation (same invoice, same number, every surface)', () => {
    expect(invoiceNumber({ jobber_invoice_id: 'abc12345' })).toBe('INV-C12345')
    expect(invoiceNumber({ id: 'row-uuid-9' })).toBe('INV-UUID-9') // Jobber id absent → row id
    expect(invoiceNumber({})).toBeNull()
  })
})

// ═══ 5) source/type single home ════════════════════════════════
describe('source/type — person-vs-deal split (single home each)', () => {
  it('source pins: Source edits ONLY on ClientProfile (SourceField); Type ONLY on the panel header', () => {
    const profile = readFileSync('components/hive/ClientProfile.jsx', 'utf8')
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(profile).toContain("from './shared/SourceField'")
    expect(profile).not.toContain('label="Type"')     // type is deal-scoped — never on the person surface
    expect(panel).toContain('label="Type"')
    expect(panel).not.toContain('label="Source"')     // source is person-scoped — gone from the deal surface
    expect(panel).not.toContain('SourceField')
  })

  it('ClientProfile SourceField: ContactField anatomy (icon/value/pencil) → MetaSelect options → lead PATCH, optimistic', async () => {
    const { host, unmount, onLeadPatched } = await mountProfile()
    const row = host.querySelector('[title="Edit source"]')!
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('Source: Webform')
    expect(row.querySelector('.bee-edit-pencil')).toBeTruthy() // the standard ✎, not a private fork
    await click(row)
    await click(buttonByText(host, 'Website')!)
    expect(host.textContent).toContain('Source: Website') // optimistic
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { source: 'Website' } }])
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { source: 'Website' })
    await unmount()
  })

  it('None clears: PATCH { source: null }, row falls to the dashed empty state', async () => {
    const { host, unmount } = await mountProfile()
    await click(host.querySelector('[title="Edit source"]')!)
    await click(buttonByText(host, 'None')!)
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { source: null } }])
    expect(host.textContent).toContain('add source')
    await unmount()
  })

  it("panel masthead carries the Type value ABOVE the tab bar (header area, not Overview content) — a quiet editable meta value, not a bordered box", async () => {
    const { host, unmount } = await mountPanel()
    const typeCell = host.querySelector('[aria-label="Edit type"]')!
    expect(typeCell).toBeTruthy()
    expect(typeCell.textContent).toContain('Client')
    // the standalone bordered "Type: Client" pill box is gone
    expect([...host.querySelectorAll('button')].some(b => (b.textContent || '').includes('Type: Client'))).toBe(false)
    const tabBar = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Overview tab')!
    expect(typeCell.compareDocumentPosition(tabBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await unmount()
  })
})

// ═══ 6) days in stage ══════════════════════════════════════════
describe('days in stage', () => {
  it('derivation: latest stage_change touchpoint wins; created_at is the fallback; singular-correct callers', () => {
    const e = { created_at: daysAgo(30) }
    const touches = [
      { kind: 'reach_out', occurred_at: daysAgo(1) },            // ignored — not a stage move
      { kind: 'stage_change', occurred_at: daysAgo(12) },
      { kind: 'stage_change', occurred_at: daysAgo(3) },          // latest move anchors
    ]
    expect(daysInStage(e, touches, now)).toBe(3)
    expect(daysInStage(e, [], now)).toBe(30)                      // fallback: created_at
    expect(daysInStage(e, [{ kind: 'stage_change', occurred_at: daysAgo(1.4) }], now)).toBe(1)
    expect(daysInStage({}, [], now)).toBeNull()                   // no anchor at all (seed mid-load)
  })

  it("panel header shows 'N days in stage' muted beside the stage chip, from the stage_change anchor", async () => {
    engBody = engagementPayload({
      children: { touchpoints: [{ id: 't1', kind: 'stage_change', label: 'Stage: Request → Estimate', occurred_at: daysAgo(4) }] },
    })
    const { host, unmount } = await mountPanel()
    expect(host.textContent).toContain('4 days in stage')
    await unmount()
  })

  it('fallback: no stage_change trail → created_at anchors (forward-only trail, never backfilled)', async () => {
    const { host, unmount } = await mountPanel() // created_at daysAgo(30), zero touchpoints
    expect(host.textContent).toContain('30 days in stage')
    await unmount()
  })
})
