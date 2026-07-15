// @vitest-environment happy-dom
//
// LOG-CALL override lifted Inbox → HiveShell. Logging a call writes a real
// client-level reach_out touchpoint, but every lens derives client status from
// person.outreachTimeline — the PAGE-LOAD snapshot — so the write used to only
// surface on reload ("I logged a call and nothing happened"). The Inbox's old
// Inbox-LOCAL loggedIds Set moved its own row and left every other lens stale.
// Pins:
//   · the merge is ADDITIVE-BY-ID, not last-wins: a refetch that returns the
//     same touchpoint cannot double-count it, and the override retires itself
//     (same reference back → no re-render)
//   · a logged call re-derives the person Attempting in the Inbox AND the
//     directory, same session, no reload
//   · the Inbox's instant New → Attempting move still feels instant
//   · a person with no logged call is untouched (derivation unchanged)
//   · only CONFIRMED rows land (no id → no override), and the entry is the
//     SAME shape hydration produces (byte-identical to the server echo)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import HiveShell from '@/components/hive/HiveShell'
import { mergePeopleTouches } from '@/components/hive/shared/peopleTouchPatch'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { touchpointToTimelineEntry } from '@/lib/people-mapper'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// HiveShell subscribes to engagements realtime on mount; the hook already
// degrades when createClient throws, but stub it so the suite isn't asserting
// through a console.error path unrelated to this build.
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    channel: () => {
      const ch: any = {}
      ch.on = () => ch
      ch.subscribe = () => ch
      return ch
    },
    removeChannel: () => {},
  }),
}))

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// The real row POST /api/touchpoints returns (select('*') — the full DB row).
const touchpointRow = (over: any = {}) => ({
  id: 'tp-real-1',
  lead_id: 'p1',
  location_uuid: 'loc-uuid-1',
  kind: 'reach_out',
  method: 'call',
  label: 'Reach-out',
  status: null,
  occurred_at: new Date(now).toISOString(),
  engagement_id: null,
  ...over,
})

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3), // New: created < 30d, no reach_out yet
  isJunk: false,
  jobberRef: null,
  paidAmount: 0,
  source: 'webform',
  outreachTimeline: [],
  ...over,
})

// ── the pure merge ────────────────────────────────────────────
describe('mergePeopleTouches (snapshot + additive-by-id override)', () => {
  const entry = touchpointToTimelineEntry(touchpointRow())

  it('layers a logged call onto the page-load snapshot so it derives Attempting', () => {
    const before = person()
    expect(deriveClientStatus(before, new Set(), now)).toBe('New')

    const [after] = mergePeopleTouches([before], { p1: [entry] })
    expect(after.outreachTimeline).toHaveLength(1)
    expect(deriveClientStatus(after, new Set(), now)).toBe('Attempting')
  })

  it('does NOT double-count when a refetch brings the same touchpoint back', () => {
    // The snapshot now carries the server's own copy of the SAME id — exactly
    // what a reload/refetch produces after the write landed.
    const refetched = person({ outreachTimeline: [entry] })
    const [after] = mergePeopleTouches([refetched], { p1: [entry] })

    expect(after.outreachTimeline).toHaveLength(1) // not 2 — the id deduped
    expect(deriveClientStatus(after, new Set(), now)).toBe('Attempting') // no flip-back
  })

  it('retires itself once the server echoes: same reference back, no re-render', () => {
    const refetched = [person({ outreachTimeline: [entry] })]
    expect(mergePeopleTouches(refetched, { p1: [entry] })).toBe(refetched)
    const people = [person()]
    expect(mergePeopleTouches(people, {})).toBe(people)
  })

  it('leaves a person with no logged call untouched (derivation unchanged)', () => {
    const other = person({ id: 'p2' })
    const [p1, p2] = mergePeopleTouches([person(), other], { p1: [entry] })
    expect(p2).toBe(other) // same reference — genuinely untouched
    expect(deriveClientStatus(p2, new Set(), now)).toBe('New')
    expect(deriveClientStatus(p1, new Set(), now)).toBe('Attempting')
  })

  it('keeps the timeline sorted occurred_at ASCENDING (people-mapper contract)', () => {
    const older = touchpointToTimelineEntry(touchpointRow({ id: 'tp-old', occurred_at: daysAgo(10) }))
    const [after] = mergePeopleTouches([person({ outreachTimeline: [entry] })], { p1: [older] })
    expect(after.outreachTimeline.map((t: any) => t.id)).toEqual(['tp-old', 'tp-real-1'])
  })

  it('projects the entry to the SAME shape hydration produces', () => {
    // The override and the server echo must agree by construction — that is
    // what makes the id dedupe safe rather than a coin flip.
    expect(entry).toEqual({
      id: 'tp-real-1',
      type: 'reach_out', // kind → type: the field the derivation reads
      method: 'call',
      label: 'Reach-out',
      ts: expect.any(String),
      occurred_at: expect.any(String),
      status: 'done',
    })
  })
})

// happy-dom v20 ships no localStorage — stub one so the lens hydration in
// useStoredState runs for real instead of being try/catch-swallowed.
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

// ── the lift, through the real shell ──────────────────────────
describe('log call re-derives across lenses (HiveShell)', () => {
  let container: HTMLDivElement
  let root: Root
  let posts: any[] = []

  beforeEach(() => {
    posts = []
    vi.stubGlobal('localStorage', lsMock)
    lsStore.clear()
    global.fetch = vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (u.startsWith('/api/touchpoints') && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body))
        return { ok: true, status: 201, json: async () => ({ touchpoint: touchpointRow() }) } as any
      }
      if (u.startsWith('/api/lookups')) return { ok: true, status: 200, json: async () => ({ lookups: [] }) } as any
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) act(() => root.unmount())
    if (container) container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const mount = (lens: string, people: any[]) => {
    localStorage.setItem('bee_hive_beta_lens', lens)
    act(() => {
      root.render(<HiveShell people={people} engagements={[]} locFilter="loc-uuid-1" />)
    })
  }

  const rowText = () => container.textContent || ''

  // The row's phone icon OPENS the shared TouchpointModal now (prefilled to
  // 'call') instead of firing a hardcoded one-click write — so the log is two
  // gestures: the row affordance, then the modal's commit.
  const clickLogCall = async () => {
    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => (b.getAttribute('aria-label') || '') === 'Log call')
    expect(btn, 'Log call button should be on the New row').toBeTruthy()
    await act(async () => { btn!.click() })

    const commit = Array.from(container.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim() === 'Log call')
    expect(commit, 'the row action should open the modal, whose footer restates the method').toBeTruthy()
    await act(async () => { commit!.click() })
    // let the POST promise + the hand-up settle
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
  }

  it('moves the Inbox row New → Attempting instantly, and POSTs the real write', async () => {
    mount('inbox', [person()])
    // Section counts are the derivation's own output — a stronger read than
    // the chip, since they prove which bucket the row is actually in.
    expect(rowText()).toContain('New · 1')
    expect(rowText()).toContain('Attempting · 0')

    await clickLogCall()

    expect(posts).toEqual([{ lead_id: 'p1', kind: 'reach_out', label: 'Reach-out', method: 'call' }])
    expect(rowText()).toContain('New · 0')
    expect(rowText()).toContain('Attempting · 1')
    // The Log call affordance goes with it (it is gated on the New pill).
    const after = Array.from(container.querySelectorAll('button'))
      .find(b => (b.getAttribute('aria-label') || '') === 'Log call')
    expect(after, 'row moved out of New, so Log call is gone').toBeFalsy()
  })

  it('re-derives the SAME person Attempting in the directory — no reload', async () => {
    // The regression this build closes: the Inbox moved, the directory didn't.
    const people = [person()]
    mount('inbox', people)
    await clickLogCall()

    // Switch lens on the SAME mounted shell — same session, no new props.
    const clientsTab = Array.from(container.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim().startsWith('Clients'))
    expect(clientsTab).toBeTruthy()
    await act(async () => { clientsTab!.click() })

    expect(rowText()).toContain('Sarah Mitchell')
    // The directory renders the derived chip + its Attempting subtitle.
    expect(rowText()).toContain('Attempting')
    expect(rowText()).toContain('Last Reach-Out')
    expect(rowText()).not.toContain('Not Yet Contacted')
  })

  it('does not touch a person who had no call logged', async () => {
    mount('inbox', [person(), person({ id: 'p2', name: 'Dana Reed', email: 'dana@email.com' })])
    await clickLogCall() // fires on the first New row (Sarah)

    const clientsTab = Array.from(container.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim().startsWith('Clients'))
    await act(async () => { clientsTab!.click() })

    // Dana still derives New — the override is scoped to the person it names.
    expect(rowText()).toContain('Dana Reed')
    expect(rowText()).toContain('Not Yet Contacted')
  })
})
