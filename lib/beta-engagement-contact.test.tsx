// @vitest-environment happy-dom
//
// Contact info on the deal surfaces (issue 129). MOUNT tests on the three
// LIVE surfaces:
//   · EngagementPanel  — a display-only Contact block (phone/email/address)
//     above Description in the right column.
//   · EngagementBoard  — the board card (EngagementCard): a tappable phone
//     line under the client name.
//   · EngagementGroupedList — the list row (EngagementRow): the same phone
//     line (twin lens).
//
// The load-bearing behavior, pinned here: the phone anchor's stopPropagation
// means tapping the NUMBER dials, while a tap anywhere else on the tile still
// opens the panel. That is the whole risk of the change.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import EngagementPanel from '@/components/hive/EngagementPanel'
import EngagementBoard from '@/components/hive/EngagementBoard'
import EngagementGroupedList from '@/components/hive/EngagementGroupedList'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// ── fixtures ──────────────────────────────────────────────────
const eng = (over: any = {}) => ({
  id: 'e-1', client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
  title: 'Garage organization', stage: 'Request', founded_by: 'manual',
  created_at: daysAgo(3), stage_entered_at: daysAgo(3),
  total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
  service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [],
  client_phone: '(561) 555-0100', client_email: 'pat@x.com',
  ...over,
})
const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
// The panel's own richer client object (nested shape) — the [id] route
// selects the full contact set; the panel renders phone/email/address.
const client = (over: any = {}) => ({
  id: 'c1', name: 'Pat Tester', email: 'pat@x.com', phone: '(561) 555-0100',
  address: '123 Main St, Austin, TX, 78701', city: 'Austin', state: 'TX', zip: '78701',
  location_name: 'Palm Beach', prior_engagements: 0, jobber_connected: false, reviews_link: null,
  source: null, referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [],
  ...over,
})

let panelPayload: any = null
const fetchMock = vi.fn(async (url: any, init?: any) => {
  if (init?.method === 'PATCH') return { ok: true, json: async () => ({ id: 'e-1', stage: JSON.parse(init.body).stage }) } as any
  return { ok: true, json: async () => panelPayload } as any
})

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
async function fire(node: Element, type = 'click') {
  await act(async () => { node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })) })
}
const settle = () => act(async () => {})
const leafByText = (root: Element, text: string) =>
  [...root.querySelectorAll('*')].find(n => n.childElementCount === 0 && (n.textContent || '').trim() === text) || null

const mountPanel = async (over: any = {}) => {
  panelPayload = { engagement: eng(), children: emptyChildren(), client: client(over.client || {}) }
  const container = mount(
    <EngagementPanel engagementId="e-1" seed={eng()} readOnly={!!over.readOnly}
      onClose={() => {}} onChanged={() => {}} setToast={() => {}} onReportProblem={() => {}} />
  )
  await settle()
  return container
}

// ── EngagementPanel — the Contact block ───────────────────────
describe('EngagementPanel — Contact block (phone/email display-only, address editable, above Description)', () => {
  it('renders phone/email/address rows from client, as live tel:/mailto: anchors', async () => {
    const c = await mountPanel()
    const phone = c.querySelector('[data-contact-row="phone"] a') as HTMLAnchorElement
    const email = c.querySelector('[data-contact-row="email"] a') as HTMLAnchorElement
    expect(phone?.getAttribute('href')).toBe('tel:(561) 555-0100')
    expect(email?.getAttribute('href')).toBe('mailto:pat@x.com')
    // Address is the dedup-safe composed string — the stored `address`
    // already carries city/state/zip, so it renders once (no double-append).
    const addr = c.querySelector('[data-contact-row="address"]')
    expect((addr?.textContent || '')).toContain('123 Main St')
    // DISPLAY-ONLY: no editable input, no inline-edit pencil in the block.
    expect(c.querySelector('[data-contact-row] input')).toBeNull()
  })

  it('a null PHONE/EMAIL renders NO row — no empty row, no dash', async () => {
    const c = await mountPanel({ client: { email: null, address: null, city: null, state: null, zip: null } })
    expect(c.querySelector('[data-contact-row="phone"]')).toBeTruthy()
    expect(c.querySelector('[data-contact-row="email"]')).toBeNull()
    // The ADDRESS row now always renders when the panel is editable — it is
    // the affordance for adding one, and an engagement is a surface an owner
    // is on when they discover a second address. It shows AddressField's own
    // "add address" empty state rather than an empty row or a dash.
    expect(c.querySelector('[data-contact-row="address"]')).toBeTruthy()
    expect(c.textContent).toContain('add address')
  })

  it('read-only: no phone/email/address means no Contact block at all', async () => {
    const c = await mountPanel({
      readOnly: true,
      client: { phone: null, email: null, address: null, city: null, state: null, zip: null },
    })
    expect(c.querySelectorAll('[data-contact-row]').length).toBe(0)
    expect(leafByText(c, 'Contact')).toBeNull()
  })

  it('the Contact block sits ABOVE Description', async () => {
    const c = await mountPanel()
    const contact = leafByText(c, 'Contact')
    const description = leafByText(c, 'Description')
    expect(contact).toBeTruthy()
    expect(description).toBeTruthy()
    // Contact precedes Description in document order.
    expect(contact!.compareDocumentPosition(description!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the footer Call button is untouched — still present alongside the new phone row', async () => {
    const c = await mountPanel()
    const call = [...c.querySelectorAll('a')].find(a => (a.textContent || '').includes('Call'))
    expect(call?.getAttribute('href')).toBe('tel:(561) 555-0100')
  })
})

// ── EngagementBoard card + EngagementGroupedList row — phone line ──
// Both are twin lenses; the same assertions run against each.
const telAnchor = (c: Element) => c.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null

describe('EngagementBoard card — tappable phone under the name', () => {
  const mountBoard = (over: any = {}, onOpenEngagement = vi.fn()) => {
    const container = mount(
      <EngagementBoard engagements={[eng(over)] as any} closedCount={0}
        onOpenEngagement={onOpenEngagement} setToast={() => {}} />
    )
    return { container, onOpenEngagement }
  }

  it('renders the phone from client_phone (tel: anchor, title set)', () => {
    const { container } = mountBoard()
    const a = telAnchor(container)
    expect(a?.getAttribute('href')).toBe('tel:(561) 555-0100')
    expect(a?.getAttribute('title')).toBe('(561) 555-0100')
  })

  it('null client_phone renders no phone anchor', () => {
    const { container } = mountBoard({ client_phone: null })
    expect(telAnchor(container)).toBeNull()
  })

  it('tapping the phone DIALS and does NOT open the panel; tapping the card DOES', async () => {
    const { container, onOpenEngagement } = mountBoard()
    await fire(telAnchor(container)!)
    expect(onOpenEngagement).not.toHaveBeenCalled()
    // A tap elsewhere on the card (the client name) opens the panel.
    const name = [...container.querySelectorAll('p')].find(p => (p.textContent || '').trim() === 'Pat Tester')!
    await fire(name)
    expect(onOpenEngagement).toHaveBeenCalledTimes(1)
  })
})

describe('EngagementGroupedList row — tappable phone under the name (twin lens)', () => {
  const mountList = (over: any = {}, onOpenEngagement = vi.fn()) => {
    // Bands start collapsed; seed the Request band expanded so its row mounts.
    lsStore.set('bee_hive_eng_collapsed', JSON.stringify({ Request: true }))
    const container = mount(
      <EngagementGroupedList engagements={[eng(over)] as any} closedCount={0}
        onOpenEngagement={onOpenEngagement} setToast={() => {}} />
    )
    return { container, onOpenEngagement }
  }

  it('renders the phone from client_phone (tel: anchor, title set)', async () => {
    const { container } = mountList()
    await settle()
    const a = telAnchor(container)
    expect(a?.getAttribute('href')).toBe('tel:(561) 555-0100')
    expect(a?.getAttribute('title')).toBe('(561) 555-0100')
  })

  it('null client_phone renders no phone anchor', async () => {
    const { container } = mountList({ client_phone: null })
    await settle()
    expect(telAnchor(container)).toBeNull()
  })

  it('tapping the phone DIALS and does NOT open the panel; tapping the row DOES', async () => {
    const { container, onOpenEngagement } = mountList()
    await settle()
    await fire(telAnchor(container)!)
    expect(onOpenEngagement).not.toHaveBeenCalled()
    const name = [...container.querySelectorAll('span')].find(s => (s.textContent || '').trim() === 'Pat Tester')!
    await fire(name)
    expect(onOpenEngagement).toHaveBeenCalledTimes(1)
  })
})
