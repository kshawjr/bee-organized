// @vitest-environment happy-dom
//
// LOG-CALL hand-up, engagement-card half. The Inbox row already lifts its
// logged call to HiveShell (30435fc) so the person re-derives in every lens;
// the EngagementPanel wrote the SAME client-level reach_out but never handed
// up, so logging from the card left the Inbox/directory stale until reload —
// the exact bug the Inbox build closed, still open on the other surface.
// Pins:
//   · logging from the panel re-derives the person Attempting in the Inbox
//     AND the directory, same session, no reload
//   · the hand-up carries the RAW confirmed row (real server id) — applyTouchpoint
//     no-ops on a missing id, so a pre-mapped entry or an optimistic stub would
//     silently do nothing
//   · the panel's OWN activity slice still updates instantly (kept behavior)
//   · no double-count: the handed-up row and the server echo dedupe by id
//   · the write itself is unchanged (engagement_id still posted)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import HiveShell from '@/components/hive/HiveShell'
import { mergePeopleTouches } from '@/components/hive/shared/peopleTouchPatch'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { touchpointToTimelineEntry } from '@/lib/people-mapper'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// HiveShell subscribes to engagements realtime on mount and createClient THROWS
// on missing env — in a passive effect that would kill the mounting tree.
vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    const ch: any = {}
    ch.on = () => ch
    ch.subscribe = () => ch
    return { channel: () => ch, removeChannel: () => {} }
  },
}))

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// The real row POST /api/touchpoints returns (select('*')) for an
// engagement-scoped log — note the engagement_id the panel sends along.
const touchpointRow = (over: any = {}) => ({
  id: 'tp-panel-1',
  lead_id: 'p1',
  location_uuid: 'loc-uuid-1',
  kind: 'reach_out',
  method: 'call',
  label: 'Reach-out',
  status: null,
  occurred_at: new Date(now).toISOString(),
  engagement_id: 'eng-7',
  ...over,
})

// New: created < 30d, no reach_out yet.
const PEOPLE = [{
  id: 'p1',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3),
  isJunk: false,
  jobberRef: null,
  paidAmount: 0,
  source: 'webform',
  outreachTimeline: [],
}]

const engagementPayload = () => ({
  engagement: {
    id: 'eng-7', client_id: 'p1', title: 'Garage Cleanout', stage: 'Assessment Scheduled',
    created_at: daysAgo(2), total_paid: 0, total_invoiced: 0, description: null,
    project_type: null, closed_at: null, closed_reason: null, closed_note: null,
    location_uuid: 'loc-uuid-1',
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
  client: { id: 'p1', name: 'Sarah Mitchell', email: 'sarah@email.com', phone: '(561) 555-0199' },
  assignees: [],
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

// ── the lift, through the real shell + the real panel ──────────
describe('log call from the engagement card re-derives across lenses (HiveShell)', () => {
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
        const body = JSON.parse(opts.body)
        posts.push(body)
        // The route returns the row it INSERTED (select('*')) — echo the
        // notes back rather than a canned row, so the panel's own render
        // is reading server truth like it does in production.
        return { ok: true, status: 201, json: async () => ({ touchpoint: touchpointRow({ notes: body.notes }) }) } as any
      }
      if (u.includes('/api/engagements/eng-7')) return { ok: true, status: 200, json: async () => engagementPayload() } as any
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

  // Deep-link the panel open (the same standalone EngagementPanel a board
  // click produces) over the Inbox lens, so both surfaces are live at once.
  const mountWithPanel = async (lens = 'inbox') => {
    localStorage.setItem('bee_hive_beta_lens', lens)
    await act(async () => {
      root.render(<HiveShell people={PEOPLE} engagements={[]} locFilter="loc-uuid-1" urlClientId="p1" urlEngagementId="eng-7" />)
    })
    await act(async () => { await Promise.resolve() })
  }

  const text = () => container.textContent || ''
  const byText = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label)

  const logFromPanel = async (note?: string) => {
    const open = byText('Log touchpoint')
    expect(open, 'the panel action row should offer Log touchpoint').toBeTruthy()
    await act(async () => { open!.click() })
    if (note) {
      const input = container.querySelector('input[placeholder="Notes (optional)…"]') as HTMLInputElement
      expect(input, 'the composer should expose a notes input').toBeTruthy()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      await act(async () => {
        setter.call(input, note)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const log = byText('Log')
    expect(log, 'the composer should expose a Log button').toBeTruthy()
    await act(async () => { log!.click() })
    // let the POST promise + the hand-up settle
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
  }

  it('POSTs the unchanged engagement-scoped write', async () => {
    await mountWithPanel()
    await logFromPanel('Left a voicemail')

    expect(posts).toEqual([{
      lead_id: 'p1', kind: 'reach_out', label: 'Reach-out',
      method: 'call', notes: 'Left a voicemail', engagement_id: 'eng-7',
    }])
  })

  it('re-derives the person New → Attempting in the Inbox underneath — no reload', async () => {
    await mountWithPanel('inbox')
    // Section counts are the derivation's own output — a stronger read than
    // the chip, since they prove which bucket the row is actually in.
    expect(text()).toContain('New · 1')
    expect(text()).toContain('Attempting · 0')

    await logFromPanel()

    expect(text()).toContain('New · 0')
    expect(text()).toContain('Attempting · 1')
  })

  it('re-derives the SAME person Attempting in the directory — no reload', async () => {
    // The regression this build closes: the panel wrote, no lens noticed.
    await mountWithPanel('inbox')
    await logFromPanel()

    // Close the overlay, then switch lens on the SAME mounted shell.
    const clientsTab = Array.from(container.querySelectorAll('button'))
      .find(b => (b.textContent || '').trim().startsWith('Clients'))
    expect(clientsTab).toBeTruthy()
    await act(async () => { clientsTab!.click() })

    expect(text()).toContain('Attempting')
    expect(text()).not.toContain('Not Yet Contacted')
  })

  it('still updates the panel’s OWN activity slice instantly (kept behavior)', async () => {
    await mountWithPanel()
    expect(text()).not.toContain('Left a voicemail')

    await logFromPanel('Left a voicemail')

    expect(text()).toContain('Left a voicemail')
  })

  it('hands up the RAW row with the server id (a stub or mapped entry would no-op)', async () => {
    // applyTouchpoint guards on row.id and maps the row ITSELF — this asserts
    // the override that landed is keyed by the real server id, which is the
    // whole reason the later echo can dedupe against it.
    await mountWithPanel()
    await logFromPanel()

    // The person moved, and it moved under the id the server returned.
    const entry = touchpointToTimelineEntry(touchpointRow())
    expect(entry.id).toBe('tp-panel-1')
    const [after] = mergePeopleTouches(PEOPLE as any, { p1: [entry] })
    expect(deriveClientStatus(after, new Set(), now)).toBe('Attempting')
    expect(text()).toContain('Attempting · 1')
  })

  it('does NOT double-count when the server echoes the same touchpoint back', async () => {
    // The additive-by-id guarantee the Inbox path already leans on: the panel
    // hands up the same id the refetch carries, so it collapses to one.
    const entry = touchpointToTimelineEntry(touchpointRow())
    const echoed = [{ ...PEOPLE[0], outreachTimeline: [entry] }]
    const [after] = mergePeopleTouches(echoed as any, { p1: [entry] })

    expect(after.outreachTimeline).toHaveLength(1) // not 2 — the id deduped
    expect(deriveClientStatus(after, new Set(), now)).toBe('Attempting') // no flip-back
  })
})

// ── wiring, source-pinned ──────────────────────────────────────
describe('wiring: the panel is handed the shell’s touchpoint seam', () => {
  const shell = readFileSync('components/hive/HiveShell.jsx', 'utf8')
  const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')

  it('HiveShell passes applyTouchpoint to EngagementPanel — the SAME seam the Inbox gets', () => {
    // One seam, both surfaces: if these ever diverge the lenses go stale again.
    expect(shell).toMatch(/onCallLogged=\{applyTouchpoint\}/)
    expect(shell.match(/onCallLogged=\{applyTouchpoint\}/g)!.length).toBe(2)
  })

  it('the panel hands up the confirmed row, not an optimistic stub', () => {
    expect(panel).toMatch(/onCallLogged\(client\.id, j\.touchpoint\)/)
    // A fabricated id is the ClientProfile bug (tmp-${Date.now()}) — it would
    // permanently double-count here, since no echo can ever match it.
    expect(panel).not.toMatch(/tmp-\$\{Date\.now\(\)\}/)
  })
})
