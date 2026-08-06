// @vitest-environment happy-dom
//
// issue 204 — "Close — not interested" (lead-close mode of CloseLostWizard).
//
// A lead who cancelled / went quiet (Sarah Watts) has NO engagement, so
// closing only the lead does nothing to the Inbox (which reads engagements,
// blind to leads.stage). The wizard therefore, in stopLeadDrips mode:
//   1) find-or-creates an engagement (POST /api/engagements { reuse_open })
//      when it has no engagementId — so the Closed Lost lands in System B;
//   2) commits the close through the SHARED commitEngagementClose path
//      (PATCH /api/engagements/:id, stage Closed Lost, reason on closed_reason);
//   3) fires the lead-side drip/stage-email stop the engagement close omits
//      (POST /api/leads/:id/close-not-interested).
// And when the lead ALREADY has an engagement (engagementId passed), it closes
// THAT one — no POST /api/engagements, no duplicate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import CloseLostWizard from '@/components/hive/shared/CloseLostWizard'
import { CLOSED_LOST } from '@/components/hive/shared/stageConfig'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let engagementPosts: any[] = []
let patchCalls: { url: string; body: any }[] = []
let dripStopPosts: string[] = []
let touchpointPosts: any[] = []

const fetchMock = vi.fn(async (url: any, init?: any) => {
  const u = String(url)
  const method = init?.method
  if (method === 'POST' && /\/api\/engagements$/.test(u)) {
    engagementPosts.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ engagement: { id: 'eng-NEW' }, reused: false }) } as any
  }
  if (method === 'PATCH' && /\/api\/engagements\//.test(u)) {
    const body = JSON.parse(init.body)
    patchCalls.push({ url: u, body })
    return { ok: true, json: async () => ({ id: u.split('/').pop(), stage: body.stage }) } as any
  }
  if (method === 'POST' && /\/api\/leads\/[^/]+\/close-not-interested$/.test(u)) {
    dripStopPosts.push(u)
    return { ok: true, json: async () => ({ ok: true }) } as any
  }
  if (method === 'POST' && /\/api\/touchpoints$/.test(u)) {
    touchpointPosts.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ touchpoint: { id: 't1' } }) } as any
  }
  return { ok: true, json: async () => ({}) } as any
})

beforeEach(() => {
  engagementPosts = []; patchCalls = []; dripStopPosts = []; touchpointPosts = []
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  document.body.innerHTML = ''
})
afterEach(() => { vi.unstubAllGlobals() })

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return container
}
const settle = () => act(async () => {})
async function fire(node: Element) {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[]
const btnByText = (t: string) => buttons().find(b => (b.textContent || '').includes(t))

describe('CloseLostWizard — lead-close mode (issue 204)', () => {
  it('no engagement: founds via reuse_open, closes Closed Lost, stops drips', async () => {
    const onClosed = vi.fn()
    mount(
      <CloseLostWizard
        engagementId={null}
        leadId="c1"
        reasons={['Went quiet', 'Not a fit', 'Other']}
        stopLeadDrips
        onClosed={onClosed}
      />,
    )
    await settle()
    // reason step: pick a reason, Next, then Close as lost (skip follow-up)
    await fire(btnByText('Went quiet')!)
    await fire(btnByText('Next')!)
    await fire(btnByText('Close as lost')!)
    await settle()

    // 1) found-or-reuse the engagement
    expect(engagementPosts).toHaveLength(1)
    expect(engagementPosts[0]).toEqual({ client_id: 'c1', reuse_open: true })
    // 2) close routed through the SHARED path onto the founded engagement
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].url).toContain('/api/engagements/eng-NEW')
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    expect(patchCalls[0].body.closed_reason).toBe('Went quiet')
    // 3) lead-side drip/stage-email stop fired
    expect(dripStopPosts).toHaveLength(1)
    expect(dripStopPosts[0]).toContain('/api/leads/c1/close-not-interested')
    expect(onClosed).toHaveBeenCalledWith(CLOSED_LOST, expect.anything())
  })

  it('lead that already HAS an engagement: closes THAT one, no second founded', async () => {
    mount(
      <CloseLostWizard
        engagementId="e-existing"
        leadId="c1"
        reasons={['Went quiet', 'Other']}
        stopLeadDrips
      />,
    )
    await settle()
    await fire(btnByText('Next')!)
    await fire(btnByText('Close as lost')!)
    await settle()

    // never founds a second engagement
    expect(engagementPosts).toHaveLength(0)
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].url).toContain('/api/engagements/e-existing')
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    // still stops the lead's drips
    expect(dripStopPosts).toHaveLength(1)
  })

  it('the engagement-panel usage (no stopLeadDrips) never calls the drip-stop route', async () => {
    mount(
      <CloseLostWizard engagementId="e-1" leadId="c1" reasons={['Went quiet', 'Other']} />,
    )
    await settle()
    await fire(btnByText('Next')!)
    await fire(btnByText('Close as lost')!)
    await settle()

    expect(engagementPosts).toHaveLength(0)
    expect(patchCalls[0].url).toContain('/api/engagements/e-1')
    expect(dripStopPosts).toHaveLength(0)
  })
})
