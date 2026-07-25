// @vitest-environment happy-dom
// ClientProfile Request details — visible for EVERY client (#69), including
// Jobber-linked ones.
//
// The section used to be suppressed behind !jobberLinked — a pre-Jobber
// provenance framing from 93e583c ("webform text … hasn't become an SR record
// yet"), not a data rule: Jobber never reads or writes request_details (the
// import excludes it on both branches), and PersonCard already edits it on
// linked records. Kevin's call: the field is first-class on every record.
// Covers:
//   - jobber-linked + null → section PRESENT with the dashed add-slot
//     (asserted explicitly, so the suppression coming back fails the suite)
//   - jobber-linked + populated → value shown
//   - non-Jobber client → unchanged (add-slot when empty, value when set)
//   - readOnly → value visible, no add-slot, no pencil
//   - the manual edit persists for a jobber-linked client: add → type → save
//     PATCHes /api/leads/[id] with { request_details } (the write path is not
//     gated the way the display was)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// Any non-empty id reads as linked; shape mirrors real encoded ids.
const JOBBER_ID = 'Z2lkOi8vSm9iYmVyL0NsaWVudC8xMjM='

const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100',
    created_at: daysAgo(40), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [],
  buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let patches: Array<{ id: string; body: any }> = []
let profileOver: any = {}
beforeEach(() => {
  document.body.innerHTML = ''
  patches = []
  profileOver = {}
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body)
      patches.push({ id: u.split('/').pop()!, body })
      return jsonRes({ lead: { id: u.split('/').pop(), ...body } })
    }
    if (u.includes('/profile')) return jsonRes(profilePayload(profileOver))
    if (u.includes('/outreach-timeline')) return jsonRes({ items: [], drip_progress_id: null, drip_path_name: null, paused: false, stopped: false, completed: false, completed_at: null, stopped_at: null })
    return jsonRes({})
  })
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (el: Element, value: string) => act(async () => {
  const proto = (globalThis as any).window.HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

const profile = (over: any = {}) => (
  <ClientProfile clientId="lead-9" onClose={() => {}} setToast={() => {}} {...over} />
)
const sectionLabel = (host: Element) =>
  [...host.querySelectorAll('p')].find(p => (p.textContent || '').trim() === 'Request details')
const addSlot = (host: Element) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes('Add a description'))
const saveBtn = (host: Element) => host.querySelector('button[aria-label="Save"]') as HTMLButtonElement | null

describe('ClientProfile Request details — all clients (#69)', () => {
  it('jobber-linked + null → section PRESENT with the dashed add-slot', async () => {
    profileOver = { client: { jobber_client_id: JOBBER_ID, request_details: null } }
    const m = await mount(profile())
    // Explicit presence: the section disappearing again means the
    // !jobberLinked suppression came back.
    expect(sectionLabel(m.host), 'Request details section must render for jobber-linked clients').toBeTruthy()
    expect(addSlot(m.host), 'empty value must offer the add-slot').toBeTruthy()
    await m.unmount()
  })

  it('jobber-linked + populated → value shown', async () => {
    profileOver = { client: { jobber_client_id: JOBBER_ID, request_details: 'Whole-house declutter before listing' } }
    const m = await mount(profile())
    expect(sectionLabel(m.host)).toBeTruthy()
    expect(m.host.textContent).toContain('Whole-house declutter before listing')
    expect(addSlot(m.host)).toBeFalsy()
    await m.unmount()
  })

  it('non-Jobber client unchanged: add-slot when empty, value when set', async () => {
    profileOver = { client: { jobber_client_id: null, request_details: null } }
    const m1 = await mount(profile())
    expect(sectionLabel(m1.host)).toBeTruthy()
    expect(addSlot(m1.host)).toBeTruthy()
    await m1.unmount()

    profileOver = { client: { jobber_client_id: null, request_details: 'Garage shelving system' } }
    const m2 = await mount(profile())
    expect(m2.host.textContent).toContain('Garage shelving system')
    expect(addSlot(m2.host)).toBeFalsy()
    await m2.unmount()
  })

  it('readOnly: value visible, but no add-slot and no pencil', async () => {
    profileOver = { client: { jobber_client_id: JOBBER_ID, request_details: 'Weekly tidy of the studio' } }
    const m1 = await mount(profile({ readOnly: true }))
    expect(m1.host.textContent).toContain('Weekly tidy of the studio')
    expect(m1.host.querySelector('.bee-edit-pencil')).toBeNull()
    await m1.unmount()

    // Empty + readOnly: EditableDesc renders nothing under the label —
    // crucially NOT the add affordance.
    profileOver = { client: { jobber_client_id: JOBBER_ID, request_details: null } }
    const m2 = await mount(profile({ readOnly: true }))
    expect(addSlot(m2.host)).toBeFalsy()
    await m2.unmount()
  })

  it('manual edit persists for a jobber-linked client: PATCH { request_details }', async () => {
    profileOver = { client: { jobber_client_id: JOBBER_ID, request_details: null } }
    const m = await mount(profile())
    await click(addSlot(m.host)!)
    await type(m.host.querySelector('textarea')!, 'Basement cleanout, needs bins')
    await click(saveBtn(m.host)!)
    expect(patches).toEqual([{ id: 'lead-9', body: { request_details: 'Basement cleanout, needs bins' } }])
    expect(m.host.querySelector('textarea')).toBeNull()
    expect(m.host.textContent).toContain('Basement cleanout, needs bins')
    await m.unmount()
  })
})
