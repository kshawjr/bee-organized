// @vitest-environment happy-dom
//
// Lynette Ewy (KC), 2026-10-20 — Wanda Wilkinson. She saved an address on a
// new client; Send to Jobber then asked for city and state the record already
// had, and once she typed them the address read
// "15353 Carter Road, Overland Park, KS, Overland Park, KS, 66221" — in Jobber
// and in the client's address list. Two faults, two fixes, pinned here:
//
//   FIX 2 — a saved address reaches the send screen. leadPatchMap dropped
//   city/state/zip and BeeHub's merge never touched the address list, so the
//   screen (personVisitAddress) checked a stale, city-less copy until a
//   reload. leadColsToPersonFields now carries the parts as
//   originCity/originState/originZip and mergePersonPatch moves the list
//   entry the way the server does.
//
//   FIX 3 — the screen saves the street, not the whole line. The street box
//   can be pre-filled with a full saved line; joining the typed parts onto it
//   doubled them. The trailing repeat is stripped before the save, and the
//   list entry it writes after the send carries the street only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SendToJobberModal from '@/components/hive/SendToJobberModal'
import { leadColsToPersonFields, mergePersonPatch } from '@/components/hive/shared/leadPatchMap'
import { personVisitAddress, isVisitAddressComplete } from './visit-address'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Wanda Wilkinson',
  outreachTimeline: [],
  assessment: null,
  assessmentType: 'in-person',
  addresses: [],
  jobberClient: null,
  locationName: 'Kansas City',
  ...over,
})

// What AddressField PATCHes (and hands up) for Wanda's address.
const SAVED_COLS = {
  address: '15353 Carter Road, Overland Park, KS, 66221',
  city: 'Overland Park', state: 'KS', zip: '66221',
}

let host: HTMLDivElement
let root: Root
let calls: { url: string; method: string; body: any }[]

beforeEach(() => {
  calls = []
  global.fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null })
    if (u.includes('/send-to-jobber')) {
      return { ok: true, status: 200, json: async () => ({ success: true, jobber_client_id: '5', jobber_request_id: '777', jobber_assessment_id: '999' }) } as any
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
  }) as any
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  if (host) host.remove()
  vi.restoreAllMocks()
})

let onDone: ReturnType<typeof vi.fn>
const mount = async (p: any) => {
  onDone = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<SendToJobberModal person={p} onDone={onDone} onClose={() => {}} />) })
}
const buttons = () => Array.from(host.querySelectorAll('button'))
const contains = (t: string) => buttons().find(b => (b.textContent || '').includes(t))
const aria = (l: string) => buttons().find(b => b.getAttribute('aria-label') === l)
const setInput = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const form = () => host.querySelector('[data-address-form]') as HTMLElement | null
const streetBox = () => form()!.querySelector('input[placeholder="Street address"]') as HTMLInputElement
const box = (l: string) => host.querySelector(`input[aria-label="${l}"]`) as HTMLInputElement
const sendBtn = () => contains('Send to Jobber') as HTMLButtonElement
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
const toReview = async () => {
  await act(async () => { aria('Create a Request')!.click() })
  await act(async () => { contains('Continue')!.click() })
  await act(async () => { aria('Include assessment')!.click() })
  await act(async () => { aria('In-Person')!.click() })
  await setInput(host.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement, '2026-11-01')
  await act(async () => { contains('Review')!.click() })
}
const patches = () => calls.filter(c => c.url === '/api/leads/p1' && c.method === 'PATCH')
const sends = () => calls.filter(c => c.url.includes('/send-to-jobber'))

// ── FIX 2 ───────────────────────────────────────────────────────────────

describe('fix 2 — a saved address reaches the person the send screen reads', () => {
  it('leadColsToPersonFields carries the parts', () => {
    expect(leadColsToPersonFields(SAVED_COLS)).toEqual({
      address: SAVED_COLS.address, originCity: 'Overland Park', originState: 'KS', originZip: '66221',
    })
  })

  it('a zip-only client (no list) gets the entry the next load would build', () => {
    const before = person({ address: '', originZip: '66221' })
    const after = mergePersonPatch(before, leadColsToPersonFields(SAVED_COLS))
    expect(after.addresses).toEqual([{
      type: 'Service', value: SAVED_COLS.address, street: SAVED_COLS.address,
      city: 'Overland Park', state: 'KS', zip: '66221',
    }])
    expect(isVisitAddressComplete(personVisitAddress(after))).toBe(true)
  })

  it('a stale first entry is rewritten — street only, others untouched', () => {
    const billing = { type: 'Billing', value: '1 Bill St, KC, MO', street: '1 Bill St', city: 'KC', state: 'MO', zip: '' }
    const before = person({
      address: '9 Old Rd',
      addresses: [billing, { type: 'Service', value: '9 Old Rd', street: '9 Old Rd', city: '', state: '', zip: '' }],
    })
    const after = mergePersonPatch(before, leadColsToPersonFields(SAVED_COLS))
    expect(after.addresses[0]).toBe(billing)
    expect(after.addresses[1]).toEqual({
      type: 'Service', value: SAVED_COLS.address, street: '15353 Carter Road',
      city: 'Overland Park', state: 'KS', zip: '66221',
    })
  })

  it('a cleared address drops the entry', () => {
    const before = person({ address: '9 Old Rd', addresses: [{ type: 'Service', value: '9 Old Rd', street: '9 Old Rd' }] })
    const after = mergePersonPatch(before, leadColsToPersonFields({ address: null, city: null, state: null, zip: null }))
    expect(after.addresses).toEqual([])
  })

  it('a patch with no address leaves the list alone', () => {
    const list = [{ type: 'Service', value: '9 Old Rd', street: '9 Old Rd' }]
    const after = mergePersonPatch(person({ addresses: list }), { phone: '(913) 555-0100' })
    expect(after.addresses).toBe(list)
    expect(after.phone).toBe('(913) 555-0100')
  })

  it('BeeHub merges every hand-up through mergePersonPatch (not a bare spread)', () => {
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(src).toContain('onPersonPatched={(id, fields)=>{ setPeople(prev => prev.map(x => x.id === id ? mergePersonPatch(x, fields) : x)) }}')
  })

  it("Lynette's case: after the save, the send screen asks for nothing", async () => {
    const saved = mergePersonPatch(person({ address: '', originZip: '66221' }), leadColsToPersonFields(SAVED_COLS))
    await mount(saved)
    await toReview()
    expect(form()).toBeNull()
    expect(host.textContent).not.toContain('Address required')
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()).toHaveLength(0)
    expect(sends()).toHaveLength(1)
  })
})

// ── FIX 3 ───────────────────────────────────────────────────────────────

describe('fix 3 — the send screen saves the street, never the whole line twice', () => {
  it("Wanda's shape: a pre-filled line + typed parts saves ONE tail", async () => {
    // What the stale copy looked like: the line, no city/state, zip from intake.
    await mount(person({ address: '15353 Carter Road, Overland Park, KS', originZip: '66221' }))
    await toReview()
    expect(streetBox().value).toBe('15353 Carter Road, Overland Park, KS')
    await setInput(box('City'), 'Overland Park')
    await setInput(box('State'), 'KS')
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()[0].body).toEqual({
      address: '15353 Carter Road, Overland Park, KS, 66221', city: 'Overland Park', state: 'KS', zip: '66221',
    })
    expect(sends()).toHaveLength(1)
  })

  it('a pre-filled line that already carries the zip is not doubled either', async () => {
    await mount(person({ address: '700 Eucalyptus Avenue, Vista, CA, 92084' }))
    await toReview()
    await setInput(box('City'), 'Vista')
    await setInput(box('State'), 'CA')
    await setInput(box('Zip'), '92084')
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()[0].body.address).toBe('700 Eucalyptus Avenue, Vista, CA, 92084')
  })

  it('the list entry written after the send has the street only (new entry)', async () => {
    await mount(person({ address: '15353 Carter Road, Overland Park, KS', originZip: '66221' }))
    await toReview()
    await setInput(box('City'), 'Overland Park')
    await setInput(box('State'), 'KS')
    await act(async () => { sendBtn().click() }); await flush()
    const patch = onDone.mock.calls[0][0]
    expect(patch.address).toBe('15353 Carter Road, Overland Park, KS, 66221')
    expect(patch.addresses).toEqual([{
      type: 'Service', value: '15353 Carter Road, Overland Park, KS, 66221',
      street: '15353 Carter Road', city: 'Overland Park', state: 'KS', zip: '66221',
    }])
  })

  it('the list entry written after the send has the street only (existing entry)', async () => {
    await mount(person({
      addresses: [{ type: 'Service', value: '15353 Carter Road, Overland Park, KS', street: '15353 Carter Road, Overland Park, KS', city: '', state: '', zip: '66221' }],
    }))
    await toReview()
    await setInput(box('City'), 'Overland Park')
    await setInput(box('State'), 'KS')
    await act(async () => { sendBtn().click() }); await flush()
    expect(onDone.mock.calls[0][0].addresses[0]).toMatchObject({ street: '15353 Carter Road', city: 'Overland Park', state: 'KS' })
  })

  it('a plain typed street is saved exactly as typed (unit kept)', async () => {
    await mount(person())
    await toReview()
    await setInput(streetBox(), '1 Elm St Apt 4')
    await setInput(box('City'), 'Austin')
    await setInput(box('State'), 'TX')
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()[0].body.address).toBe('1 Elm St Apt 4, Austin, TX')
    expect(onDone.mock.calls[0][0].addresses[0].street).toBe('1 Elm St Apt 4')
  })
})
