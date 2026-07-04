// @vitest-environment happy-dom
// Decoupled engagement founding (founded_by='manual') — the returning-
// client fix. Covers:
//   - frame B "Start new engagement" founds under the EXISTING lead id
//     (POST /api/engagements) — NO second leads row, ever
//   - the founded engagement is a DISTINCT concurrent row (rule 1),
//     never a reuse of the open one
//   - frame F next step: Send to Jobber carries { engagementId }; works
//     for Jobber-linked returning clients (the canSend unlock is scoped
//     to the founded engagement, not people-world)
//   - people-world gates unchanged: Inbox still hides Send on
//     Jobber-linked people (no blanket canSend removal)
//   - EngagementPanel offers Send ONLY on founded-not-sent engagements
//     (zero work records, not terminal)
//   - HiveShell merges the founded row → Board shows it in Request; the
//     person derives Active (no new status invented)
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

// ═══ the founding write ════════════════════════════════════
describe('NewClientSheet — decoupled founding (frames B/D → F)', () => {
  it('frame B founds under the EXISTING lead id — no leads row, real engagement, onFounded gets the returned row', async () => {
    const onFounded = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} engagements={[]} locFilter="loc-uuid-1" onClose={() => {}} onFounded={onFounded} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new engagement')!)

    expect(leadPosts, 'must NOT POST /api/leads for a returning client').toHaveLength(0)
    expect(foundPosts).toHaveLength(1)
    expect(foundPosts[0]).toMatchObject({ client_id: 'p1' })
    expect(onFounded).toHaveBeenCalledTimes(1)
    const [engRow] = onFounded.mock.calls[0]
    expect(engRow.id).toBe('eng-founded-1') // the REAL returned row
    expect(engRow.client_id).toBe('p1')
    expect(engRow.founded_by).toBe('manual')
    expect(engRow.stage).toBe('Request')
    // Frame F: founded, send-or-keep-local next step
    expect(host.textContent).toContain('Engagement started')
    expect(host.textContent).toContain('on the board in Request')
    expect(buttonByText(host, 'Keep local for now')).toBeTruthy()
    await unmount()
  })

  it('frame D confirm founds a DISTINCT second engagement, concurrent with the open one (rule 1)', async () => {
    const existing = openEng('p1')
    const onFounded = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} engagements={[existing]} locFilter="loc-uuid-1" onClose={() => {}} onFounded={onFounded} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new engagement')!)
    expect(host.textContent).toContain('This client has an open engagement')
    await click(buttonByText(host, 'Start another engagement')!)

    expect(foundPosts).toHaveLength(1)
    expect(leadPosts).toHaveLength(0)
    const [engRow] = onFounded.mock.calls[0]
    expect(engRow.id).not.toBe(existing.id) // a new row — never a reuse/overwrite
    expect(engRow.client_id).toBe(existing.client_id) // same client, both stay active
    await unmount()
  })

  it('frame F Send to Jobber works for a Jobber-LINKED returning client and carries { engagementId }', async () => {
    const p = person({ jobberRef: '12345' }) // linked — old people-world gate hid Send entirely
    const onSend = vi.fn()
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[p]} engagements={[]} locFilter="loc-uuid-1" onClose={onClose} onSendToJobber={onSend} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new engagement')!)

    const send = buttonContaining(host, 'Send to Jobber')
    expect(send, 'Send must be offered on the founded engagement').toBeTruthy()
    await click(send!)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].id).toBe('p1') // the EXISTING person — no duplicate
    expect(onSend.mock.calls[0][1]).toEqual({ engagementId: 'eng-founded-1' })
    expect(onClose).toHaveBeenCalled()
    expect(leadPosts, 'the send path never writes a second leads row').toHaveLength(0)
    await unmount()
  })

  it('frame F Keep local for now closes without sending — the engagement stays, send available later', async () => {
    const onSend = vi.fn()
    const onClose = vi.fn()
    const { host, unmount } = await mount(
      <NewClientSheet people={[person()]} engagements={[]} locFilter="loc-uuid-1" onClose={onClose} onSendToJobber={onSend} />
    )
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new engagement')!)
    await click(buttonByText(host, 'Keep local for now')!)
    expect(onClose).toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(foundPosts).toHaveLength(1) // the engagement was still founded
    await unmount()
  })
})

// ═══ people-world gates stay ═══════════════════════════════
describe('canSend — surgical unlock, not a blanket removal', () => {
  it('Inbox still hides people-world Send on Jobber-linked people', async () => {
    const linked = person({ jobberRef: '12345', created: daysAgo(2) }) // status New → Inbox row
    const { host, unmount } = await mount(
      <InboxScreen people={[linked]} engagements={[]} locFilter="all" />
    )
    expect(host.textContent).toContain('Sarah Mitchell')
    expect(buttonContaining(host, 'Send to Jobber')).toBeFalsy()
    await unmount()
  })

  it('Inbox still offers Send on unlinked people (unchanged path)', async () => {
    const fresh = person({ created: daysAgo(2) })
    const { host, unmount } = await mount(
      <InboxScreen people={[fresh]} engagements={[]} locFilter="all" />
    )
    expect(buttonContaining(host, 'Send to Jobber')).toBeTruthy()
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
  it('an open engagement makes the person derive Active — the intended founded-not-sent signal', () => {
    const p = person()
    expect(deriveClientStatus(p, new Set([p.id]))).toBe('Active')
    expect(deriveClientStatus(p, new Set())).not.toBe('Active')
  })

  it('HiveShell: founding via the sheet puts the engagement on the Board in Request without a reload', async () => {
    const { host, unmount } = await mount(
      <HiveShell people={[person()]} engagements={[]} locFilter="all" currentLocationUuid="loc-uuid-1" />
    )
    // Board lens (default) starts empty
    expect(host.textContent).not.toContain('Sarah Mitchell')
    await click(host.querySelector('button[aria-label="New client"]')!)
    await type(host.querySelector('input[aria-label="Search clients"]')!, 'sarah@email.com')
    await click(buttonContaining(host, 'Start new engagement')!)
    expect(host.textContent).toContain('Engagement started')
    await click(buttonByText(host, 'Keep local for now')!)
    // The sheet closed; the founded row rides sessionEngagements → Board.
    expect(host.textContent).toContain('Sarah Mitchell')
    expect(foundPosts).toHaveLength(1)
    expect(leadPosts).toHaveLength(0)
    await unmount()
  })
})
