// @vitest-environment happy-dom
//
// The Inbox "No coverage" action — the second disposition beside Route in the
// Needs-transfer section. Mount tests, not source pins. Pins:
//   • The pill renders for a corp view (a populated transfer queue) and is
//     ABSENT for a franchise view (empty queue — the whole section is gated
//     upstream by visibleTransferQueue, which returns [] for non-elevated).
//   • Clicking it opens NoCoverageModal (role=dialog) bound to the right lead,
//     previewing the real copy the send uses.
//   • Confirm POSTs /api/leads/:id/no-coverage; on dismissed:true the row
//     optimistically leaves the queue.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const locOtherLead = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Global Lead', email: 'lead@email.com',
  phone: '(561) 555-0199', phoneNormalized: '5615550199',
  locationId: 'loc-other-uuid', atLocOther: true,
  originCity: 'Austin', originState: 'TX', originZip: '78701', project: 'Garage',
  created: daysAgo(3), isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [],
  ...over,
})

const installFetch = (noCoverageResp: any = { ok: true, status: 200, body: { success: true, dismissed: true } }) => {
  const mock = vi.fn(async (url: any) => {
    const u = String(url)
    if (u.includes('/api/locations/transfer-targets')) {
      return { ok: true, status: 200, json: async () => ({ targets: [] }) }
    }
    if (u.includes('/no-coverage')) {
      return { ok: noCoverageResp.ok, status: noCoverageResp.status, json: async () => noCoverageResp.body }
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

describe('No coverage — corp vs franchise', () => {
  it('renders the pill for a corp view (populated transfer queue)', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead()]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'No coverage')
    expect(pill).toBeTruthy()
    await unmount()
  })

  it('is ABSENT for a franchise view (empty transfer queue = no section at all)', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[locOtherLead({ atLocOther: false, locationId: 'loc-1' })]} transferPeople={[]} engagements={[]} locFilter="loc-1" />,
    )
    const pill = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'No coverage')
    expect(pill).toBeUndefined()
    await unmount()
  })
})

describe('No coverage — modal + write', () => {
  it('opens the modal for the clicked lead and previews the real copy', async () => {
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead({ name: 'Dana Reyes' })]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'No coverage')
    await act(async () => { pill!.click() })
    await flush()
    const dlg = document.querySelector('[role="dialog"][aria-label="No coverage"]')
    expect(dlg).toBeTruthy()
    // The preview shows the real subject + the link's stated purpose.
    expect(dlg!.textContent).toContain("We're not in your area yet")
    expect(dlg!.textContent).toContain('Join the list to hear when we reach your area')
    // The confirm says the dismissal happens on send, not on click.
    const confirm = Array.from(dlg!.querySelectorAll('button')).find(b => /Send and dismiss/.test(b.textContent || ''))
    expect(confirm).toBeTruthy()
    await unmount()
  })

  it('confirm POSTs the no-coverage endpoint and removes the row on dismissed:true', async () => {
    const fetchMock = installFetch()
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead({ id: 'lead-77', name: 'Only Row' })]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'No coverage')
    await act(async () => { pill!.click() })
    await flush()
    const confirm = Array.from(document.querySelectorAll('button')).find(b => /Send and dismiss/.test(b.textContent || ''))
    await act(async () => { (confirm as HTMLButtonElement).click() })
    await flush()

    const callArgs = fetchMock.mock.calls.find(c => String(c[0]).includes('/no-coverage'))
    expect(callArgs).toBeTruthy()
    expect(String(callArgs![0])).toBe('/api/leads/lead-77/no-coverage')
    expect((callArgs![1] as any).method).toBe('POST')

    // Optimistic removal: the only transfer row is gone.
    const rows = Array.from(host.querySelectorAll('.bee-inbox-row')).filter(r => (r.textContent || '').includes('Only Row'))
    expect(rows).toHaveLength(0)
    await unmount()
  })

  it('does NOT remove the row when the email sent but the dismiss did not (dismissed:false)', async () => {
    installFetch({ ok: true, status: 200, body: { success: true, sent: true, dismissed: false, warnings: ['dismiss_write_failed_after_send: x'] } })
    const { host, unmount } = await mount(
      <InboxScreen people={[]} transferPeople={[locOtherLead({ id: 'lead-88', name: 'Sticky Row' })]} engagements={[]} locFilter="all" />,
    )
    const pill = Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'No coverage')
    await act(async () => { pill!.click() })
    await flush()
    const confirm = Array.from(document.querySelectorAll('button')).find(b => /Send and dismiss/.test(b.textContent || ''))
    await act(async () => { (confirm as HTMLButtonElement).click() })
    await flush()
    // The email went out but the row is STILL there — the surface matches the DB.
    const rows = Array.from(host.querySelectorAll('.bee-inbox-row')).filter(r => (r.textContent || '').includes('Sticky Row'))
    expect(rows).toHaveLength(1)
    await unmount()
  })
})
