// @vitest-environment happy-dom
//
// The red "estimates awaiting follow-up" card must not nag about a quote the
// client already APPROVED (22 Oct 2026 — Shirley Ann Morgan's accepted $2,960
// estimate sat on Central Denver's card as unanswered).
//
// The rule had three copies: the Reminders "Bee Hub noticed" tab
// (shared/noticed.js), Home's card (BeeHub.jsx DashboardScreen) and the
// server's 'All locations' overview (lib/hub-all-overview.ts). All three now
// ask ONE function, estimateFollowUpDays. This file pins the rule itself, then
// feeds the SAME engagements to all three surfaces and expects the SAME count.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any

import { estimateFollowUpDays, estimatesAwaitingReply } from '@/components/hive/shared/noticed'
import { ESTIMATE_FOLLOWUP_DAYS } from '@/components/hive/shared/attentionThresholds'
import { buildAllOverview } from '@/lib/hub-all-overview'
import App from '@/components/BeeHub'

const DAY = 86400000
const NOW = Date.now()
const ago = (d: number) => new Date(NOW - d * DAY).toISOString()
const DENVER = 'b3b0a1f2-0000-4000-8000-00000000d3n0'

const eng = (id: string, quotes: any[], over: any = {}) => ({
  id, client_id: `c-${id}`, client_name: `Client ${id}`, stage: 'Estimate', location_uuid: DENVER, quotes, ...over,
})
const OLD = ESTIMATE_FOLLOWUP_DAYS + 9

describe('estimateFollowUpDays — the one rule', () => {
  it('an APPROVED quote is not awaiting follow-up, however long ago it was sent', () => {
    expect(estimateFollowUpDays(eng('shirley', [{ sent_at: ago(OLD), status: 'approved' }]), NOW)).toBeNull()
  })

  it('a sent, unapproved quote past the threshold still is — with its days', () => {
    expect(estimateFollowUpDays(eng('e1', [{ sent_at: ago(OLD), status: 'sent' }]), NOW)).toBe(OLD)
  })

  it('one approved quote answers the deal, even beside an older unapproved one', () => {
    expect(estimateFollowUpDays(eng('e2', [{ sent_at: ago(OLD + 5), status: 'sent' }, { sent_at: ago(OLD), status: 'approved' }]), NOW)).toBeNull()
  })

  it('the rest of the rule is unchanged: recent, never sent, wrong stage', () => {
    expect(estimateFollowUpDays(eng('r', [{ sent_at: ago(1), status: 'sent' }]), NOW)).toBeNull()
    expect(estimateFollowUpDays(eng('n', [{ sent_at: null, status: 'draft' }]), NOW)).toBeNull()
    expect(estimateFollowUpDays(eng('w', [{ sent_at: ago(OLD), status: 'sent' }], { stage: 'Request' }), NOW)).toBeNull()
  })
})

// ── the same data through all three surfaces ───────────────────────────────
const ENGAGEMENTS = [
  eng('shirley', [{ sent_at: ago(OLD), status: 'approved' }]),        // approved — not counted
  eng('waiting', [{ sent_at: ago(OLD), status: 'sent' }]),            // counted
  eng('older', [{ sent_at: ago(OLD + 4), status: 'changes_requested' }]), // counted (no approval)
  eng('fresh', [{ sent_at: ago(1), status: 'sent' }]),                // too recent
]
const EXPECTED = 2

const emptyDb = () => {
  const b: any = {}
  for (const m of ['select', 'not', 'eq', 'neq', 'is', 'gt', 'gte', 'lt', 'in', 'or', 'order', 'limit', 'range']) b[m] = () => b
  b.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej)
  return { from: () => b }
}

async function homeCardText(): Promise<string> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => {
    root.render(React.createElement(App as any, {
      initialRoute: 'home', initialRole: 'super_admin', initialFranchiseRole: 'owner',
      initialLocations: [{ id: DENVER, name: 'Central Denver', state: 'CO', crmStatus: 'active' }],
      initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
      initialPeople: [], initialBinPeople: [], initialTransferPeople: [],
      initialEngagements: ENGAGEMENTS,
      initialPartners: [], initialCompanies: [], initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
      initialLocFilter: DENVER, initialScopeLocationId: DENVER, initialAllOverview: null,
      currentUser: { id: 'u1', email: 'kevin@bmave.com', name: 'Kevin', role: 'super_admin', locationId: null },
      currentLocation: null, currentSubscription: null,
    }))
  })
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  const text = host.textContent || ''
  errSpy.mockRestore(); root.unmount(); host.remove()
  return text
}

afterEach(() => { document.body.innerHTML = '' })

describe('all three surfaces give the same count for the same data', () => {
  it(`Reminders tab, server overview and Home card all say ${EXPECTED}`, async () => {
    // (cast: the JS module's inferred `locationId = null` default types the option as null)
    const tab = estimatesAwaitingReply(ENGAGEMENTS, { locationId: DENVER, nowMs: NOW } as any)
    expect(tab.map((r) => r.engagement_id).sort()).toEqual(['older', 'waiting'])

    const ov = await buildAllOverview(emptyDb() as any, ENGAGEMENTS, NOW)
    expect(ov.estimateFollowUps.count).toBe(EXPECTED)
    expect(ov.estimateFollowUps.oldestDays).toBe(OLD + 4)

    const home = await homeCardText()
    expect(home).toContain(`${EXPECTED} estimates awaiting follow-up`)
    expect(home).toContain(`oldest ${OLD + 4}d`)
  })

  it("the server's 'All locations' load carries quote status, or the overview could not see an approval", () => {
    const src = readFileSync(join(process.cwd(), 'app/_hub-page.tsx'), 'utf8')
    expect(src).toContain(`chunked('quotes', 'engagement_id, sent_at, status'`)
    expect(src).toContain('quotes: (quotesByEng[e.id] || []).map((q: any) => ({ sent_at: q.sent_at, status: q.status }))')
  })
})
