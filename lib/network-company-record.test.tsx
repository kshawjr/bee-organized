// @vitest-environment happy-dom
//
// NETWORK Phase 3 — the company record (NetworkCompanyRecord), retiring
// Classic's inline company overlay. Mount tests:
//
//   A) PEOPLE HERE: lists live company_id-linked people with per-person
//      referral counts (from /api/companies/:id/referrals people[]) and
//      last-talked (60d+ danger; NULL renders quiet).
//   B) TOUCHPOINTS roll up across everyone, each line NAMING who it was
//      with — the history survives someone leaving.
//   C) LEADS REFERRED: direct rows say company-direct; via-person rows
//      say "via <person>".
//   D) "+ Add person" hands THIS company up (the host presets the add
//      modal → company_id FK).
//   E) Stats honest: '—' pending, real once resolved; last-talked
//      derives from its people.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkCompanyRecord from '@/components/hive/NetworkCompanyRecord'
import { T } from '@/components/hive/shared/tokens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const COMPANY = { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', locationId: 'loc-1', addresses: [], isDeleted: false }

const PARTNERS = [
  { id: 'p1', name: 'Karen Martinez', companyId: 'co1', title: 'Agent', stage: 'Active Partner', tags: [], lastContactedAt: daysAgo(5), isDeleted: false },
  { id: 'p2', name: 'Stale Sam', companyId: 'co1', title: 'Broker', stage: 'Building', tags: [], lastContactedAt: daysAgo(90), isDeleted: false },
  { id: 'p3', name: 'Other Olive', companyId: 'co-OTHER', title: '', stage: '', tags: [], lastContactedAt: null, isDeleted: false },
  { id: 'p4', name: 'Deleted Dan', companyId: 'co1', title: '', stage: '', tags: [], lastContactedAt: null, isDeleted: true },
]

const REFERRALS = {
  company: { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate' },
  referred: [
    { id: 'L1', name: 'Lisa Patel', created_at: daysAgo(3), converted: true, revenue: 1200, engagement_count: 1, status: 'client', via: { kind: 'partner', id: 'p1', name: 'Karen Martinez' } },
    { id: 'L2', name: 'Direct Dora', created_at: daysAgo(9), converted: false, revenue: 0, engagement_count: 0, status: 'lead', via: { kind: 'company', id: 'co1', name: 'Meridian Realty' } },
  ],
  totals: { count: 2, converted: 1, revenue: 1200 },
  total: 2,
  people: [
    { id: 'p1', name: 'Karen Martinez', referral_count: 4 },
    { id: 'p2', name: 'Stale Sam', referral_count: 0 },
  ],
}

const TOUCHPOINTS = {
  touchpoints: [
    { id: 't1', partner_id: 'p1', partner_name: 'Karen Martinez', kind: 'reach_out', method: 'coffee', label: 'Reach-out', notes: 'Great chat', occurred_at: daysAgo(5) },
    { id: 't2', partner_id: 'p2', partner_name: 'Stale Sam', kind: 'reach_out', method: 'call', label: 'Reach-out', notes: null, occurred_at: daysAgo(90) },
  ],
}

let host: HTMLDivElement
let root: Root

const installFetch = (handlers: Record<string, any> = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url)
    for (const [frag, resp] of Object.entries(handlers)) {
      if (u.includes(frag)) {
        if (resp instanceof Promise) return resp
        return { ok: true, status: 200, json: async () => resp }
      }
    }
    if (u.includes('/referrals')) return { ok: true, status: 200, json: async () => REFERRALS }
    if (u.includes('/touchpoints')) return { ok: true, status: 200, json: async () => TOUCHPOINTS }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}

const mount = async (props: any = {}) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<NetworkCompanyRecord company={COMPANY} partners={PARTNERS} {...props} />)
  })
  await act(async () => {})
}

beforeEach(() => installFetch())
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

describe('A) people here', () => {
  it('lists LIVE company_id-linked people with per-person counts + staleness', async () => {
    await mount()
    const section = host.querySelector('[data-testid="company-people"]')!
    expect(section.textContent).toContain('People here · 2')
    expect(section.textContent).toContain('Karen Martinez')
    expect(section.textContent).toContain('Stale Sam')
    expect(section.textContent).not.toContain('Other Olive')   // different company
    expect(section.textContent).not.toContain('Deleted Dan')   // soft-deleted
    const karenRow = section.querySelector('[data-person-row="p1"]')!
    expect(karenRow.textContent).toContain('4 referred')
    const staleTalk = section.querySelector('[data-person-row="p2"] [data-recency="stale"]') as HTMLElement
    expect(staleTalk).toBeTruthy()
    expect(staleTalk.style.color).toBe(T.state.danger.fg)
  })

  it('clicking a person opens their record', async () => {
    const onOpenPerson = vi.fn()
    await mount({ onOpenPerson })
    await act(async () => {
      (host.querySelector('[data-person-row="p1"]') as HTMLElement).click()
    })
    expect(onOpenPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })
})

describe('B) touchpoints rolled up + named', () => {
  it('each line names who the conversation was with', async () => {
    await mount()
    const section = host.querySelector('[data-testid="company-touchpoints"]')!
    expect(section.textContent).toContain('Coffee')
    expect(section.textContent).toContain('with Karen Martinez')
    expect(section.textContent).toContain('with Stale Sam')
    expect(section.textContent).toContain('Great chat')
  })
})

describe('C) leads referred, attributed', () => {
  it('via-person rows name the person; direct rows say company direct', async () => {
    await mount()
    const section = host.querySelector('[data-testid="company-referred"]')!
    const lisa = [...section.querySelectorAll('a')].find(a => a.textContent!.includes('Lisa Patel'))!
    expect(lisa.textContent).toContain('via Karen Martinez')
    expect(lisa.getAttribute('href')).toBe('/clients/L1')
    const dora = [...section.querySelectorAll('a')].find(a => a.textContent!.includes('Direct Dora'))!
    expect(dora.textContent).toContain('company direct')
  })
})

describe('D) + Add person creates INTO this company', () => {
  it('hands the company up so the host presets the create modal (company_id FK)', async () => {
    const onAddPerson = vi.fn()
    await mount({ onAddPerson })
    await act(async () => {
      ([...host.querySelectorAll('button')].find(b => b.textContent === '+ Add person') as HTMLElement).click()
    })
    expect(onAddPerson).toHaveBeenCalledWith(expect.objectContaining({ id: 'co1' }))
  })
})

describe('E) honest stats + derived last-talked', () => {
  it("'—' while pending; real numbers + people-derived last-talked once resolved", async () => {
    installFetch({ '/referrals': new Promise(() => {}) })
    await mount()
    let stats = host.querySelector('[data-testid="company-stats"]')!
    expect(stats.textContent).toContain('—')
    expect(stats.textContent).not.toContain('$0')

    await act(async () => root.unmount())
    host.remove()
    installFetch()
    await mount()
    stats = host.querySelector('[data-testid="company-stats"]')!
    expect(stats.textContent).toContain('$1,200')
    expect(stats.textContent).toContain('Contacts here')
    // Last-talked = freshest among its people (Karen, 5d ago) — not '—'.
    expect(stats.textContent).toContain('5d ago')
  })
})
