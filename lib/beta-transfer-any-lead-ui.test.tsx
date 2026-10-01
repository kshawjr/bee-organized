// @vitest-environment happy-dom
//
// CORPORATE CAN TRANSFER ANY LEAD — the screen half (1 Oct 2026).
//
// WHERE: the lead card's ··· menu, last, under a "Corporate" heading:
// "Transfer to another location". The unrouted lead keeps its Transfer button
// in the action bar, unchanged.
//
// It opens the SAME TransferLeadModal the unrouted queue uses. What a lead
// that already has a home changes in it:
//   · its current location is left out of the list
//   · a reason is asked for, and Transfer waits on it
//   · the note also says what the lead leaves behind
//   · a lead that cannot move (in Jobber / has an engagement) gets the reason
//     instead of a list
//
// The buttons are a courtesy. beta-transfer-any-lead-endpoint proves the
// refusals at the route with the screen out of the picture.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import TransferLeadModal from '@/components/hive/TransferLeadModal'
import { TRANSFER_MENU } from '@/components/hive/shared/leadDispositions'
import { TRANSFER_BLOCK_COPY } from '@/lib/lead-transfer-rule'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const TARGETS = [
  { id: 'central-uuid', name: 'Central Austin', slug: 'loc_centralaustin', lifecycle_status: 'active', owner_name: 'Cara Lin' },
  { id: 'sw-uuid', name: 'Southwest Austin', slug: 'loc_swaustin', lifecycle_status: 'active', owner_name: 'Dana Lee' },
  { id: 'waco-uuid', name: 'Waco', slug: 'loc_waco', lifecycle_status: 'onboarding', owner_name: 'Sam Rio' },
]

const profile = (clientOver: any = {}, over: any = {}) => ({
  client: {
    id: 'lead-1', name: 'Kim Terry', first_name: 'Kim', last_name: 'Terry',
    email: 'kim@email.com', phone: '(512) 555-0100', zip: '78746', city: 'Austin', state: 'TX',
    stage: 'New', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), tags: [],
    jobber_client_id: null, is_junk: false, snoozed_until: null, inbox_dismissed_at: null,
    assigned_to: null, location_id: 'loc_centralaustin', location_uuid: 'central-uuid',
    location_name: 'Central Austin', project_type: 'Moving',
    ...clientOver,
  },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
  ...over,
})

let payload: any
let posts: any[] = []
let targetReads = 0
let transferResponse: any
let transferStatus = 200
beforeEach(() => {
  payload = profile(); posts = []; targetReads = 0
  transferResponse = { success: true, to: { name: 'Southwest Austin' } }; transferStatus = 200
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url); const method = init?.method || 'GET'
    if (u.includes('/api/locations/transfer-targets')) {
      targetReads++
      return { ok: true, status: 200, json: async () => ({ targets: TARGETS }) } as any
    }
    if (/\/api\/leads\/[^/]+\/transfer$/.test(u) && method === 'POST') {
      posts.push({ u, body: JSON.parse(init.body) })
      return { ok: transferStatus === 200, status: transferStatus, json: async () => transferResponse } as any
    }
    if (/\/profile/.test(u)) return { ok: true, status: 200, json: async () => payload } as any
    return { ok: true, status: 200, json: async () => ({}) } as any
  })
  document.body.innerHTML = ''
})

let root: any
const flush = async () => {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await flush()
  return host
}
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; document.body.innerHTML = ''; vi.restoreAllMocks()
})
const click = (el: Element | null | undefined) => act(async () => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`)
const options = () => Array.from(document.querySelectorAll('[role="option"]')) as HTMLElement[]
const button = (text: string) => Array.from(document.querySelectorAll('button'))
  .find((b) => (b.textContent || '').includes(text)) as HTMLButtonElement | undefined
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null
const type = async (el: HTMLTextAreaElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

const openCardMenu = async (props: any = {}) => {
  const onClose = vi.fn(); const setToast = vi.fn()
  const host = await mount(
    <ClientProfile clientId="lead-1" currentUserRole="admin" onClose={onClose} setToast={setToast} {...props} />)
  await click([...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More'))
  return { host, onClose, setToast }
}

// ── the menu item ────────────────────────────────────────────────
describe('the lead card ··· menu — "Transfer to another location"', () => {
  it.each(['admin', 'super_admin'])('corporate (%s) sees it on a lead that already has a location', async (role) => {
    await openCardMenu({ currentUserRole: role })
    const item = byTestId('menu-transfer')!
    expect(item).toBeTruthy()
    expect(item.querySelector('[data-menu-label]')!.textContent).toBe('Transfer to another location')
    expect(item.querySelector('[data-menu-description]')!.textContent).toBe(TRANSFER_MENU.description)
    const headings = [...document.querySelectorAll('[data-menu-heading]')].map((h) => h.textContent)
    expect(headings[headings.length - 1]).toBe('Corporate')
  })

  it.each(['owner', 'manager', 'lite_user', null])('%s does not', async (role) => {
    await openCardMenu({ currentUserRole: role })
    expect(byTestId('menu-dismiss')).toBeTruthy()   // the menu is open
    expect(byTestId('menu-transfer')).toBeNull()
    expect(document.body.textContent).not.toContain('Transfer to another location')
  })

  it('a read-only seat does not, even for corporate', async () => {
    await openCardMenu({ readOnly: true })
    expect(byTestId('menu-transfer')).toBeNull()
  })

  it('an UNROUTED lead keeps its action-bar Transfer and gets no second door', async () => {
    payload = profile({ location_id: 'loc_other', location_uuid: 'other-uuid', location_name: 'Unassigned' })
    const { host } = await openCardMenu()
    expect(byTestId('menu-transfer')).toBeNull()
    expect(host.querySelector('[data-testid="card-action-bar"]')!.textContent).toContain('Transfer')
  })

  it('picking it opens the transfer dialog for a lead WITH a home', async () => {
    await openCardMenu()
    await click(byTestId('menu-transfer'))
    await flush()
    expect(dialog()!.getAttribute('aria-label')).toBe('Transfer lead')
    expect(dialog()!.textContent).toContain('Kim Terry')
    expect(dialog()!.textContent).toContain('at Central Austin')
    // Its own location is not offered.
    expect(options().map((o) => o.textContent)).toHaveLength(2)
    expect(options().some((o) => (o.textContent || '').includes('Central Austin'))).toBe(false)
    expect(document.getElementById('transfer-reason')).toBeTruthy()
  })

  it('the whole trip: reason, POST, toast, and the card closes', async () => {
    const { onClose, setToast } = await openCardMenu()
    await click(byTestId('menu-transfer'))
    await flush()
    await click(options().find((o) => (o.textContent || '').includes('Southwest Austin')))
    await type(document.getElementById('transfer-reason') as HTMLTextAreaElement, 'Zip 78746 is Southwest Austin')
    await click(button('Transfer to Southwest Austin'))
    await flush()
    expect(posts).toEqual([{
      u: '/api/leads/lead-1/transfer',
      body: { destination_location_id: 'sw-uuid', reason: 'Zip 78746 is Southwest Austin' },
    }])
    expect(setToast).toHaveBeenCalledWith({ kind: 'success', msg: 'Kim Terry transferred to Southwest Austin' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ── leads that cannot move ───────────────────────────────────────
describe('a lead that cannot be moved says so', () => {
  it('already in Jobber: the row says why, and the dialog explains instead of listing', async () => {
    payload = profile({ jobber_client_id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x' })
    await openCardMenu()
    const item = byTestId('menu-transfer')!
    expect(item).toBeTruthy()   // still drawn — an absent Transfer explains nothing
    expect(item.querySelector('[data-menu-description]')!.textContent).toBe(TRANSFER_BLOCK_COPY.in_jobber.short)
    await click(item)
    await flush()
    expect(byTestId('transfer-blocked')!.textContent).toBe(TRANSFER_BLOCK_COPY.in_jobber.long)
    expect(options()).toHaveLength(0)
    expect(button('Transfer to')).toBeUndefined()
    expect(targetReads).toBe(0)
    expect(posts).toEqual([])
  })

  it('has an engagement (even a closed one): same treatment, its own sentence', async () => {
    payload = profile({}, { engagements: [{
      id: 'eng-1', stage: 'Closed Lost', closed_reason: 'No response', founded_by: 'manual',
      created_at: new Date().toISOString(), closed_at: new Date().toISOString(),
      service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [],
    }] })
    await openCardMenu()
    expect(byTestId('menu-transfer')!.querySelector('[data-menu-description]')!.textContent)
      .toBe(TRANSFER_BLOCK_COPY.has_engagement.short)
    await click(byTestId('menu-transfer'))
    await flush()
    expect(byTestId('transfer-blocked')!.textContent).toBe(TRANSFER_BLOCK_COPY.has_engagement.long)
    expect(posts).toEqual([])
  })
})

// ── the modal, on its own ────────────────────────────────────────
describe('TransferLeadModal for a lead that already has a home', () => {
  const FROM = { id: 'central-uuid', name: 'Central Austin' }
  const open = (props: any = {}) => mount(
    <TransferLeadModal person={{ id: 'lead-1', name: 'Kim Terry' }} from={FROM} {...props} />)

  it('Transfer waits for BOTH a destination and a reason', async () => {
    await open()
    expect(button('Transfer')!.disabled).toBe(true)
    await click(options().find((o) => (o.textContent || '').includes('Southwest Austin')))
    expect(button('Transfer to Southwest Austin')!.disabled).toBe(true)
    await type(document.getElementById('transfer-reason') as HTMLTextAreaElement, '   ')
    expect(button('Transfer to Southwest Austin')!.disabled).toBe(true)
    await click(button('Transfer to Southwest Austin'))
    expect(posts).toEqual([])
    await type(document.getElementById('transfer-reason') as HTMLTextAreaElement, 'wrong territory')
    expect(button('Transfer to Southwest Austin')!.disabled).toBe(false)
  })

  it('says what the lead leaves behind, for a live and a not-live destination', async () => {
    await open()
    await click(options().find((o) => (o.textContent || '').includes('Southwest Austin')))
    expect(dialog()!.textContent).toContain("Notifies Dana Lee and starts Southwest Austin's drip.")
    expect(dialog()!.textContent).toContain("Kim Terry leaves Central Austin: the person assigned there is cleared and Central Austin's emails stop.")
    await click(options().find((o) => (o.textContent || '').includes('Waco')))
    expect(dialog()!.textContent).toContain("Waco isn't live yet")
    expect(dialog()!.textContent).toContain('Kim Terry leaves Central Austin')
  })

  it("a refusal from the route is shown in words, not as a code", async () => {
    transferStatus = 409
    transferResponse = { error: 'lead_in_jobber', detail: 'x' }
    const onDone = vi.fn()
    await open({ onDone })
    await click(options().find((o) => (o.textContent || '').includes('Southwest Austin')))
    await type(document.getElementById('transfer-reason') as HTMLTextAreaElement, 'wrong territory')
    await click(button('Transfer to Southwest Austin'))
    await flush()
    expect(onDone).not.toHaveBeenCalled()
    expect(dialog()!.textContent).toContain("Couldn't transfer")
    expect(dialog()!.textContent).toContain(TRANSFER_BLOCK_COPY.in_jobber.long)
    expect(dialog()!.textContent).not.toContain('lead_in_jobber')
  })

  it('WITHOUT a home (the unrouted queue) nothing changed: no reason box, no reason sent', async () => {
    await mount(<TransferLeadModal person={{ id: 'lead-1', name: 'Kim Terry' }} />)
    expect(options()).toHaveLength(3)
    expect(document.getElementById('transfer-reason')).toBeNull()
    await click(options().find((o) => (o.textContent || '').includes('Southwest Austin')))
    expect(dialog()!.textContent).not.toContain('leaves')
    await click(button('Transfer to Southwest Austin'))
    await flush()
    expect(posts).toEqual([{ u: '/api/leads/lead-1/transfer', body: { destination_location_id: 'sw-uuid' } }])
  })
})
