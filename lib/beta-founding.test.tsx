// @vitest-environment happy-dom
// Decoupled engagement founding (founded_by='manual') — the returning-
// client fix. Covers:
//   - frames B/D "Start new job in Jobber" hand the EXISTING person to the
//     send and found NOTHING locally (2026-09-26 — no work skips Jobber;
//     "Keep local for now" and frame F are gone) — NO second leads row
//   - people-world gates unchanged: Inbox still hides Send on
//     Jobber-linked people (no blanket canSend removal)
//   - EngagementPanel offers Send ONLY on founded-not-sent engagements
//     (zero work records, not terminal)
//   - HiveShell's New sheet sends rather than founds
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NewClientSheet from '@/components/hive/NewClientSheet'
import InboxScreen from '@/components/hive/InboxScreen'
import EngagementPanel from '@/components/hive/EngagementPanel'
import HiveShell from '@/components/hive/HiveShell'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(40),
  isJunk: false,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})

const openEng = (clientId: string, over: any = {}) => ({
  id: 'e-existing-1',
  client_id: clientId,
  client_name: 'Sarah Mitchell',
  location_uuid: 'loc-uuid-1',
  stage: 'Request',
  founded_by: 'request',
  created_at: daysAgo(5),
  stage_entered_at: daysAgo(5),
  quotes: [], jobs: [], invoices: [], assessments: [],
  ...over,
})

const foundedRow = (n: number, clientId: string) => ({
  id: `eng-founded-${n}`,
  client_id: clientId,
  client_name: 'Sarah Mitchell',
  client_phone: null,
  client_email: 'sarah@email.com',
  location_uuid: 'loc-uuid-1',
  stage: 'Request',
  founded_by: 'manual',
  title: 'Engagement – Jul 2026',
  created_at: new Date(now).toISOString(),
  stage_entered_at: new Date(now).toISOString(),
  repeat_count: n,
  quotes: [], jobs: [], invoices: [], assessments: [],
})

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({
  ok: status < 400, status,
  json: async () => body,
})
let leadPosts: any[] = []
let foundPosts: any[] = []
let panelData: any = null
const installFetch = () => {
  leadPosts = []
  foundPosts = []
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (u.includes('/api/lookups')) return jsonRes({ lookups: [] })
    if (/\/api\/engagements\/[^/?]+$/.test(u) && (!opts.method || opts.method === 'GET')) {
      return jsonRes(panelData || {})
    }
    if (u.includes('/api/engagements') && opts.method === 'POST') {
      const body = JSON.parse(opts.body)
      foundPosts.push(body)
      return jsonRes({ engagement: foundedRow(foundPosts.length, body.client_id) }, 201)
    }
    if (u.includes('/api/leads') && opts.method === 'POST') {
      leadPosts.push(JSON.parse(opts.body))
      return jsonRes({ lead: { id: 'lead-dupe-1' } }, 201)
    }
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// ── DOM helpers ────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (input: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const buttonContaining = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

beforeEach(() => installFetch())
afterEach(() => { panelData = null; document.body.style.overflow = '' })

// ═══ a returning client's new job goes to Jobber (2026-09-26) ═══
// Kevin's ruling: no work skips Jobber. Frames B/D used to found a local
// engagement first (POST /api/engagements) and frame F offered "Keep local
// for now" — which only ever made a card that could never become real work.
// Now the sheet founds NOTHING: it hands the EXISTING person to the send
// flow, the request lands on their Jobber client, and the webhook founds the
// engagement. These pin that no local founding and no "Keep local" survive.
describe('NewClientSheet — a returning client\'s new job goes straight to Jobber', () => {
  it('frame B "Start new job in Jobber" sends the EXISTING person and founds nothing locally', async () => {
    const p = person({ jobberRef: '12345' }) // linked — the kitchen-then-bedroom client
    const onSend = vi.fn()
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[p]} engagements={[]} locFilter="loc-uuid-1" onClose={onClose} onSendToJobber={onSend} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    expect(buttonContaining(host, 'Start new engagement'), 'the local-founding action is gone').toBeFalsy()
    await click(buttonContaining(host, 'Start new job in Jobber')!)

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].id).toBe('p1') // the EXISTING person — no duplicate
    expect(onSend.mock.calls[0][1], 'no engagementId: the request founds its own engagement').toBeUndefined()
    expect(onClose).toHaveBeenCalled()
    expect(foundPosts, 'no local engagement is founded — the empty-card path is gone').toHaveLength(0)
    expect(leadPosts, 'never a second leads row').toHaveLength(0)
    await unmount()
  })

  it('frame D (client already has open work) confirms, then sends — still no local founding', async () => {
    const existing = openEng('p1')
    const onSend = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} engagements={[existing]} locFilter="loc-uuid-1" onClose={() => {}} onSendToJobber={onSend} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new job in Jobber')!)
    expect(host.textContent).toContain('This client has an open engagement')
    expect(host.textContent).toContain('becomes a second engagement')
    expect(onSend, 'the confirm gates the send').not.toHaveBeenCalled()
    await click(buttonContaining(host, 'Start another job in Jobber')!)

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].id).toBe('p1')
    expect(foundPosts).toHaveLength(0)
    expect(leadPosts).toHaveLength(0)
    await unmount()
  })

  it('"Keep local for now" exists in no frame — B, D, or after the send', async () => {
    const onSend = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} engagements={[openEng('p1')]} locFilter="loc-uuid-1" onClose={() => {}} onSendToJobber={onSend} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    expect(host.textContent).not.toContain('Keep local') // frame B
    await click(buttonContaining(host, 'Start new job in Jobber')!)
    expect(host.textContent).not.toContain('Keep local') // frame D
    await click(buttonContaining(host, 'Start another job in Jobber')!)
    expect(host.textContent).not.toContain('Keep local') // after
    expect(host.textContent).not.toContain('Engagement started')
    await unmount()
  })

  it('with no send wired, the sheet offers no start at all — never a local-only fallback', async () => {
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} engagements={[]} locFilter="loc-uuid-1" onClose={() => {}} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    expect(buttonContaining(host, 'Start new job')).toBeFalsy()
    expect(buttonContaining(host, 'Start new engagement')).toBeFalsy()
    expect(buttonContaining(host, 'Open client profile')).toBeTruthy()
    expect(foundPosts).toHaveLength(0)
    await unmount()
  })
})

// ═══ people-world gates stay ═══════════════════════════════
describe('canSend — surgical unlock, not a blanket removal', () => {
  it('Inbox offers Send on Jobber-linked people too (Kevin, 2026-09-03: a linked client\'s enquiry needs the same door out)', async () => {
    const linked = person({ jobberRef: '12345', created: daysAgo(2) }) // an open enquiry → Inbox row
    const { host, unmount } = await mount(
      <InboxScreen people={[linked]} engagements={[]} locFilter="all" />
    )
    expect(host.textContent).toContain('Sarah Mitchell')
    // Ghost icon trigger — icon-only, so the gate reads off aria-label.
    expect(host.querySelector('button[aria-label="Send to Jobber"]')).toBeTruthy()
    // A send already made this session (optimistic REQ- ref) is the one thing that hides it.
    await unmount()
    const sent = person({ jobberRef: 'REQ-1', created: daysAgo(2) })
    const m2 = await mount(<InboxScreen people={[sent]} engagements={[]} locFilter="all" />)
    expect(m2.host.querySelector('button[aria-label="Send to Jobber"]')).toBeFalsy()
    await m2.unmount()
  })

  it('Inbox still offers Send on unlinked people (unchanged path)', async () => {
    const fresh = person({ created: daysAgo(2) })
    const { host, unmount } = await mount(
      <InboxScreen people={[fresh]} engagements={[]} locFilter="all" />
    )
    expect(host.querySelector('button[aria-label="Send to Jobber"]')).toBeTruthy()
    await unmount()
  })
})

// ═══ the panel's founded-not-sent action ═══════════════════
describe('EngagementPanel — Send to Jobber on founded-not-sent only', () => {
  const panelClient = { id: 'p1', name: 'Sarah Mitchell', email: 'sarah@email.com', phone: null, prior_engagements: 0, other_open: 0, lifetime_paid: 0, buzz: [] }
  const emptyChildren = { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] }
  const manualEng = { id: 'eng-founded-1', client_id: 'p1', stage: 'Request', founded_by: 'manual', title: 'Engagement – Jul 2026', created_at: daysAgo(0), total_invoiced: 0, total_paid: 0, balance_owing: 0 }

  it('offers Send when the engagement has zero work records — and passes { engagementId }', async () => {
    panelData = { engagement: manualEng, children: emptyChildren, client: panelClient }
    const onSend = vi.fn()
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-founded-1" onClose={() => {}} onSendToJobber={onSend} />
    )
    const send = buttonContaining(host, 'Send to Jobber')
    expect(send, 'founded-not-sent must offer Send').toBeTruthy()
    await click(send!)
    expect(onSend).toHaveBeenCalledWith('p1', { engagementId: 'eng-founded-1' })
    await unmount()
  })

  it('hides Send once ANY work record exists (Jobber already owns the cycle)', async () => {
    panelData = {
      engagement: { ...manualEng, founded_by: 'request' },
      children: { ...emptyChildren, service_requests: [{ id: 'sr1', jobber_request_id: '777', requested_at: daysAgo(1), created_at: daysAgo(1) }] },
      client: panelClient,
    }
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-founded-1" onClose={() => {}} onSendToJobber={vi.fn()} />
    )
    expect(buttonContaining(host, 'Send to Jobber')).toBeFalsy()
    await unmount()
  })

  it('hides Send when the wire is absent (classic mounts unchanged)', async () => {
    panelData = { engagement: manualEng, children: emptyChildren, client: panelClient }
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-founded-1" onClose={() => {}} />
    )
    expect(buttonContaining(host, 'Send to Jobber')).toBeFalsy()
    await unmount()
  })
})

// ═══ surfacing ═════════════════════════════════════════════
describe('Founded engagement surfacing — Active person, board row, no new status', () => {
  it('founding does not remove an open enquiry (Inbox rule): still New with the engagement open; Active only once exit 1 lands', () => {
    const p = person()
    expect(deriveClientStatus(p, new Set([p.id]))).toBe('New')
    // Sent to Jobber this session → exit 1 → the open engagement now reads Active.
    const sent = { ...p, jobberRef: 'REQ-1' }
    expect(deriveClientStatus(sent, new Set([p.id]))).toBe('Active')
    expect(deriveClientStatus(sent, new Set())).not.toBe('Active')
  })

  it('HiveShell: the New sheet hands a returning client to the send — no card is made before Jobber has the request', async () => {
    const onSend = vi.fn()
    const { host, unmount } = await mount(
      <HiveShell people={[person()]} engagements={[]} locFilter="all" currentLocationUuid="loc-uuid-1" onSendToJobber={onSend} />
    )
    expect(host.textContent).not.toContain('Sarah Mitchell')
    await click(host.querySelector('button[aria-label="New client"]')!)
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new job in Jobber')!)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].id).toBe('p1')
    // Nothing founded locally, so the board stays empty until the webhook's
    // engagement lands (the after-send poll surfaces it).
    expect(foundPosts).toHaveLength(0)
    expect(leadPosts).toHaveLength(0)
    await unmount()
  })
})
