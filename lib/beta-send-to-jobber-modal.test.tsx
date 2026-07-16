// @vitest-environment happy-dom
//
// THE Send-to-Jobber wizard, rebuilt onto the hive modal system
// (OverlayShell + tokens + compact buttons) while PRESERVING the 4-step
// machine, the endpoint, the request body, and the address guard. Pins:
//   · 4 steps, forward + Back, on OverlayShell (role=dialog + Esc, compact
//     footer buttons — not full-width slabs)
//   · confirm step VARIANT 2: an itemized "will create in Jobber" list that
//     reflects the ACTUAL payload (existing vs new client; assessment only
//     when toggled on with a date)
//   · the POST body is byte-unchanged: request_only vs request_with_assessment,
//     engagement_id only when provided, scheduled_assessment_at only with an
//     assessment
//   · error path: success!==true → banner + the button becomes Retry
//   · success hands up (a) the person patch AND (b) the raw Jobber ids, so a
//     server-loaded surface flips its gate live
//   · the stale-button fix: ClientProfile + EngagementPanel flip Send →
//     "Open in Jobber" from jobberLinks WITHOUT a refetch (their own loaded
//     record still says jobber_client_id:null)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SendToJobberModal from '@/components/hive/SendToJobberModal'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Sarah Mitchell',
  outreachTimeline: [],
  assessment: null,
  assessmentType: 'in-person',
  addresses: [{ street: '123 Main St' }],
  jobberClient: null,
  locationName: 'Denver',
  ...over,
})

// ═══ 1) the wizard, standalone ═════════════════════════════════
describe('SendToJobberModal — the 4-step wizard, reskinned', () => {
  let host: HTMLDivElement
  let root: Root
  let posts: any[] = []
  let sendResponse: any = { success: true, match_status: 'new_client', jobber_client_id: '555', jobber_request_id: '777' }
  let sendOk = true

  const mount = async (props: any = {}) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<SendToJobberModal person={person()} onDone={() => {}} onClose={() => {}} {...props} />)
    })
  }

  beforeEach(() => {
    posts = []
    sendOk = true
    sendResponse = { success: true, match_status: 'new_client', jobber_client_id: '555', jobber_request_id: '777' }
    global.fetch = vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (u.includes('/send-to-jobber') && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body))
        return { ok: sendOk, status: sendOk ? 200 : 500, json: async () => sendResponse } as any
      }
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any
  })

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    if (host) host.remove()
    vi.restoreAllMocks()
  })

  const buttons = () => Array.from(host.querySelectorAll('button'))
  const byText = (t: string) => buttons().find(b => (b.textContent || '').trim() === t)
  const contains = (t: string) => buttons().find(b => (b.textContent || '').includes(t))
  const aria = (l: string) => buttons().find(b => b.getAttribute('aria-label') === l)
  const setInput = async (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const flush = async () => { await act(async () => { await Promise.resolve() }); await act(async () => { await Promise.resolve() }) }

  // walk action → request-details (Request selected)
  const toDetails = async () => {
    await act(async () => { aria('Create a Request')!.click() })
    await act(async () => { contains('Continue')!.click() })
  }

  it('announces itself as a Send to Jobber dialog and starts on the action step', async () => {
    await mount()
    const dlg = host.querySelector('[role="dialog"]') as HTMLElement
    expect(dlg).toBeTruthy()
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.getAttribute('aria-label')).toBe('Send to Jobber')
    expect(aria('Create a Request'), 'the action chooser tile').toBeTruthy()
  })

  it('steps forward action → request-details → confirm, and Back returns', async () => {
    await mount()
    await toDetails()
    expect(host.querySelector('button[aria-label="Include assessment"]'), 'on request-details').toBeTruthy()
    await act(async () => { contains('Review')!.click() })
    expect(host.textContent).toContain('This will create in Jobber') // confirm
    await act(async () => { byText('Back')!.click() })
    expect(host.querySelector('button[aria-label="Include assessment"]'), 'Back to request-details').toBeTruthy()
  })

  it('Continue is disabled until an action is picked (the step machine is preserved)', async () => {
    await mount()
    const cont = contains('Continue') as HTMLButtonElement
    expect(cont.disabled).toBe(true)
    await act(async () => { aria('Create a Request')!.click() })
    expect((contains('Continue') as HTMLButtonElement).disabled).toBe(false)
  })

  // ── confirm step, variant 2 ──────────────────────────────────
  it('confirm (new client, no assessment) lists New client + Request, no assessment row', async () => {
    await mount()
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    const t = host.textContent || ''
    expect(t).toContain('New client')
    expect(t).toContain('Sarah Mitchell')
    expect(t).toContain('Request')
    expect(t).not.toContain('Assessment appointment')
  })

  it('confirm (new client + assessment) adds the assessment row reflecting type/date/time', async () => {
    await mount()
    await toDetails()
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Include assessment"]')!.click() })
    await setInput(host.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement, '2026-08-01')
    await act(async () => { contains('Review')!.click() })
    const t = host.textContent || ''
    expect(t).toContain('Assessment appointment')
    expect(t).toContain('In-person')
    expect(t).toContain('2026-08-01')
  })

  it('confirm (existing client) shows the existing-client row, never "New client"', async () => {
    await mount({ person: person({ jobberClient: { clientId: 'JC-42', jobs: [] } }) })
    // starts on history → Continue → action → pick Request → Continue → Review
    await act(async () => { contains('Continue')!.click() }) // history → action
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    const t = host.textContent || ''
    expect(t).toContain('Existing client · JC-42')
    expect(t).not.toContain('New client')
  })

  // ── the POST body is unchanged ───────────────────────────────
  it('request_only: posts { creation_type: "request_only" } — no engagement_id, no assessment fields', async () => {
    await mount()
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await flush()
    expect(posts).toEqual([{ creation_type: 'request_only' }])
  })

  it('engagement_id rides ONLY when provided', async () => {
    await mount({ engagementId: 'eng-9' })
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await flush()
    expect(posts[0]).toEqual({ creation_type: 'request_only', engagement_id: 'eng-9' })
  })

  it('request_with_assessment: adds scheduled_assessment_at (ISO) + assessment_type, only with an assessment', async () => {
    await mount()
    await toDetails()
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Include assessment"]')!.click() })
    await setInput(host.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement, '2026-08-01')
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await flush()
    expect(posts[0].creation_type).toBe('request_with_assessment')
    expect(posts[0].assessment_type).toBe('in-person')
    expect(typeof posts[0].scheduled_assessment_at).toBe('string')
    expect(Number.isNaN(Date.parse(posts[0].scheduled_assessment_at))).toBe(false)
  })

  // ── success + error hand-up ──────────────────────────────────
  it('success hands up (a) the person patch AND (b) the raw Jobber ids', async () => {
    const onDone = vi.fn()
    await mount({ onDone })
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await flush()
    expect(onDone).toHaveBeenCalledTimes(1)
    const [patch, result] = onDone.mock.calls[0]
    expect(patch.stage).toBe('Request')
    expect(patch.jobberRef).toBe('REQ-777')
    // the ids the stale-button fix needs
    expect(result).toMatchObject({ jobber_client_id: '555', jobber_request_id: '777' })
  })

  it('error (success:false) shows the banner with error+stage and flips the button to Retry — no onDone', async () => {
    sendResponse = { success: false, error: 'client not found', stage: 'client_search' }
    const onDone = vi.fn()
    await mount({ onDone })
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await flush()
    expect(onDone).not.toHaveBeenCalled()
    expect(host.textContent).toContain('client not found')
    expect(host.textContent).toContain('client_search')
    expect(contains('Retry'), 'the send button restates as Retry').toBeTruthy()
    expect(contains('Send to Jobber')).toBeFalsy()
  })

  it('a retry after an error re-POSTs the same body (no extra Jobber records beyond the same call)', async () => {
    sendResponse = { success: false, error: 'boom', stage: 'token' }
    await mount()
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    await flush()
    expect(posts).toHaveLength(1)
    sendResponse = { success: true, match_status: 'new_client', jobber_client_id: '9', jobber_request_id: '9' }
    await act(async () => { contains('Retry')!.click() })
    await flush()
    expect(posts).toHaveLength(2)
    expect(posts[0]).toEqual(posts[1]) // identical body — a retry, not a mutation
  })

  it('Esc closes it — OverlayShell brings the backdrop and the X, not this', async () => {
    const onClose = vi.fn()
    await mount({ onClose })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // ── compact chrome (standing preference — never chunky) ──────
  it('footer buttons are compact — 8px 15px / 13px, right-aligned, NOT full-width slabs', async () => {
    await mount()
    await toDetails()
    await act(async () => { contains('Review')!.click() })
    for (const b of [byText('Back')!, contains('Send to Jobber')!]) {
      expect(b.style.padding).toBe('8px 15px')
      expect(b.style.fontSize).toBe('13px')
      expect(b.style.width, 'must not stretch full width').toBe('')
    }
    const footer = contains('Send to Jobber')!.parentElement as HTMLElement
    expect(footer.style.justifyContent).toBe('flex-end')
  })

  it('the shell it composes is OverlayShell at a pinned width, not a hand-rolled popup', () => {
    const src = readFileSync('components/hive/SendToJobberModal.jsx', 'utf8')
    expect(src).toContain("import OverlayShell from './OverlayShell'")
    expect(src).toContain('const MODAL_WIDTH = 380')
    expect(src).toContain('maxWidth={MODAL_WIDTH}')
    // fully tokenized — the beta-hive-tokens sweep would fail on any literal
    expect(/#[0-9a-fA-F]{3,8}\b/.test(src)).toBe(false)
    expect(/rgba?\(/.test(src)).toBe(false)
  })
})

// ═══ 2) the stale-button fix — overlays flip WITHOUT a refetch ══
// The record's OWN loaded data still says jobber_client_id:null; the live
// jobberLinks patch is what flips Send → "Open in Jobber" in place.
describe('live send-flip — panel/profile read jobberLinks, not just server data', () => {
  let container: HTMLDivElement
  let root: Root

  const clientProfilePayload = () => ({
    client: {
      id: 'p1', name: 'Sarah Mitchell', first_name: 'Sarah', last_name: 'Mitchell',
      email: 'sarah@email.com', phone: null, address: null, city: null, state: null, zip: null,
      created_at: daysAgo(3), source: 'webform', jobber_client_id: null,
      location_uuid: 'loc-uuid-1', location_id: null, paid_amount: 0, request_details: null,
      project_type: null, location_name: 'Denver',
    },
    referred_us: [], contacts: [], engagements: [], touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
    aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
  })
  const emptyChildren = { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] }
  const panelData = {
    engagement: { id: 'eng-1', client_id: 'p1', stage: 'Request', founded_by: 'manual', title: 'Engagement – Jul 2026', created_at: daysAgo(0), total_invoiced: 0, total_paid: 0, balance_owing: 0 },
    children: emptyChildren,
    client: { id: 'p1', name: 'Sarah Mitchell', email: 'sarah@email.com', phone: null, prior_engagements: 0, other_open: 0, lifetime_paid: 0, buzz: [] },
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', lsMock)
    lsStore.clear()
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('/api/clients/p1/profile')) return { ok: true, status: 200, json: async () => clientProfilePayload() } as any
      if (/\/api\/engagements\/[^/?]+$/.test(u)) return { ok: true, status: 200, json: async () => panelData } as any
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

  const flush = async () => { await act(async () => { await Promise.resolve() }); await act(async () => { await Promise.resolve() }) }
  const btnByText = (t: string) => Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === t)
  const linkContaining = (t: string) => Array.from(container.querySelectorAll('a')).find(a => (a.textContent || '').includes(t))

  it('ClientProfile: no patch → Send to Jobber; with jobberLinks → Open in Jobber (client link), no refetch', async () => {
    // control — server data has jobber_client_id:null, so Send is offered
    await act(async () => { root.render(<ClientProfile clientId="p1" onClose={() => {}} onSendToJobber={() => {}} />) })
    await flush()
    expect(btnByText('Send to Jobber'), 'unlinked → Send').toBeTruthy()
    expect(linkContaining('Open in Jobber')).toBeFalsy()

    // live patch — same null server data, but jobberLinks flips it
    await act(async () => { root.render(<ClientProfile clientId="p1" onClose={() => {}} onSendToJobber={() => {}} jobberLinks={{ p1: { jobber_client_id: '555', jobber_request_id: '777' } }} />) })
    await flush()
    expect(btnByText('Send to Jobber'), 'linked live → Send gone').toBeFalsy()
    const link = linkContaining('Open in Jobber')
    expect(link, 'linked live → Open in Jobber').toBeTruthy()
    expect((link as HTMLAnchorElement).href).toContain('/clients/555')
  })

  it('EngagementPanel: founded-not-sent offers Send; a live send patch hides it and points Open in Jobber at the request', async () => {
    await act(async () => { root.render(<EngagementPanel engagementId="eng-1" onClose={() => {}} onSendToJobber={() => {}} setToast={() => {}} />) })
    await flush()
    expect(Array.from(container.querySelectorAll('button')).some(b => (b.textContent || '').includes('Send to Jobber')), 'founded-not-sent → Send').toBe(true)

    await act(async () => { root.render(<EngagementPanel engagementId="eng-1" onClose={() => {}} onSendToJobber={() => {}} setToast={() => {}} jobberLinks={{ p1: { jobber_client_id: '555', jobber_request_id: '777' } }} />) })
    await flush()
    expect(Array.from(container.querySelectorAll('button')).some(b => (b.textContent || '').includes('Send to Jobber')), 'live send → Send gone').toBe(false)
    const link = linkContaining('Open in Jobber')
    expect(link, 'live send → Open in Jobber').toBeTruthy()
    expect((link as HTMLAnchorElement).href).toContain('/requests/777')
  })
})
