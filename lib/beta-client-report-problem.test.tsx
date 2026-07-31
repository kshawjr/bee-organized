// @vitest-environment happy-dom
//
// "Report a problem with this client" — the client profile "···" menu item
// (issue 131, design b). MOUNT tests: the item is present, opens the feedback
// flow with an ID-ONLY record context, survives read-only surfaces, and closes
// the issue-120 empty-menu gap on a Jobber-linked + networked client.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// GET fetch stub — profile + the two side fetches ClientProfile fires
// (network twin, assignees). `twin` toggles whether the client is already in
// the Network (drives the issue-120 gap scenario).
let twinRows: any[] = []
const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    address: null, city: null, state: null, zip: null, created_at: daysAgo(400),
    source: 'Webform', paused: false, marketing_opt_out: false, snoozed_until: null,
    snoozed_note: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [], buzz_notes: [],
  job_notes: [], tags: [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

let profileBody: any
const installFetch = () => {
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
    if (method !== 'GET') return json({ ok: true })
    if (u.includes('/api/partners')) return json({ rows: twinRows })
    if (u.includes('/assignees')) return json({ assignees: [] })
    if (u.includes('/profile')) return json(profileBody)
    return json({})
  })
}

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
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const menuLabels = (host: Element) =>
  [...host.querySelectorAll('button')].map(b => (b.textContent || '').trim())

const mountProfile = (over: any = {}) => mount(
  <ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}}
    onSendToJobber={() => {}}
    lookupOptions={{ sources: [], projectTypes: [], clientTags: [] } as any}
    locationUsers={[] as any} {...over} />
)
const openMenu = async (host: Element) => { await click(host.querySelector('button[aria-label="More"]')!) }

beforeEach(() => {
  document.body.innerHTML = ''
  twinRows = []
  profileBody = profilePayload()
  installFetch()
})

describe('menu item — present and opens the feedback flow with record context', () => {
  it('the "···" menu offers "Report a problem with this client"', async () => {
    const { host, unmount } = await mountProfile()
    await openMenu(host)
    expect(btn(host, 'Report a problem with this client')).toBeTruthy()
    await unmount()
  })

  it('clicking it hands an ID-ONLY context up (kind/lead_id/location_id/screen/path/origin) + a name-only title', async () => {
    const onReportProblem = vi.fn()
    const { host, unmount } = await mountProfile({ onReportProblem })
    await openMenu(host)
    await click(btn(host, 'Report a problem with this client')!)

    expect(onReportProblem).toHaveBeenCalledTimes(1)
    const arg = onReportProblem.mock.calls[0][0]
    expect(arg.title).toBe('Problem with Dana Client')
    expect(arg.context).toEqual({
      kind: 'client',
      lead_id: 'lead-9',
      location_id: 'loc-uuid-1',
      screen: 'Clients',
      path: '/clients/lead-9',
      origin: 'client_profile_menu',
    })
    // The context is id-only — no name/email/phone rides in it (issue 110a).
    // (The name is only in the human-facing title, an editable free-text field.)
    expect(JSON.stringify(arg.context)).not.toContain('dana@x.com')
    expect(JSON.stringify(arg.context)).not.toContain('555')
    expect(JSON.stringify(arg.context)).not.toContain('Dana')
    await unmount()
  })
})

describe('role visibility — everyone can report; write items stay gated', () => {
  it('a writable profile shows Report ALONGSIDE the write items', async () => {
    const { host, unmount } = await mountProfile()
    await openMenu(host)
    const labels = menuLabels(host)
    expect(labels).toContain('Report a problem with this client')
    expect(labels).toContain('Add to Network…')
    expect(labels).toContain('Mark as junk')
    await unmount()
  })

  it('read-only (lite_user / paused location) still shows Report, but NOT the write items', async () => {
    const onReportProblem = vi.fn()
    const { host, unmount } = await mountProfile({ readOnly: true, onReportProblem })
    // The menu is no longer empty in read-only — the "···" trigger exists…
    expect(host.querySelector('button[aria-label="More"]')).toBeTruthy()
    await openMenu(host)
    const labels = menuLabels(host)
    expect(labels).toContain('Report a problem with this client')
    expect(labels).not.toContain('Add to Network…')
    expect(labels).not.toContain('Mark as junk')
    // …and it still fires (non-mutating, allowed read-only).
    await click(btn(host, 'Report a problem with this client')!)
    expect(onReportProblem).toHaveBeenCalledTimes(1)
    await unmount()
  })
})

describe('issue-120 gap — the menu is never empty', () => {
  it('a Jobber-linked, already-networked client still has a usable menu (Report)', async () => {
    // jobber_client_id set → "Mark as junk" suppressed; twin exists → "Add to
    // Network" suppressed. Before this change the menu rendered nothing.
    profileBody = profilePayload({ client: { jobber_client_id: 'jc-1' } })
    twinRows = [{ id: 'partner-1' }]
    const { host, unmount } = await mountProfile()
    expect(host.querySelector('button[aria-label="More"]')).toBeTruthy()
    await openMenu(host)
    const labels = menuLabels(host)
    expect(labels).toContain('Report a problem with this client')
    expect(labels).not.toContain('Add to Network…')
    expect(labels).not.toContain('Mark as junk')
    await unmount()
  })
})
