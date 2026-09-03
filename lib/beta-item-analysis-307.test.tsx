// @vitest-environment happy-dom
//
// issue 307 — the per-item analysis. Step 3 of five.
//
// Every fixture here is TRANSCRIBED FROM THE FIVE-ITEM HAND RUN that gated
// this build, not invented to make the code pass. The evidence values are the
// real production shapes: Mario's engagement really does have one archived job
// and no invoices; Carmel's outbound log really is twelve staff notifications
// and zero client-facing sends; Diane Stern really has two closed engagements
// and one open one at Request.
//
// What is pinned:
//   · a confident analysis renders WITH its confidence — an unlabelled
//     paragraph reads as certain, and a confident wrong analysis is the one
//     failure this step must not ship
//   · an item nothing recognises says so, and produces no file, no count and
//     no diagnosis-shaped prose
//   · a fleet count renders ONLY where a probe computed one — never a zero and
//     never an "unknown" standing in for "we did not look"
//   · CLUSTERING IS ON ROOT CAUSE. "Nuturing" and "Nuturing 2" share a rare
//     word and must NOT cluster; "Nuturing 2" and the Arlene report share no
//     distinctive vocabulary and MUST
//   · the cache invalidates when an item changes
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  analyseItem, clusterAnalyses, analysisSignature, PROBE_KEYS,
} from '@/lib/feedback-analysis'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// The fleet counts as actually computed against production during the hand run.
const FLEET = {
  'stuck-final-processing': {
    count: 106, unit: 'engagements',
    basis: 'at Final Processing, with an archived job, and no fully-paid invoice to unlock Mark won',
  },
  'returning-client-request-stage': {
    count: 17, unit: 'returning clients',
    basis: 'have a prior closed engagement and only Request-stage open work, so they derive Active and leave the Inbox',
  },
}

// ─── The five hand-run items, verbatim ────────────────────────────────

const MARIO = {
  id: 'mario', type: 'bug', title: 'Problem with Office Organization',
  description: 'Mario is closed out and paid.',
  context: { kind: 'engagement', engagement_id: 'e-mario', stage: 'Final Processing' },
}
const MARIO_EV = {
  engagement: { id: 'e-mario', stage: 'Final Processing', jobCount: 1, archivedJobCount: 1, quoteCount: 0, invoiceCount: 0, paidInvoiceCount: 0 },
  fleet: FLEET,
}

const APPRECIATION = {
  id: 'appreciation', type: 'bug',
  title: 'Client was pushed an appreciation email that I never created',
  description: 'I had a client forward an email thanking them for their recent business and offering a discount for a google review. I did not create this email.',
}
const APPRECIATION_EV = {
  locationSends: { kinds: { lead_notification: 12, lead_resubmission: 3 }, clientFacingCount: 0 },
  fleet: FLEET,
}

// Wants a bulk status change. Status is DERIVED, so the ask is impossible as
// written — but no probe covers that yet, so the honest output is silence.
const NUTURING_BULK = {
  id: 'nuturing', type: 'bug', title: 'Nuturing',
  description: 'I have 200+ clients in nurturing, any way to bulk update and send them to client',
}

// Shares the rare word "Nuturing" with the item above and is a DIFFERENT
// problem — it is the returning-client mechanism.
const NUTURING_DIANE = {
  id: 'nuturing2', type: 'bug', title: 'Nuturing 2',
  description: 'Diane Stern, how do I move her out of nuturing and back into my the assessment tab?',
}
const DIANE_EV = {
  namedLeads: [{ query: 'Diane Stern', found: true, id: 'l-diane', name: 'Diane Stern', openIsRequestOnly: true, hasPriorClosed: true }],
  fleet: FLEET,
}

// Shares NO distinctive vocabulary with "Nuturing 2" and is the same root cause.
const ARLENE = {
  id: 'arlene', type: 'bug', title: 'Returning client - request showing as Engagement not New',
  description: 'I had a returning client Arlene Kaseff send in a request. She was put in my Engagements bucket and not New bucket.',
}
const ARLENE_EV = {
  namedLeads: [{ query: 'Arlene Kaseff', found: true, id: 'l-arlene', name: 'Arlene Kaseff', openIsRequestOnly: true, hasPriorClosed: true }],
  fleet: FLEET,
}

const LAURA = {
  id: 'laura', type: 'bug', title: 'Missing clients',
  description: "I had an old request from Laura Laundermilk. She isn't showing up in our CRM. Did those Awaiting Response clients all get moved over to this new CRM?",
}
const LAURA_EV = { namedLeads: [{ query: 'Laura Laundermilk', found: false }], fleet: FLEET }

const EMAIL_CUT = {
  id: 'emailcut', type: 'bug', title: 'Email cut off',
  description: "Email address is cut off if it's too long",
}

const run = (item: any, evidence: any = {}) => analyseItem({ item, evidence, index: null })

// ─── The pure layer ───────────────────────────────────────────────────

describe('a probe fires only on evidence', () => {
  it('places Mario confidently, with the mechanism and the files', () => {
    const a = run(MARIO, MARIO_EV)
    expect(a.probe).toBe('stuck-final-processing')
    expect(a.confidence).toBe('confident')
    expect(a.what).toContain('Final Processing')
    expect(a.files.join(' ')).toContain('lib/engagements.ts')
    expect(a.size).toContain('medium')
  })

  // The same engagement with a paid invoice is NOT stuck — Mark won renders.
  it('goes quiet when the engagement can actually reach Closed Won', () => {
    const a = run(MARIO, { ...MARIO_EV, engagement: { ...MARIO_EV.engagement, invoiceCount: 1, paidInvoiceCount: 1 } })
    expect(a.probe).toBeNull()
    expect(a.confidence).toBe('none')
  })

  // Without an archived job the freeze has some other cause, so say nothing.
  it('goes quiet at Final Processing with no archived job', () => {
    const a = run(MARIO, { ...MARIO_EV, engagement: { ...MARIO_EV.engagement, archivedJobCount: 0 } })
    expect(a.probe).toBeNull()
  })

  it('says Bee Hub did not send the appreciation email, and names no file', () => {
    const a = run(APPRECIATION, APPRECIATION_EV)
    expect(a.probe).toBe('not-sent-by-hub')
    expect(a.confidence).toBe('confident')
    expect(a.what).toContain('did not send this')
    // A real answer that correctly points at no file at all.
    expect(a.files).toEqual([])
    expect(a.fleet).toBeNull()
  })

  // The evidence is an ABSENCE. If the location HAS mailed clients, the
  // absence argument collapses and the probe must stop making it.
  it('goes quiet once the location has sent client-facing mail', () => {
    const a = run(APPRECIATION, { ...APPRECIATION_EV, locationSends: { kinds: { drip_send: 4 }, clientFacingCount: 4 } })
    expect(a.probe).toBeNull()
  })

  it('confirms a named client is absent rather than guessing why', () => {
    const a = run(LAURA, LAURA_EV)
    expect(a.probe).toBe('named-client-not-found')
    expect(a.what).toContain('Laura Laundermilk')
    expect(a.fleet).toBeNull()
  })

  // One name found and one missing is an ambiguous report, not a gap.
  it('does not claim a migration gap when some named clients DO exist', () => {
    const a = run(LAURA, { namedLeads: [{ query: 'Laura Laundermilk', found: false }, { query: 'Jeanie Launder', found: true, id: 'x' }], fleet: FLEET })
    expect(a.probe).toBeNull()
  })
})

describe('an item that cannot be analysed says so', () => {
  it('produces a question, and nothing that resembles a diagnosis', () => {
    const a = run(EMAIL_CUT, {})
    expect(a.probe).toBeNull()
    expect(a.confidence).toBe('none')
    expect(a.what).toBe('')
    expect(a.files).toEqual([])
    expect(a.fleet).toBeNull()
    expect(a.size).toBeNull()
    expect(a.question).toContain('follow-up question')
  })

  it('the bulk-nurturing ask is not force-fitted onto a probe', () => {
    expect(run(NUTURING_BULK, { fleet: FLEET }).probe).toBeNull()
  })
})

describe('a fleet count appears only where it was computed', () => {
  it('rides the probes that have one', () => {
    expect(run(MARIO, MARIO_EV).fleet).toEqual(FLEET['stuck-final-processing'])
    expect(run(ARLENE, ARLENE_EV).fleet).toEqual(FLEET['returning-client-request-stage'])
  })

  // The probe fires; the count simply was not computable this run. It must
  // degrade to null, NOT to zero — zero would read as "nothing affected".
  it('is null, never zero, when the probe fired but no count was computed', () => {
    const a = run(MARIO, { ...MARIO_EV, fleet: {} })
    expect(a.probe).toBe('stuck-final-processing')
    expect(a.confidence).toBe('confident')
    expect(a.fleet).toBeNull()
  })

  it('is never invented for a probe that has no count to give', () => {
    expect(run(APPRECIATION, APPRECIATION_EV).fleet).toBeNull()
    expect(run(LAURA, LAURA_EV).fleet).toBeNull()
  })
})

// ─── Clustering — THE test this step turns on ─────────────────────────

describe('clustering is on root cause, not on words', () => {
  const analysed = [
    run(NUTURING_BULK, { fleet: FLEET }),
    run(NUTURING_DIANE, DIANE_EV),
    run(ARLENE, ARLENE_EV),
    run(EMAIL_CUT, {}),
    run(MARIO, MARIO_EV),
  ]
  const clusters = clusterAnalyses(analysed)

  it('groups two reports that share a mechanism but no distinctive words', () => {
    const c = clusters.find(x => x.probe === 'returning-client-request-stage')
    expect(c).toBeTruthy()
    expect(c!.itemIds.sort()).toEqual(['arlene', 'nuturing2'])
  })

  // The headline case. Word similarity would put these together on the
  // strength of a rare shared token; they are different problems.
  it('does NOT group two reports that merely share a rare word', () => {
    for (const c of clusters) {
      expect(c.itemIds).not.toContain('nuturing')
    }
    const together = clusters.some(c => c.itemIds.includes('nuturing') && c.itemIds.includes('nuturing2'))
    expect(together).toBe(false)
  })

  it('never clusters the unanalysed together', () => {
    for (const c of clusters) expect(c.probe).toBeTruthy()
    expect(clusters.some(c => c.itemIds.includes('emailcut'))).toBe(false)
  })

  it('a singleton is not a cluster', () => {
    // Mario is the only stuck-final-processing item here.
    expect(clusters.some(c => c.probe === 'stuck-final-processing')).toBe(false)
  })

  it('carries the shared fleet count onto the cluster', () => {
    const c = clusters.find(x => x.probe === 'returning-client-request-stage')!
    expect(c.fleet?.count).toBe(17)
  })
})

// ─── The cache signature ──────────────────────────────────────────────

describe('the cache invalidates when an item changes', () => {
  const base = [
    { id: 'a', updated_at: '2026-08-01T00:00:00Z', status: 'submitted' },
    { id: 'b', updated_at: '2026-08-02T00:00:00Z', status: 'planned' },
  ]

  it('is stable for an unchanged set, in any order', () => {
    expect(analysisSignature(base)).toBe(analysisSignature([...base].reverse()))
  })

  it('changes when an item is touched (updated_at moves)', () => {
    const touched = [{ ...base[0], updated_at: '2026-08-09T00:00:00Z' }, base[1]]
    expect(analysisSignature(touched)).not.toBe(analysisSignature(base))
  })

  // The verdict actions from step 2 write a status; the signature must move.
  it('changes when a status changes', () => {
    const declined = [{ ...base[0], status: 'declined' }, base[1]]
    expect(analysisSignature(declined)).not.toBe(analysisSignature(base))
  })

  it('changes when an item arrives or leaves', () => {
    expect(analysisSignature([...base, { id: 'c', updated_at: 'x', status: 'submitted' }])).not.toBe(analysisSignature(base))
    expect(analysisSignature([base[0]])).not.toBe(analysisSignature(base))
  })
})

// ─── Mounted ──────────────────────────────────────────────────────────

const ROWS = [
  { id: 'mario', title: 'Problem with Office Organization', description: 'Mario is closed out and paid.', type: 'bug', status: 'submitted', user_id: 'u2', submitter_name: 'Amy', submitter_email: 'amy@oo.com', location_id: 'loc-1', location_name: 'Office Organization', created_at: daysAgo(3), updated_at: daysAgo(3), attachments: [] },
  { id: 'emailcut', title: 'Email cut off', description: "Email address is cut off if it's too long", type: 'bug', status: 'under_review', user_id: 'u2', submitter_name: 'Amy', submitter_email: 'amy@oo.com', location_id: 'loc-1', location_name: 'Office Organization', created_at: daysAgo(59), updated_at: daysAgo(59), attachments: [] },
]

const ANALYSES = [
  { ...run(MARIO, MARIO_EV), itemId: 'mario' },
  { ...run(EMAIL_CUT, {}), itemId: 'emailcut' },
]

const stubFetch = (opts: { analysisOk?: boolean; clusters?: any[] } = {}) => {
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/api/admin/feedback/analysis')) {
      if (opts.analysisOk === false) return { ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }
      return { ok: true, status: 200, json: async () => ({ analyses: ANALYSES, clusters: opts.clusters || [], cached: false }) }
    }
    if (init?.method === 'PATCH') return { ok: true, status: 200, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ items: ROWS }) }
  })
  vi.stubGlobal('fetch', f)
  return f
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {})
  await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const screenFor = (props: any = {}) =>
  mount(
    <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>
      <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
    </CurrentUserContext.Provider>,
  )

beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => { vi.unstubAllGlobals() })

// The queues redesign moved the analysis off the row and into the modal's
// corporate-only block, so every read below opens the item first.
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const openRow = (host: Element, title: string) =>
  click([...host.querySelectorAll('button')].find(b => (b.textContent || '').startsWith(title))!)
const modalText = (host: Element) => (host.querySelector('[role="dialog"]')?.textContent) || ''

describe('the screen renders the analysis', () => {
  it('a confident item shows its analysis WITH its confidence — in the modal, not on the row', async () => {
    stubFetch()
    const { host, unmount } = await screenFor()
    expect(host.textContent).not.toContain('lib/engagements.ts') // nothing corporate on the list
    await openRow(host, 'Problem with Office Organization')
    const t = modalText(host)
    expect(t.toLowerCase()).toContain('confident')
    expect(t).toContain('Final Processing')
    expect(t).toContain('lib/engagements.ts')
    await unmount()
  })

  it('shows the fleet count on the item that has one', async () => {
    stubFetch()
    const { host, unmount } = await screenFor()
    await openRow(host, 'Problem with Office Organization')
    expect(modalText(host)).toContain('106 engagements affected')
    await unmount()
  })

  it('an unanalysable item says so and shows no count or file', async () => {
    stubFetch()
    const { host, unmount } = await screenFor()
    await openRow(host, 'Email cut off')
    const t = modalText(host)
    expect(t).toContain('needs a follow-up question')
    expect(t).toContain('not placed')
    // No count for this one — the only count belongs to Mario.
    expect(t).not.toContain('affected')
    await unmount()
  })

  it('renders a cluster banner when two items share a root cause', async () => {
    stubFetch({ clusters: [{ probe: 'returning-client-request-stage', itemIds: ['mario', 'emailcut'], what: 'A returning client leaves the Inbox.', summary: 'Returning clients leave the Inbox.', fleet: FLEET['returning-client-request-stage'] }] })
    const { host, unmount } = await screenFor()
    // The bar: a count and the plain sentence. The impact number is NOT on
    // the bar — it is in the modal the bar opens.
    const bar = host.querySelector('[data-testid="cluster-bar"]')!
    expect(bar.textContent).toContain('2 reports, one cause')
    expect(bar.textContent).toContain('Returning clients leave the Inbox.')
    expect(bar.textContent).not.toContain('affected')
    await click(bar)
    expect(host.querySelector('[data-testid="cluster-modal"]')!.textContent).toContain('17 returning clients affected')
    await unmount()
  })

  // The analysis is an enrichment; the screen predates it and must survive it.
  it('renders the list normally when the analysis call fails', async () => {
    stubFetch({ analysisOk: false })
    const { host, unmount } = await screenFor()
    expect(host.textContent).toContain('Problem with Office Organization')
    await openRow(host, 'Problem with Office Organization')
    expect(host.textContent).not.toContain('106 engagements affected')
    await unmount()
  })

  it('the franchise mount never asks for it', async () => {
    const f = stubFetch()
    const { unmount } = await screenFor({ onReportFeedback: () => {} })
    const asked = f.mock.calls.some(c => String(c[0]).includes('/analysis'))
    expect(asked).toBe(false)
    await unmount()
  })
})

// ─── The probe set is a closed, named list ────────────────────────────

describe('probes are declared, not inferred', () => {
  it('every probe key is unique and stable', () => {
    expect(new Set(PROBE_KEYS).size).toBe(PROBE_KEYS.length)
    expect(PROBE_KEYS).toContain('stuck-final-processing')
    expect(PROBE_KEYS).toContain('returning-client-request-stage')
  })
})
