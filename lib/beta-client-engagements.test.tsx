// @vitest-environment happy-dom
//
// "Also on this client" — the sibling engagements the engagement card
// used to hide (EngagementPanel, left column).
//
// WHY THIS EXISTS. Whitney Elliott (Portland) reported a card showing
// "Request" for work that had actually become a job, been completed and
// invoiced. She was right and there was no bug: Lynn Zachman genuinely
// had four engagements, and the completed one was a DIFFERENT card
// Whitney could not see from the one she was on. The data was correct;
// the card was blind.
//
// The load-bearing behaviours pinned here:
//   1. ONE engagement renders NOTHING — no heading, no "none". Most
//      clients have exactly one; an empty block would land on thousands
//      of cards. (Mutation-tested: flipping the guard to length > 0
//      fails "renders no section at all".)
//   2. Newest first, current row included and marked EXACTLY once.
//   3. Money is what distinguishes a won engagement, because BOTH closed
//      stages are gray. A row with an invoiced figure shows it; an open
//      row shows none.
//   4. Chips are composed from stageConfig — Closed Won and Closed Lost
//      are the SAME chip family. A future edit that greens "won" fails
//      here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { CHIP_STYLES, CLOSED_WON, CLOSED_LOST } from '@/components/hive/shared/stageConfig'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const iso = (s: string) => new Date(s).toISOString()

// ── fixtures ──────────────────────────────────────────────────
const eng = (over: any = {}) => ({
  id: 'e-1', client_id: 'c1', client_name: 'Lynn Zachman', location_uuid: 'loc-uuid-1',
  title: 'Pantry reset', stage: 'Request', founded_by: 'manual',
  created_at: iso('2026-08-02'), stage_entered_at: iso('2026-08-02'),
  total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
  service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [],
  ...over,
})
const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const client = (over: any = {}) => ({
  id: 'c1', name: 'Lynn Zachman', email: null, phone: null,
  address: null, city: null, state: null, zip: null,
  location_name: 'Portland', prior_engagements: 0, jobber_connected: false, reviews_link: null,
  source: null, referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [],
  lifetime_paid: 0, other_open: 0, engagements: [],
  ...over,
})
// The sibling row shape the [id] route now returns on client.engagements.
const sib = (id: string, stage: string, created_at: string, over: any = {}) => ({
  id, stage, created_at: iso(created_at), title: null,
  total_invoiced: 0, total_paid: 0, ...over,
})

let panelPayload: any = null
const fetchMock = vi.fn(async () => ({ ok: true, json: async () => panelPayload }) as any)

const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

const roots: any[] = []
beforeEach(() => {
  panelPayload = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
  document.body.innerHTML = ''
})
afterEach(() => {
  roots.splice(0).forEach(r => { try { act(() => r.unmount()) } catch {} })
  vi.unstubAllGlobals()
})

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  roots.push(root)
  return container
}
const settle = () => act(async () => {})

// Mount the panel with a given set of sibling rows and let the fetch land.
async function openPanel(siblings: any[], engOver: any = {}, engagementId = 'e-1') {
  panelPayload = {
    engagement: eng(engOver),
    assignees: [],
    children: emptyChildren(),
    drip: null,
    client: client({ engagements: siblings }),
  }
  const c = mount(<EngagementPanel engagementId={engagementId} seed={null} onClose={() => {}} />)
  await settle()
  return c
}

const section = (c: Element) => c.querySelector('[data-client-engagements="1"]')
const rows = (c: Element) => [...c.querySelectorAll('[data-client-eng]')]
const rowIds = (c: Element) => rows(c).map(r => r.getAttribute('data-client-eng'))
const chipOf = (c: Element, id: string) =>
  c.querySelector(`[data-client-eng-chip="${id}"]`)?.firstElementChild as HTMLElement | undefined
const moneyOf = (c: Element, id: string) =>
  c.querySelector(`[data-client-eng-money="${id}"]`)?.textContent?.trim() ?? null

describe('EngagementPanel — Also on this client', () => {
  it('a client with ONE engagement renders no section at all', async () => {
    const c = await openPanel([sib('e-1', 'Request', '2026-08-02')])
    // Not an empty heading, not a "none" line — nothing.
    expect(section(c)).toBeNull()
    expect(rows(c)).toHaveLength(0)
    expect(c.textContent).not.toContain('Also on this client')
  })

  it('a client with ZERO returned rows also renders nothing (defensive)', async () => {
    const c = await openPanel([])
    expect(section(c)).toBeNull()
    expect(c.textContent).not.toContain('Also on this client')
  })

  it('a client with several renders them newest first', async () => {
    // Handed to the panel in deliberately jumbled order — the ORDERING
    // is the panel's job, not the API's.
    const c = await openPanel([
      sib('e-old', 'Closed Lost', '2025-03-11'),
      sib('e-1', 'Request', '2026-08-02'),
      sib('e-new', 'Estimate', '2026-09-01'),
      sib('e-mid', 'Closed Won', '2026-06-20'),
    ])
    expect(section(c)).not.toBeNull()
    expect(rowIds(c)).toEqual(['e-new', 'e-1', 'e-mid', 'e-old'])
  })

  it('the current engagement is present and marked, exactly once', async () => {
    const c = await openPanel([
      sib('e-1', 'Request', '2026-08-02'),
      sib('e-2', 'Closed Won', '2026-06-20'),
      sib('e-3', 'Request', '2026-07-04'),
    ])
    expect(rowIds(c)).toContain('e-1')
    const marked = [...c.querySelectorAll('[data-client-eng-current="1"]')]
    expect(marked).toHaveLength(1)
    expect(marked[0].getAttribute('data-client-eng')).toBe('e-1')
    // The mark is the thin GOLD left rule; every other row keeps a
    // transparent rule of the same width so nothing shifts.
    expect((marked[0] as HTMLElement).style.borderLeft.toLowerCase()).toContain('2px solid')
    const others = rows(c).filter(r => r.getAttribute('data-client-eng') !== 'e-1')
    others.forEach(r => {
      expect((r as HTMLElement).style.borderLeft.toLowerCase()).toContain('transparent')
    })
    // ...and its chip says where you are, instead of repeating the stage.
    expect(chipOf(c, 'e-1')?.textContent).toContain('here')
    expect(chipOf(c, 'e-2')?.textContent).toBe('Closed won')
  })

  it('a won engagement shows its money; an open one shows none', async () => {
    const c = await openPanel([
      sib('e-1', 'Request', '2026-08-02'),
      sib('e-won', 'Closed Won', '2026-06-20', { total_invoiced: 400, total_paid: 400 }),
    ])
    expect(moneyOf(c, 'e-won')).toBe('$400')
    expect(moneyOf(c, 'e-1')).toBeNull()
  })

  it('chips come from stageConfig — Closed Won and Closed Lost are the SAME family', async () => {
    // Guard 1: the config itself. A future edit that greens "won" trips here.
    expect(CHIP_STYLES[CLOSED_WON]).toBe(CHIP_STYLES[CLOSED_LOST])
    expect(CHIP_STYLES[CLOSED_WON]).toBe(CHIP_STYLES.gray)
    expect(CHIP_STYLES[CLOSED_WON]).not.toBe(CHIP_STYLES.green)
    // Request is TEAL — the locked pair, not a hand-rolled colour.
    expect(CHIP_STYLES['Request']).toBe(CHIP_STYLES.teal)

    // Guard 2: what actually RENDERS. A future edit that hand-rolls a
    // green chip in the panel while leaving stageConfig alone trips here.
    const c = await openPanel([
      sib('e-1', 'Estimate', '2026-08-02'),
      sib('e-won', CLOSED_WON, '2026-06-20', { total_invoiced: 400, total_paid: 400 }),
      sib('e-lost', CLOSED_LOST, '2025-03-11'),
    ])
    const won = chipOf(c, 'e-won')!
    const lost = chipOf(c, 'e-lost')!
    expect(won.style.background).toBe(lost.style.background)
    expect(won.style.color).toBe(lost.style.color)
    // and each resolves to the family stageConfig assigns it
    const norm = (v: string) => v.replace(/\s/g, '').toLowerCase()
    expect(norm(won.style.background)).toBe(norm(CHIP_STYLES[CLOSED_WON].bg))
    expect(norm(chipOf(c, 'e-1')!.style.background)).toBe(norm(CHIP_STYLES['Estimate'].bg))
  })

  it("Lynn Zachman's real shape: four engagements, the completed one visible", async () => {
    // The case Whitney reported. Sitting on a Request card, the owner can
    // now see the Closed Won with $400 invoiced and paid — the fact that
    // told her the work was actually done.
    const c = await openPanel([
      sib('lz-1', 'Request', '2026-08-02'),
      sib('lz-2', 'Request', '2026-07-14'),
      sib('lz-3', CLOSED_WON, '2026-06-20', { total_invoiced: 400, total_paid: 400, title: 'Garage' }),
      sib('lz-4', CLOSED_LOST, '2025-03-11'),
    ], {}, 'lz-1')

    expect(rowIds(c)).toEqual(['lz-1', 'lz-2', 'lz-3', 'lz-4'])
    // exactly one marked, and it is the card we are on
    const marked = [...c.querySelectorAll('[data-client-eng-current="1"]')]
    expect(marked).toHaveLength(1)
    expect(marked[0].getAttribute('data-client-eng')).toBe('lz-1')
    // the money is on the won row and nowhere else
    expect(moneyOf(c, 'lz-3')).toBe('$400')
    expect(moneyOf(c, 'lz-1')).toBeNull()
    expect(moneyOf(c, 'lz-2')).toBeNull()
    expect(moneyOf(c, 'lz-4')).toBeNull()
    // the two closed rows are chip-identical — money, not colour, is the
    // difference between them
    expect(chipOf(c, 'lz-3')!.style.background).toBe(chipOf(c, 'lz-4')!.style.background)
    // the untitled rows still read as something (displayTitle fallback)
    expect(c.querySelector('[data-client-eng="lz-3"]')?.textContent).toContain('Garage')
  })

  it('rows are inert — no buttons, links or click handlers in the section', async () => {
    // The panel has no engagement-to-engagement navigation seam, so the
    // rows must not pretend to be tappable. This also keeps the section
    // clear of the globals.css button{font-size:16px!important} trap.
    const c = await openPanel([
      sib('e-1', 'Request', '2026-08-02'),
      sib('e-2', 'Closed Won', '2026-06-20', { total_invoiced: 400, total_paid: 400 }),
    ])
    const sec = section(c)!
    expect(sec.querySelectorAll('button')).toHaveLength(0)
    expect(sec.querySelectorAll('a')).toHaveLength(0)
    expect(sec.querySelectorAll('[role="button"]')).toHaveLength(0)
  })

  it('the section loads with the panel — no extra fetch per row (no N+1)', async () => {
    const c = await openPanel([
      sib('e-1', 'Request', '2026-08-02'),
      sib('e-2', 'Request', '2026-07-14'),
      sib('e-3', CLOSED_WON, '2026-06-20', { total_invoiced: 400, total_paid: 400 }),
      sib('e-4', CLOSED_LOST, '2025-03-11'),
    ])
    expect(rows(c)).toHaveLength(4)
    // Four rows rendered off ONE request: the panel's own engagement GET.
    const urls = fetchMock.mock.calls.map((a: any[]) => String(a[0]))
    expect(urls).toEqual(['/api/engagements/e-1'])
  })
})
