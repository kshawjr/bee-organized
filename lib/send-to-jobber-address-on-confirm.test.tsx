// @vitest-environment happy-dom
//
// Send to Jobber — a missing address no longer sends the owner away.
// When an in-person assessment or a job needs an address and the client's
// isn't complete (street, city AND state — lib/visit-address.ts), the review
// screen shows the address box (the shared AddressAutofill), saves what's
// typed to the client record, then sends. Pins:
//   · it appears only when needed — full address or virtual: no box, no save
//   · an incomplete box still stops the send, on the same screen
//   · save BEFORE send; a failed save stops, nothing is sent
//   · a Google pick fills street/city/state/zip; a failed lookup never blocks
//     typing it by hand
//   · closing the screen mid-type sends no Places lookup (it bills per call)
//   · the server enforces the same rule, whatever the screen did
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SendToJobberModal from '@/components/hive/SendToJobberModal'
import { missingVisitAddressParts, isVisitAddressComplete, personVisitAddress, describeMissing } from './visit-address'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Sarah Mitchell',
  outreachTimeline: [],
  assessment: null,
  assessmentType: 'in-person',
  addresses: [],
  jobberClient: null,
  locationName: 'Denver',
  ...over,
})

let host: HTMLDivElement
let root: Root
let calls: { url: string; method: string; body: any }[]
let patchOk: boolean
let placesOk: boolean

beforeEach(() => {
  calls = []; patchOk = true; placesOk = true
  global.fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null })
    if (u === '/api/leads/p1' && method === 'PATCH') {
      return { ok: patchOk, status: patchOk ? 200 : 500, json: async () => (patchOk ? { ok: true } : { error: 'db down' }) } as any
    }
    if (u === '/api/places/autocomplete') {
      if (!placesOk) return { ok: false, status: 500, json: async () => ({ error: 'places down' }) } as any
      return { ok: true, status: 200, json: async () => ({ predictions: [{ place_id: 'pl1', description: '1 Elm St, Austin, TX, USA', main_text: '1 Elm St', secondary_text: 'Austin, TX, USA' }] }) } as any
    }
    if (u === '/api/places/details') {
      return { ok: true, status: 200, json: async () => ({ formatted: '1 Elm St, Austin, TX 78701, USA', street: '1 Elm St', city: 'Austin', state: 'TX', zip: '78701' }) } as any
    }
    if (u.includes('/send-to-jobber')) {
      return { ok: true, status: 200, json: async () => ({ success: true, jobber_client_id: '5', jobber_request_id: '777', jobber_job_id: '888', jobber_assessment_id: '999' }) } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  }) as any
})
afterEach(async () => {
  vi.useRealTimers()
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

const toReview = async (type: 'In-Person' | 'Virtual' = 'In-Person') => {
  await act(async () => { aria('Create a Request')!.click() })
  await act(async () => { contains('Continue')!.click() })
  await act(async () => { aria('Include assessment')!.click() })
  await act(async () => { aria(type)!.click() })
  await setInput(host.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement, '2026-08-01')
  await act(async () => { contains('Review')!.click() })
}
const typeAddress = async (street: string, city: string, state: string, zip = '') => {
  await setInput(streetBox(), street)
  await setInput(box('City'), city)
  await setInput(box('State'), state)
  if (zip) await setInput(box('Zip'), zip)
}
const sends = () => calls.filter(c => c.url.includes('/send-to-jobber'))
const patches = () => calls.filter(c => c.url === '/api/leads/p1' && c.method === 'PATCH')

describe('only when it is needed', () => {
  it('a client with a full address sees no box and nothing is saved', async () => {
    await mount(person({ addresses: [{ street: '9 Oak Ave', city: 'Denver', state: 'CO', zip: '80202' }] }))
    await toReview()
    expect(form()).toBeNull()
    expect(sendBtn().disabled).toBe(false)
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()).toHaveLength(0)
    expect(sends()).toHaveLength(1)
  })

  it('a virtual send never sees it, even with no address at all', async () => {
    await mount(person())
    await toReview('Virtual')
    expect(form()).toBeNull()
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()).toHaveLength(0)
    expect(sends()).toHaveLength(1)
  })
})

describe('in-person, no address — fixed on the same screen', () => {
  it('shows the box; an empty box still stops the send here', async () => {
    await mount(person())
    await toReview()
    expect(form()).toBeTruthy()
    expect(sendBtn().disabled).toBe(true)
    expect(host.textContent).toContain('Add the street, city and state to send.')
  })

  it('street + city but no state still stops it', async () => {
    await mount(person())
    await toReview()
    await typeAddress('1 Elm St', 'Austin', '')
    expect(sendBtn().disabled).toBe(true)
    expect(host.textContent).toContain('Add the state to send.')
  })

  it('typed by hand → saved to the client FIRST, then sent; zip optional', async () => {
    await mount(person())
    await toReview()
    await typeAddress('1 Elm St', 'Austin', 'TX')
    expect(sendBtn().disabled).toBe(false)
    await act(async () => { sendBtn().click() }); await flush()
    const order = calls.filter(c => c.method !== 'GET').map(c => c.url)
    expect(order).toEqual(['/api/leads/p1', '/api/leads/p1/send-to-jobber'])
    expect(patches()[0].body).toEqual({ address: '1 Elm St, Austin, TX', city: 'Austin', state: 'TX', zip: null })
    // the record shows it without a reload
    const patch = onDone.mock.calls[0][0]
    expect(patch.address).toBe('1 Elm St, Austin, TX')
    expect(patch.originCity).toBe('Austin')
    expect(patch.addresses[0]).toMatchObject({ value: '1 Elm St, Austin, TX', city: 'Austin', state: 'TX' })
  })

  it('a failed save stops on this screen and sends nothing', async () => {
    patchOk = false
    await mount(person())
    await toReview()
    await typeAddress('1 Elm St', 'Austin', 'TX')
    await act(async () => { sendBtn().click() }); await flush()
    expect(sends()).toHaveLength(0)
    expect(host.textContent).toContain("Couldn't save the address to the client: db down")
    expect(onDone).not.toHaveBeenCalled()
  })

  it('a partial address (street only) opens with the street filled in', async () => {
    await mount(person({ addresses: [{ street: '9 Oak Ave', city: '', state: '' }] }))
    await toReview()
    expect(form()).toBeTruthy()
    expect(streetBox().value).toBe('9 Oak Ave')
    await setInput(box('City'), 'Denver'); await setInput(box('State'), 'CO')
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()[0].body).toEqual({ address: '9 Oak Ave, Denver, CO', city: 'Denver', state: 'CO', zip: null })
    expect(sends()).toHaveLength(1)
  })

  it('a job with no address gets the same box (not a dead end)', async () => {
    await mount(person())
    await act(async () => { aria('Create a Job')!.click() })
    await act(async () => { contains('Continue')!.click() })
    expect(host.textContent).toContain('you can add it on the next screen')
    await setInput(host.querySelector('input[aria-label="Job work description"]') as HTMLInputElement, 'Garage cleanout')
    await setInput(host.querySelector('input[aria-label="Job price"]') as HTMLInputElement, '450')
    await act(async () => { contains('Review')!.click() })
    expect(form()).toBeTruthy()
    expect(sendBtn().disabled).toBe(true)
    await typeAddress('1 Elm St', 'Austin', 'TX')
    await act(async () => { sendBtn().click() }); await flush()
    expect(patches()).toHaveLength(1)
    expect(sends()[0].body.creation_type).toBe('job_direct')
  })
})

describe('Google Places on the review screen', () => {
  it('picking a suggestion fills street, city, state and zip', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount(person())
    await toReview()
    await setInput(streetBox(), '1 Elm')
    await act(async () => { vi.advanceTimersByTime(200) }); await flush()
    const pick = Array.from(form()!.querySelectorAll('button')).find(b => (b.textContent || '').includes('1 Elm St'))!
    await act(async () => { pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) }); await flush()
    expect(streetBox().value).toBe('1 Elm St')
    expect(box('City').value).toBe('Austin')
    expect(box('State').value).toBe('TX')
    expect(box('Zip').value).toBe('78701')
    expect(sendBtn().disabled).toBe(false)
  })

  it('a failed lookup does not block typing it by hand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    placesOk = false
    await mount(person())
    await toReview()
    await setInput(streetBox(), '1 Elm St')
    await act(async () => { vi.advanceTimersByTime(200) }); await flush()
    expect(calls.some(c => c.url === '/api/places/autocomplete')).toBe(true)
    await setInput(box('City'), 'Austin'); await setInput(box('State'), 'TX')
    await act(async () => { sendBtn().click() }); await flush()
    expect(sends()).toHaveLength(1)
  })

  it('closing the screen mid-type sends NO lookup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    await mount(person())
    await toReview()
    await setInput(streetBox(), '1 Elm')                  // inside the 175 ms wait
    await act(async () => root.unmount())                  // owner closes the screen
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(calls.filter(c => c.url.startsWith('/api/places'))).toEqual([])
    root = undefined as any
  })
})

describe('the rule itself (lib/visit-address.ts) and the server', () => {
  it('street, city and state are required; zip is not', () => {
    expect(isVisitAddressComplete({ street: '1 Elm', city: 'Austin', state: 'TX' })).toBe(true)
    expect(missingVisitAddressParts({ street: '1 Elm', city: ' ', state: 'TX', zip: '78701' })).toEqual(['city'])
    expect(describeMissing(['street', 'city', 'state'])).toBe('street, city and state')
  })
  it('a lone zip is refused', () => {
    expect(missingVisitAddressParts({ zip: '78701' })).toEqual(['street', 'city', 'state'])
    expect(missingVisitAddressParts(null)).toEqual(['street', 'city', 'state'])
  })
  it('reads the person the way the send route reads the lead', () => {
    expect(personVisitAddress({ addresses: [{ value: '9 Oak', city: 'Denver', state: 'CO' }] })).toEqual({ street: '9 Oak', city: 'Denver', state: 'CO', zip: '' })
    expect(personVisitAddress({ address: '9 Oak, Denver, CO', originCity: 'Denver', originState: 'CO', addresses: [] })).toMatchObject({ city: 'Denver', state: 'CO' })
    expect(personVisitAddress({ addresses: [], originZip: '78701' })).toBeNull()
  })
  it('the send route refuses an incomplete address for any visit', () => {
    const route = readFileSync('app/api/leads/[id]/send-to-jobber/route.ts', 'utf8')
    expect(route).toContain('if (addressRequired) {')
    expect(route).toContain('const missing = missingVisitAddressParts(address)')
    expect(route).toContain('missing_address_parts: missing')
    expect(route).not.toContain('if (!address && addressRequired)')
  })
  it('correcting the address keeps the address list’s parts in step (the send reads them first)', () => {
    const patch = readFileSync('app/api/leads/[id]/route.ts', 'utf8')
    expect(patch).toContain('value: addrDiff.display, street: addrDiff.street, city: addrDiff.city, state: addrDiff.state, zip: addrDiff.zip')
  })
})
