// @vitest-environment happy-dom
//
// AssigneeCorner — the in-record top-right assignee cluster + click-to-assign
// picker (Kevin 7/24). ONE component, both records:
//   · faces only (MiniAvatar), names on hover — no label, no inline names
//   · unassigned → a dashed GHOST disc that reads "click to assign"
//   · click opens a MULTI-select checklist of the location roster
//   · mode='put'    → PUT  { hub_user_ids }   (leads, set-based)
//   · mode='toggle' → POST { hub_user_id } / DELETE ?hub_user_id  (engagements,
//                     per-user idempotent; unmapped-to-Jobber users marked)
//   · onChange lifts the returned list → updates in place, no reload
//   · readOnly → display only, no picker
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AssigneeCorner from '@/components/hive/shared/AssigneeCorner'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const USERS = [
  { id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', locationId: 'loc-1', jobberUserId: 'j1' },
  { id: 'u2', name: 'Wendy Ortiz', email: 'wendy@x.com', locationId: 'loc-1', jobberUserId: null }, // unmapped
]

let calls: any[] = []
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
const trigger = (host: Element) => host.querySelector('button[aria-haspopup="true"]') as HTMLButtonElement
// Picker rows are buttons carrying the full user name; the trigger carries
// only initials/ghost, so matching the full name lands on the row.
const rowFor = (host: Element, text: string) =>
  Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').includes(text)) || null

beforeEach(() => {
  calls = []
  // Default: every write echoes back a single-member list so onChange can be
  // asserted; individual tests override the body when they need a shape.
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null })
    return jsonRes({ assignees: [{ hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }] })
  })
})

const ASSIGNED = [{ hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }]

describe('display — faces only, names on hover, ghost when empty', () => {
  it('renders an avatar per assignee with the name on the hover title (no visible label/name)', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={ASSIGNED} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    // The disc carries the name as its hover title (with no label, hover is
    // the only way to read who) and the initials as text.
    const disc = Array.from(host.querySelectorAll('span')).find(s => s.getAttribute('title') === 'Kevin Shaw')
    expect(disc).toBeTruthy()
    expect(disc!.textContent).toBe('KS')
    // Faces only — the word "Assigned" appears nowhere in the corner.
    expect(host.textContent).not.toContain('Assigned to')
    await unmount()
  })

  it('unassigned shows the dashed ghost affordance — a + disc that reads "click to assign", not a blank corner', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    const t = trigger(host)
    expect(t).toBeTruthy()
    expect(t.getAttribute('aria-label')).toBe('Assign a team member')
    // the ghost disc is a + with a dashed border (the affordance)
    const ghost = Array.from(t.querySelectorAll('span')).find(s => (s.textContent || '') === '+')!
    expect(ghost).toBeTruthy()
    expect(ghost.style.borderStyle === 'dashed' || (ghost.getAttribute('style') || '').includes('dashed')).toBe(true)
    await unmount()
  })
})

describe('lead mode="put" — set-based junction write', () => {
  it('clicking the corner opens the multi-select picker of location users', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    await click(trigger(host))
    expect(host.textContent).toContain('Kevin Shaw')
    expect(host.textContent).toContain('Wendy Ortiz')
    await unmount()
  })

  it('assigning PUTs the whole new hub_user_ids set and lifts onChange (no reload)', async () => {
    const onChange = vi.fn()
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" onChange={onChange} />
    )
    await click(trigger(host))
    await click(rowFor(host, 'Kevin Shaw')!)
    expect(calls).toEqual([{ url: '/api/leads/lead-9/assignees', method: 'PUT', body: { hub_user_ids: ['u1'] } }])
    expect(onChange).toHaveBeenCalledWith([{ hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }])
    await unmount()
  })

  it('adding a SECOND assignee sends the union (multi); removing sends the reduced set', async () => {
    // add: current [u1] + u2 → PUT [u1, u2]
    ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
      calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null })
      return jsonRes({ assignees: ASSIGNED })
    })
    const add = await mount(
      <AssigneeCorner assignees={ASSIGNED} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    await click(trigger(add.host))
    await click(rowFor(add.host, 'Wendy Ortiz')!)
    expect(calls[0]).toEqual({ url: '/api/leads/lead-9/assignees', method: 'PUT', body: { hub_user_ids: ['u1', 'u2'] } })
    await add.unmount()

    // remove: toggling an already-assigned user drops it → PUT []
    calls = []
    const rm = await mount(
      <AssigneeCorner assignees={ASSIGNED} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" />
    )
    await click(trigger(rm.host))
    await click(rowFor(rm.host, 'Kevin Shaw')!)
    expect(calls[0]).toEqual({ url: '/api/leads/lead-9/assignees', method: 'PUT', body: { hub_user_ids: [] } })
    await rm.unmount()
  })
})

describe('engagement mode="toggle" — per-user idempotent write', () => {
  it('adding POSTs { hub_user_id }; removing DELETEs by hub_user_id', async () => {
    const add = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/engagements/eng-1/assignees" mode="toggle" />
    )
    await click(trigger(add.host))
    await click(rowFor(add.host, 'Kevin Shaw')!)
    expect(calls[0]).toEqual({ url: '/api/engagements/eng-1/assignees', method: 'POST', body: { hub_user_id: 'u1' } })
    await add.unmount()

    calls = []
    const rm = await mount(
      <AssigneeCorner assignees={ASSIGNED} users={USERS} endpoint="/api/engagements/eng-1/assignees" mode="toggle" />
    )
    await click(trigger(rm.host))
    await click(rowFor(rm.host, 'Kevin Shaw')!)
    expect(calls[0]).toEqual({ url: '/api/engagements/eng-1/assignees?hub_user_id=u1', method: 'DELETE', body: null })
    await rm.unmount()
  })

  it('an unmapped-to-Jobber user is selectable but MARKED in the picker when the location is on Jobber', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/engagements/eng-1/assignees" mode="toggle" jobberConnected />
    )
    await click(trigger(host))
    expect(host.textContent).toContain('no Jobber')
    await unmount()
  })

  it('the Jobber nag never shows in lead mode (leads do not push to Jobber)', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" jobberConnected />
    )
    await click(trigger(host))
    expect(host.textContent).not.toContain('no Jobber')
    await unmount()
  })
})

describe('readOnly', () => {
  it('shows the faces but no picker trigger', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={ASSIGNED} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" readOnly />
    )
    expect(host.querySelector('button')).toBeNull()
    // face still present (name on hover)
    expect(Array.from(host.querySelectorAll('span')).some(s => s.getAttribute('title') === 'Kevin Shaw')).toBe(true)
    await unmount()
  })

  it('unassigned + readOnly shows a static ghost, still no button', async () => {
    const { host, unmount } = await mount(
      <AssigneeCorner assignees={[]} users={USERS} endpoint="/api/leads/lead-9/assignees" mode="put" readOnly />
    )
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('+')
    await unmount()
  })
})
