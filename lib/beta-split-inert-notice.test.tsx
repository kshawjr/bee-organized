// @vitest-environment happy-dom
//
// Split-notifications INERT-STATE notice — MOUNT test of NewLeadNotifications.
//
// Since 9c3615f the split toggle drives lead ASSIGNMENT as well as
// notifications, and a split-ON location where no recipient claims any project
// type behaves identically to split-OFF (every lead notifies everyone, the
// owner is assigned). This suite pins the inline notice that makes that state
// visible, and the copy stating the ownership half:
//   • notice renders when split is ON and zero types are claimed;
//   • absent when a type IS claimed (loc_test's real shape);
//   • absent when split is OFF;
//   • renders in readOnly (informational), minus the tap instruction;
//   • toggle subcopy + "Everything else" copy state owner assignment.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { NewLeadNotifications } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '132b42c2-0000-4000-8000-000000000001'
const NOTICE = 'Split is on, but no one is assigned to a project type yet'
const TAP = 'Tap project types on a person below to assign them.'

const PROJECT_TYPES = ['Home or Office Organizing', 'Moving/Relocation']

// Recipient-config payloads mirroring /api/locations/:id/notification-recipients
const owner = (over: any = {}) => ({
  type: 'user', hub_user_id: 'u-owner', name: 'Angie', email: 'angie@x.com',
  role: 'owner', category: 'all', subscribed: true, ...over,
})
const manager = (over: any = {}) => ({
  type: 'user', hub_user_id: 'u-mgr', name: 'K Shaw', email: 'kshawjr@x.com',
  role: 'manager', category: 'all', subscribed: true, ...over,
})
const config = (over: any = {}) => ({
  users: [owner()],
  externals: [],
  project_types: PROJECT_TYPES,
  split_enabled: true,
  ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let payload: any

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mount = async (props: any = {}) => {
  await act(async () => {
    root.render(<NewLeadNotifications realLocId={LOC_UUID} {...props} />)
  })
  await act(async () => {}) // flush the mount-time config fetch
}

describe('split-ON with zero claims — the inert-state notice', () => {
  it('renders the notice, states the owner assignment, and instructs the owner', async () => {
    // Scottsdale's real shape: split ON, every recipient category='all'.
    payload = config({
      externals: [
        { type: 'external', id: 'e1', name: 'Hive', email: 'hive@x.com', phone: null, category: 'all' },
      ],
    })
    await mount()
    expect(container.textContent).toContain(NOTICE)
    expect(container.textContent).toContain('every lead still notifies everyone and is assigned to the location owner')
    expect(container.textContent).toContain(TAP)
  })

  it('is absent when a type IS claimed (loc_test shape)', async () => {
    payload = config({
      users: [owner(), manager({ category: '["Home or Office Organizing"]' })],
    })
    await mount()
    expect(container.textContent).not.toContain(NOTICE)
  })

  it('an UNSUBSCRIBED claimant does not count as a claim', async () => {
    // The send filter and the assignment resolver both ignore unsubscribed
    // users, so their claims must not silence the notice.
    payload = config({
      users: [owner(), manager({ category: '["Home or Office Organizing"]', subscribed: false })],
    })
    await mount()
    expect(container.textContent).toContain(NOTICE)
  })

  it('is absent when split is OFF', async () => {
    payload = config({ split_enabled: false })
    await mount()
    expect(container.textContent).not.toContain(NOTICE)
  })

  it('renders in readOnly (informational), without the tap instruction', async () => {
    payload = config()
    await mount({ readOnly: true })
    expect(container.textContent).toContain(NOTICE)
    expect(container.textContent).not.toContain(TAP)
  })
})

describe('assignment-aware copy (the ownership half)', () => {
  it('toggle ON subcopy states unassigned types are assigned to the location owner', async () => {
    payload = config()
    await mount()
    expect(container.textContent).toContain(
      'unassigned types notify the whole team and are assigned to the location owner',
    )
  })

  it('"Everything else → whole team" states the owner assignment for leftover types', async () => {
    // A claim exists so the notice is gone, but Moving/Relocation is leftover —
    // the section must still state where those leads land.
    payload = config({
      users: [owner(), manager({ category: '["Home or Office Organizing"]' })],
    })
    await mount()
    expect(container.textContent).toContain('Everything else → whole team')
    expect(container.textContent).toContain(
      'Leads of these types notify the whole team and are assigned to the location owner',
    )
  })

  it('OFF-state subcopy is unchanged (notification-only is accurate when off)', async () => {
    payload = config({ split_enabled: false })
    await mount()
    expect(container.textContent).toContain('Off — everyone below is notified for every new lead.')
  })
})
