// @vitest-environment happy-dom
//
// Inbox "Needs transfer" section — corp/admin routes loc_other global-form
// leads to a real location, from a section that sits ABOVE New/Attempting.
// Pins:
//   · the section renders ONLY when loc_other leads are in scope, and it
//     renders ABOVE New/Attempting (self-gating: franchise scopes never
//     receive loc_other rows, so the section is simply absent for them)
//   · a loc_other lead shows its ORIGIN (city, ST zip · project · from global
//     form) and is EXCLUDED from New (it appears once, in Needs transfer)
//   · the Transfer opens the same modal from the row button AND the ··· menu
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  phoneNormalized: '5615550199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3),
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  atLocOther: false,
  originCity: null, originState: null, originZip: null, project: '',
  ...over,
})

const locOtherLead = (over: any = {}) => person({
  name: 'Global Lead', locationId: 'loc-other-uuid', atLocOther: true,
  originCity: 'Austin', originState: 'TX', originZip: '78701', project: 'Garage',
  ...over,
})

const installFetch = () => {
  const mock = vi.fn(async (url: any) => {
    if (String(url).includes('/api/locations/transfer-targets')) {
      return { ok: true, status: 200, json: async () => ({ targets: [
        { id: 'dest-active', name: 'Boulder', slug: 'boulder-01', lifecycle_status: 'active', owner_name: 'Dana Lee' },
      ] }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  ;(globalThis as any).fetch = mock as any
  return mock
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const flush = async () => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => { installFetch() })

const sectionLabels = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('p'))
    .map(p => (p.textContent || ''))
    .filter(t => /Needs transfer|^New ·|New ·|Attempting ·/.test(t))

describe('Inbox — Needs transfer section', () => {
  it('renders the section ABOVE New when a loc_other lead is in scope', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[locOtherLead(), person()]} engagements={[]} locFilter="all" />,
    )
    const text = host.textContent || ''
    expect(text).toContain('Needs transfer')
    // ordering: the Needs-transfer banner precedes the New banner in the DOM
    const labels = sectionLabels(host)
    const transferIdx = labels.findIndex(t => t.includes('Needs transfer'))
    const newIdx = labels.findIndex(t => t.startsWith('New'))
    expect(transferIdx).toBeGreaterThanOrEqual(0)
    expect(newIdx).toBeGreaterThan(transferIdx)
    await unmount()
  })

  it('shows the loc_other lead origin, and excludes it from New (New counts only the normal lead)', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[locOtherLead(), person({ name: 'Normal New' })]} engagements={[]} locFilter="all" />,
    )
    expect(host.textContent).toContain('Austin, TX 78701')
    expect(host.textContent).toContain('from global form')
    // New section shows count of 1 (only the normal lead) — the loc_other
    // lead lives solely under Needs transfer.
    const newLabel = Array.from(host.querySelectorAll('p')).map(p => p.textContent || '').find(t => t.startsWith('New ·'))
    expect(newLabel).toContain('New · 1 ·')
    await unmount()
  })

  it('is ABSENT for a franchise-scoped view (no loc_other leads in scope)', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[person(), person({ name: 'Another' })]} engagements={[]} locFilter="loc-uuid-1" />,
    )
    expect(host.textContent).not.toContain('Needs transfer')
    await unmount()
  })

  it('opens the transfer modal from the row Transfer button', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const transferBtn = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Transfer')
    expect(transferBtn).toBeTruthy()
    await act(async () => { transferBtn!.click() })
    await flush()
    const dlg = document.querySelector('[role="dialog"][aria-label="Transfer lead"]')
    expect(dlg).toBeTruthy()
    await unmount()
  })

  it('opens the same modal from the ··· menu Transfer item', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const more = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'More')
    expect(more).toBeTruthy()
    await act(async () => { more!.click() })
    await flush()
    // RowMenu portals to <body>; find the Transfer item there.
    const item = Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('Transfer to a location'))
    expect(item).toBeTruthy()
    await act(async () => { item!.click() })
    await flush()
    expect(document.querySelector('[role="dialog"][aria-label="Transfer lead"]')).toBeTruthy()
    await unmount()
  })
})
