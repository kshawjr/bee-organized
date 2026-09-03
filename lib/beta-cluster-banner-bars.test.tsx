// @vitest-environment happy-dom
//
// THE CLUSTER BANNER, OPTION 4: one dark bar per cluster, everything else in a
// modal the bar opens.
//
// The cluster banner (issue 307) was correctly gated and worked; the problem
// was presentation. It printed the full mechanism — function, field and
// constant names included — at the top of the list before a single report was
// visible. What this pins about the replacement:
//
//   · ONE BAR PER CLUSTER, with the count and ONE plain sentence, and NOTHING
//     else: no impact number, no code identifier, no paragraph
//   · the bar opens the cluster modal
//   · the modal carries the impact, the plain sentence, the members (who,
//     where, how long), and a "Show the technical detail" disclosure that is
//     CLOSED by default — the technical block is ABSENT from the DOM until
//     opened, not display:none
//   · the footer button selects exactly the members "Show them" used to
//   · nothing renders for an owner-shaped mount, which never asks the analysis
//     route at all (the route's own 403 for owner and manager is pinned in
//     lib/beta-feedback-queues-redesign-routes.test.ts, re-run alongside)
//   · the plain sentence comes from the probe's own `summary` field, written
//     beside the probe with no identifiers; the paragraph is not split
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { analyseItem, clusterAnalyses, PROBE_KEYS } from '@/lib/feedback-analysis'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const base = { type: 'bug', status: 'submitted', user_id: 'u2', attachments: [], replies: [], admin_response: null, admin_response_at: null, reply_seen_at: null }

const ROWS = [
  { ...base, id: 'arlene', title: 'Returning client - request showing as Engagement not New', description: 'Arlene Kaseff sent in a request.', submitter_name: 'Amy Kerr', submitter_email: 'amy@oo.com', location_id: 'loc-1', location_name: 'Office Organization', created_at: daysAgo(12), updated_at: daysAgo(12) },
  { ...base, id: 'diane', title: 'Nuturing 2', description: 'Diane Stern, how do I move her out of nuturing?', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com', location_id: 'loc-2', location_name: 'Kansas City', created_at: daysAgo(30), updated_at: daysAgo(30) },
  { ...base, id: 'mario', title: 'Problem with Office Organization', description: 'Mario is closed out and paid.', submitter_name: 'Amy Kerr', submitter_email: 'amy@oo.com', location_id: 'loc-1', location_name: 'Office Organization', created_at: daysAgo(3), updated_at: daysAgo(3), context: { kind: 'engagement', engagement_id: 'e-mario', stage: 'Final Processing' } },
  { ...base, id: 'mario2', title: 'Another stuck one', description: 'Paid and done but still open.', submitter_name: 'Bob Manager', submitter_email: 'bob@np.com', location_id: 'loc-3', location_name: 'North Pittsburgh', created_at: daysAgo(8), updated_at: daysAgo(8), context: { kind: 'engagement', engagement_id: 'e-mario2', stage: 'Final Processing' } },
  { ...base, id: 'lonely', title: 'Email cut off', description: "Email address is cut off if it's too long", submitter_name: 'Amy Kerr', submitter_email: 'amy@oo.com', location_id: 'loc-1', location_name: 'Office Organization', created_at: daysAgo(59), updated_at: daysAgo(59) },
]

// REAL analyses from the REAL probes, so the summary and the paragraph on
// screen are the library's own words, not fixtures shaped to pass.
const FLEET = {
  'returning-client-request-stage': { count: 17, unit: 'returning clients', basis: 'have a prior closed engagement and only Request-stage open work' },
  'stuck-final-processing': { count: 106, unit: 'engagements', basis: 'at Final Processing, with an archived job, and no fully-paid invoice' },
}
const stuckEv = (id: string) => ({ engagement: { id, stage: 'Final Processing', jobCount: 1, archivedJobCount: 1, quoteCount: 0, invoiceCount: 0, paidInvoiceCount: 0 }, fleet: FLEET })
const returningEv = (name: string) => ({ namedLeads: [{ query: name, found: true, id: 'l', name, openIsRequestOnly: true, hasPriorClosed: true }], fleet: FLEET })
const ANALYSES = [
  analyseItem({ item: ROWS[0] as any, evidence: returningEv('Arlene Kaseff'), index: null }),
  analyseItem({ item: ROWS[1] as any, evidence: returningEv('Diane Stern'), index: null }),
  analyseItem({ item: ROWS[2] as any, evidence: stuckEv('e-mario'), index: null }),
  analyseItem({ item: ROWS[3] as any, evidence: stuckEv('e-mario2'), index: null }),
  analyseItem({ item: ROWS[4] as any, evidence: {}, index: null }),
]
const CLUSTERS = clusterAnalyses(ANALYSES)

let analysisAsked = 0
const stubFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/api/admin/feedback/analysis')) {
      analysisAsked++
      return { ok: true, status: 200, json: async () => ({ analyses: ANALYSES, clusters: CLUSTERS, drafts: [] }) }
    }
    if (init?.method === 'PATCH') return { ok: true, status: 200, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ items: ROWS }) }
  }))
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {}); await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const screenFor = (props: any = {}) => mount(
  <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>
    <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
  </CurrentUserContext.Provider>,
)
const bars = (host: Element) => [...host.querySelectorAll('[data-testid="cluster-bar"]')] as HTMLElement[]
const modal = (host: Element) => host.querySelector('[data-testid="cluster-modal"]') as HTMLElement | null
const tech = (host: Element) => host.querySelector('[data-testid="cluster-technical"]')
const buttons = (host: Element) => [...host.querySelectorAll('button')]
const IDENTIFIERS = /OPENING_STAGE|deriveClientStatus|canCloseWon|invoicesFullyPaid|jobUnbooked|engagementJobDone/

beforeEach(() => { document.body.innerHTML = ''; analysisAsked = 0; stubFetch() })
afterEach(() => { vi.unstubAllGlobals() })

// ─── the library supplies the sentence ────────────────────────────────

describe('every probe carries one plain sentence, and the cluster inherits it', () => {
  it('each probe has a summary with no code identifier, short enough for a phone', () => {
    const byProbe = new Map(ANALYSES.filter(a => a.probe).map(a => [a.probe, a]))
    expect(byProbe.size).toBe(2)
    for (const a of byProbe.values()) {
      expect(a.summary, `${a.probe} has no summary`).toBeTruthy()
      expect(a.summary!.length).toBeLessThanOrEqual(80)
      expect(a.summary).not.toMatch(IDENTIFIERS)
      expect(a.summary).not.toMatch(/[()_]/)
      // The paragraph is where the identifiers live, untouched.
      expect(a.what).toMatch(IDENTIFIERS)
    }
    // An unanalysed item has none, rather than an invented one.
    expect(ANALYSES[4].summary).toBeNull()
    // Every declared probe key is one of the two exercised here or one of the
    // two other probes — all four are pinned to have a summary by the source pin below.
    expect(PROBE_KEYS).toHaveLength(4)
  })

  it('the cluster carries the probe summary and its paragraph, not a slice of the paragraph', () => {
    const returning = CLUSTERS.find(c => c.probe === 'returning-client-request-stage')!
    expect(returning.summary).toBe('Built: a returning website enquiry now shows in the Inbox, marked Back again.')
    expect(returning.what).toContain('OPENING_STAGE.request')
    expect(returning.itemIds.sort()).toEqual(['arlene', 'diane'])
  })

  it('all four probes declare a summary in source — no probe ships without one', () => {
    const src = readFileSync('lib/feedback-analysis.ts', 'utf8')
    const probes = (src.match(/probe: '[a-z-]+',\n\s+confidence:/g) || []).length
    const summaries = (src.match(/\n\s+summary: '/g) || []).length
    expect(probes).toBe(4)
    expect(summaries).toBe(4)
  })
})

// ─── the bar ──────────────────────────────────────────────────────────

describe('one bar renders per cluster, with the count and a sentence', () => {
  it('two clusters → two bars, biggest first, each a count plus the plain sentence and nothing else', async () => {
    const { host, unmount } = await screenFor()
    const b = bars(host)
    expect(b).toHaveLength(2)
    for (const bar of b) {
      expect(bar.textContent).toMatch(/^◈?\s*2 reports, one cause — /)
      expect(bar.textContent).not.toMatch(IDENTIFIERS)
      expect(bar.textContent).not.toContain('affected')
      expect(bar.tagName).toBe('BUTTON')
      expect(bar.style.minHeight).toBe('44px')
    }
    const texts = b.map(x => x.textContent || '')
    expect(texts.some(t => t.includes('Built: a returning website enquiry now shows in the Inbox, marked Back again.'))).toBe(true)
    expect(texts.some(t => t.includes('An archived job with no invoice freezes the engagement at Final Processing.'))).toBe(true)
    await unmount()
  })

  it('the bars sit above the queues', async () => {
    const { host, unmount } = await screenFor()
    const needs = host.querySelector('section[aria-label="Needs an answer"]')!
    expect(bars(host)[0].compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await unmount()
  })

  it('the mechanism paragraph is nowhere on the list', async () => {
    const { host, unmount } = await screenFor()
    expect(host.textContent).not.toMatch(IDENTIFIERS)
    await unmount()
  })
})

// ─── the modal ────────────────────────────────────────────────────────

describe('the bar opens the modal', () => {
  const openReturning = async (host: Element) => {
    const bar = bars(host).find(b => (b.textContent || '').includes('Back again'))!
    await click(bar)
    return modal(host)!
  }

  it('heading carries the count and the impact, and says only the team sees it', async () => {
    const { host, unmount } = await screenFor()
    expect(modal(host)).toBeNull()
    const m = await openReturning(host)
    expect(m).toBeTruthy()
    expect(m.querySelector('h2')!.textContent).toContain('2 reports, one cause')
    expect(m.querySelector('h2')!.textContent).toContain('17 returning clients affected')
    expect(m.textContent).toContain('Only the team sees this')
    await unmount()
  })

  it('"What is happening" is the plain sentence; the members list who, where and how long', async () => {
    const { host, unmount } = await screenFor()
    const m = await openReturning(host)
    expect(m.textContent).toContain('What is happening')
    expect(m.textContent).toContain('Built: a returning website enquiry now shows in the Inbox, marked Back again.')
    expect(m.textContent).toContain('The 2 reports')
    expect(m.textContent).toContain('Nuturing 2')
    expect(m.textContent).toContain('Lynette Ewy · Kansas City · waiting 30 days')
    expect(m.textContent).toContain('Amy Kerr · Office Organization · waiting 12 days')
    await unmount()
  })

  it('the technical detail is ABSENT from the DOM until disclosed, then shows the paragraph and files verbatim', async () => {
    const { host, unmount } = await screenFor()
    const m = await openReturning(host)
    expect(tech(host)).toBeNull()
    expect(m.textContent).not.toMatch(IDENTIFIERS)
    const toggle = buttons(m).find(b => (b.textContent || '').trim() === 'Show the technical detail')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    expect(tech(host)).toBeTruthy()
    expect(tech(host)!.textContent).toContain('OPENING_STAGE.request')
    expect(tech(host)!.textContent).toContain('lib/engagements.ts:49')
    expect(buttons(m).some(b => (b.textContent || '').trim() === 'Hide the technical detail')).toBe(true)
    await click(buttons(m).find(b => (b.textContent || '').trim() === 'Hide the technical detail')!)
    expect(tech(host)).toBeNull()
    await unmount()
  })

  it('no verdict line is shown — the analysis has no honest source for one', async () => {
    const { host, unmount } = await screenFor()
    const m = await openReturning(host)
    expect(m.textContent).not.toContain('What it needs')
    await unmount()
  })

  it('Escape and the close button both close it', async () => {
    const { host, unmount } = await screenFor()
    await openReturning(host)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(modal(host)).toBeNull()
    await openReturning(host)
    await click(modal(host)!.querySelector('[aria-label="Close"]')!)
    expect(modal(host)).toBeNull()
    await unmount()
  })
})

describe('the footer button selects the same items Show them did', () => {
  it('selects exactly the cluster members, closes the modal, and the verdict bar counts them', async () => {
    const { host, unmount } = await screenFor()
    await click(bars(host).find(b => (b.textContent || '').includes('Back again'))!)
    await click(buttons(modal(host)!).find(b => (b.textContent || '').trim() === 'Select these 2 reports')!)
    expect(modal(host)).toBeNull()
    const checked = ([...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[])
      .filter(c => c.checked).map(c => c.getAttribute('aria-label'))
    expect(checked.sort()).toEqual(['Select Nuturing 2', 'Select Returning client - request showing as Engagement not New'])
    expect(host.textContent).toContain('2 items selected')
    await unmount()
  })
})

// ─── the gate ─────────────────────────────────────────────────────────

describe('nothing renders for an owner-shaped mount', () => {
  it('no bar, no modal, and the analysis route is never asked', async () => {
    const { host, unmount } = await screenFor({ onReportFeedback: () => {} })
    expect(bars(host)).toHaveLength(0)
    expect(modal(host)).toBeNull()
    expect(analysisAsked).toBe(0)
    await unmount()
  })

  it('the list route carries no cluster or analysis field', () => {
    const src = readFileSync('app/api/admin/feedback/route.ts', 'utf8')
    expect(src).not.toMatch(/cluster|analys|summary|probe/i)
  })

  it('the only route that returns clusters is 403 below admin, in source', () => {
    const src = readFileSync('app/api/admin/feedback/analysis/route.ts', 'utf8')
    expect(src).toContain("const ELEVATED_ROLES = ['super_admin', 'admin']")
    expect(src).toMatch(/if \(!caller \|\| !ELEVATED_ROLES\.includes\(caller\.role\)\) \{\s*return NextResponse\.json\(\{ error: 'forbidden' \}, \{ status: 403 \}\)/)
  })
})

describe('source pins', () => {
  const src = readFileSync('components/admin/AdminFeedbackScreen.jsx', 'utf8')
  it('nothing named `top`, no colour literal, the old paragraph line is gone', () => {
    expect(src).not.toMatch(/\b(const|let|var|function)\s+top\b/)
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(src).not.toContain('reports share one root cause')
  })
  it('the sentence is never clamped or truncated — no line clamp on the bar', () => {
    const bar = src.slice(src.indexOf('function ClusterBar'), src.indexOf('function ClusterModal'))
    expect(bar).not.toContain('WebkitLineClamp')
    expect(bar).not.toContain('textOverflow')
  })
})
