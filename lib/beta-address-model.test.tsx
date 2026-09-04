// @vitest-environment happy-dom
//
// THE ADDRESS MODEL.
//
// One control did three jobs and asked a question to tell them apart. In
// eight weeks that question fired ~75 times and produced ZERO moves — every
// owner answered "just fixing the address". Meanwhile `former_addresses` sat
// empty on all 21,055 rows, so the picker built on it could never fire, and
// 20,201 of 20,558 linked clients had no property link at all, which is how
// Maggie Yost ended up in Fremont here and Omaha in Jobber.
//
// So: three intents, three controls, no question.
//   · the PENCIL corrects in place and pushes ON SAVE
//   · "+ Add address" adds, and creates the Jobber property
//   · "Stop using" retires — in Bee Hub ONLY; Jobber has no archive
//   · a MOVE is add-then-retire
//
// What these pin, in Kevin's order:
//   an edit reaches Jobber on save · an edit on an unlinked client saves and
//   pushes nothing (and SAYS so) · adding creates a property · retiring hides
//   it here and calls nothing · the five labels and only the five · a client
//   with one address behaves exactly as today.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AddressField from '@/components/hive/shared/AddressField'
import {
  ADDRESS_LABELS, ADDRESS_LABEL_VALUES, addressLabelText, validateAddressLabel,
} from '@/lib/address-labels'
import { buildAddressChoices } from '@/lib/address-choice'
import { isRetiredAddress, buildAddedAddress } from '@/lib/lead-address'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LEAD_PATCH = 'app/api/leads/[id]/route.ts'
const ADDR_ROUTE = 'app/api/leads/[id]/addresses/route.ts'
const patchSrc = readFileSync(LEAD_PATCH, 'utf8')
const addrSrc = readFileSync(ADDR_ROUTE, 'utf8')

const PRIMARY = { address: '2101 Lenox Oval', city: 'Pittsburgh', state: 'PA', zip: '15237' }
const OTHER = {
  street: '118 Elmhurst Rd', city: 'Pittsburgh', state: 'PA', zip: '15237',
  display: '118 Elmhurst Rd, Pittsburgh, PA 15237',
  jobber_property_id: '90210', moved_at: '2026-09-02T00:00:00Z',
  label: 'second_home', status: 'active',
}

let host: HTMLDivElement
let root: Root
let calls: { url: string; body: any }[] = []
let toasts: any[] = []
let addrResponse: any = { success: true, jobber: 'created', former_addresses: [] }

const installFetch = () => {
  calls = []
  global.fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    calls.push({ url: u, body })
    if (u.includes('/addresses')) return { ok: true, status: 200, json: async () => addrResponse } as any
    return { ok: true, status: 200, json: async () => ({ address_writeback: { billing: 'updated', property: 'updated', upcoming_visits: false, property_id: '777' } }) } as any
  }) as any
}

const mountField = async (props: any = {}) => {
  toasts = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<AddressField leadId="lead-1" value={PRIMARY} setToast={(t: any) => toasts.push(t)} {...props} />)
  })
}
const unmountField = async () => { if (root) await act(async () => root.unmount()); host?.remove() }

const buttons = () => Array.from(host.querySelectorAll('button'))
const byText = (t: string) => buttons().find(b => (b.textContent || '').trim() === t)
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
const setVal = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}

beforeEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); installFetch() })

// ═══ 1) the question is gone ═══════════════════════════════════
describe('the pencil is always a correction', () => {
  it('no "Did they move?" anywhere, even for a Jobber-linked client with a real prior address', async () => {
    await mountField({ jobberLinked: true, formerAddresses: [] })
    await act(async () => { q('[data-meta-row="address"]')!.click() })
    const street = host.querySelector('input') as HTMLInputElement
    await setVal(street, '9 New Street')
    await act(async () => { byText('Save')?.click() ?? buttons().find(b => b.getAttribute('aria-label') === 'Save')?.click() })
    expect(host.textContent).not.toContain('Did they move?')
    expect(host.textContent).not.toContain('They moved')
    await unmountField()
  })

  it("the PATCH route refuses address_change:'move' and names where it went", () => {
    expect(patchSrc).toContain("rawAddressChange === 'move'")
    expect(patchSrc).toContain('move_is_now_add_then_retire')
    // 'correction' still accepted — nothing that sends it breaks
    expect(patchSrc).toContain("rawAddressChange !== 'correction'")
    // and the whole move branch is gone
    expect(patchSrc).not.toContain('createPropertyForMove(')
    expect(patchSrc).not.toContain('address_move')
  })
})

// ═══ 2) editing pushes on save ═════════════════════════════════
describe('editing reaches Jobber ON SAVE', () => {
  it('a linked client: the PATCH fires once, on save, not while typing', async () => {
    await mountField({ jobberLinked: true })
    await act(async () => { q('[data-meta-row="address"]')!.click() })
    const street = host.querySelector('input') as HTMLInputElement
    await setVal(street, '9 New Street')
    expect(calls, 'nothing sent while typing').toHaveLength(0)
    await act(async () => { buttons().find(b => b.getAttribute('aria-label') === 'Save')!.click() })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/leads/lead-1')
    expect(calls[0].body.address).toContain('9 New Street')
    await unmountField()
  })

  it('the push is server-side and gated on the client being in Jobber', () => {
    expect(patchSrc).toMatch(/addrDiff\.changed && !addrDiff\.cleared && existing\.jobber_client_id/)
    expect(patchSrc).toContain('syncLeadAddressToJobber(')
  })

  it('an UNLINKED client saves, pushes nothing, and the owner is TOLD it went nowhere', async () => {
    await mountField({ jobberLinked: false })
    await act(async () => { q('[data-meta-row="address"]')!.click() })
    await setVal(host.querySelector('input') as HTMLInputElement, '9 New Street')
    await act(async () => { buttons().find(b => b.getAttribute('aria-label') === 'Save')!.click() })
    // it saved
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/leads/lead-1')
    // and the toast does not imply a sync that never happened
    expect(toasts[0].kind).toBe('success')
    expect(toasts[0].msg).toContain('saved here')
    expect(toasts[0].msg).toContain('isn’t in Jobber yet')
    expect(toasts[0].msg).not.toContain('synced to Jobber')
    await unmountField()
  })

  it('the audit note says so too, rather than letting silence imply a sync', () => {
    expect(patchSrc).toContain("not connected to Jobber — saved here only")
  })

  it('the resolved property id rides the writeback contract', () => {
    // Source-read rather than import: jobber-address-sync pulls in the
    // service client, which wants live env. The contract is what matters —
    // the field exists on every return path, including the total-failure
    // one, so a caller never has to guard for its absence.
    const src = readFileSync('lib/jobber-address-sync.ts', 'utf8')
    expect(src).toContain("property_id: null")            // failedBoth
    expect(src).toContain('property_id: propPlan.propertyId')  // the resolved path
    // numeric ids pass through rather than decoding to null — the
    // leads.jobber_property_id convention, matching extractJobberId
    expect(src).toContain('if (/^\\d+$/.test(String(gid))) return String(gid)')
  })

  it('the push now CAPTURES the property link it resolved (the 98.3% fix)', () => {
    expect(patchSrc).toMatch(/addressWriteback\?\.property_id && !\(existing as any\)\.jobber_property_id/)
    // fills a blank only — an existing link is never re-pointed from here
    expect(patchSrc).toContain('jobber_property_id: addressWriteback.property_id')
  })
})

// ═══ 3) adding ═════════════════════════════════════════════════
describe('adding a second address', () => {
  it('the add form posts to the addresses route with the parts and the label', async () => {
    addrResponse = { success: true, jobber: 'created', former_addresses: [OTHER] }
    const changed: any[] = []
    await mountField({ jobberLinked: true, onAddressesChanged: (l: any) => changed.push(l) })
    await act(async () => { q('[data-address-add-open]')!.click() })
    expect(q('[data-address-add]'), 'the add form').toBeTruthy()
    const inputs = Array.from(host.querySelectorAll('input')) as HTMLInputElement[]
    await setVal(inputs[0], '118 Elmhurst Rd')
    await act(async () => { q('[data-address-label="second_home"]')!.click() })
    await act(async () => { byText('Add address')!.click() })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/leads/lead-1/addresses')
    expect(calls[0].body).toMatchObject({ action: 'add', street: '118 Elmhurst Rd', label: 'second_home' })
    expect(changed[0]).toEqual([OTHER])
    await unmountField()
  })

  it('the route creates a Jobber property for it, BEFORE the row write', () => {
    expect(addrSrc).toContain('createPropertyForMove(')
    const create = addrSrc.indexOf('createPropertyForMove(')
    const write = addrSrc.indexOf("former_addresses: next")
    expect(create).toBeGreaterThan(-1)
    expect(create, 'Jobber first, so the row write carries the id').toBeLessThan(write)
    // …and only when the client is actually linked
    expect(addrSrc).toMatch(/if \(existing\.jobber_client_id && existing\.location_id\)/)
  })

  it('the toast says what actually happened in Jobber — created, failed, or never attempted', async () => {
    addrResponse = { success: true, jobber: 'not_linked', former_addresses: [OTHER] }
    await mountField({ jobberLinked: false })
    await act(async () => { q('[data-address-add-open]')!.click() })
    await setVal(host.querySelectorAll('input')[0] as HTMLInputElement, '118 Elmhurst Rd')
    await act(async () => { byText('Add address')!.click() })
    expect(toasts[0].msg).toContain('saved here')
    expect(toasts[0].msg).toContain('isn’t in Jobber yet')
    await unmountField()
  })

  it('the route refuses an address the client already has', () => {
    expect(addrSrc).toContain('address_already_on_client')
  })
})

// ═══ 4) retiring ═══════════════════════════════════════════════
describe('retiring is Bee Hub only', () => {
  it('a live entry offers "Stop using"; the click posts retire and nothing else', async () => {
    addrResponse = { success: true, former_addresses: [{ ...OTHER, status: 'retired' }] }
    await mountField({ jobberLinked: true, formerAddresses: [OTHER] })
    expect(q('[data-address-action="retire"]'), 'the retire control').toBeTruthy()
    await act(async () => { q('[data-address-action="retire"]')!.click() })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ action: 'retire', index: 0 })
    await unmountField()
  })

  it('the wording is honest that Jobber still has it', async () => {
    addrResponse = { success: true, former_addresses: [{ ...OTHER, status: 'retired' }] }
    await mountField({ jobberLinked: true, formerAddresses: [OTHER] })
    await act(async () => { q('[data-address-action="retire"]')!.click() })
    expect(toasts[0].msg).toBe('Address retired here — it stays in Jobber with its history')
    await unmountField()
  })

  it('the route makes NO Jobber call on retire or restore — by design, not omission', () => {
    // the only Jobber call in the whole route is the add path's property create
    expect((addrSrc.match(/createPropertyForMove\(/g) || []).length).toBe(1)
    expect(addrSrc).toContain('Jobber has no')
    expect(addrSrc).not.toContain('propertyDelete')
    expect(addrSrc).not.toContain('propertyEdit')
  })

  it('a retired entry renders struck through, says "No longer used", and offers "Use again"', async () => {
    await mountField({ jobberLinked: true, formerAddresses: [{ ...OTHER, status: 'retired' }] })
    expect(host.querySelector('[data-address-retired="1"]')).toBeTruthy()
    expect(host.textContent).toContain('No longer used')
    expect(q('[data-address-action="restore"]')).toBeTruthy()
    await unmountField()
  })

  it('a retired address DROPS OUT of the send-time picker — that is what retiring means', () => {
    const live = buildAddressChoices(PRIMARY, '155681049', [OTHER])
    expect(live).toHaveLength(2)
    const retired = buildAddressChoices(PRIMARY, '155681049', [{ ...OTHER, status: 'retired' }])
    expect(retired, 'back to the one-address, no-picker path').toHaveLength(1)
    expect(retired[0].isCurrent).toBe(true)
  })

  it('the key stays positional over the FULL array, so retiring one does not re-point another', () => {
    const second = { ...OTHER, display: '55 Third St', street: '55 Third St', jobber_property_id: '3' }
    const all = buildAddressChoices(PRIMARY, '1', [{ ...OTHER, status: 'retired' }, second])
    expect(all).toHaveLength(2)
    expect(all[1].key, 'index 1 in the stored array, not position 0 in the output').toBe('former:1')
  })

  it('a legacy entry with no status reads as ACTIVE — nothing written before this is hidden', () => {
    const legacy = { display: '10 Old Rd', street: '10 Old Rd', city: '', state: '', zip: '', jobber_property_id: null, moved_at: '' }
    expect(isRetiredAddress(legacy as any)).toBe(false)
    expect(buildAddressChoices(PRIMARY, '1', [legacy])).toHaveLength(2)
  })
})

// ═══ 5) the five labels ════════════════════════════════════════
describe('labels — the fixed five, and only those five', () => {
  it('exactly five, in order, with Other last', () => {
    expect(ADDRESS_LABEL_VALUES).toEqual(['home', 'second_home', 'office', 'storage', 'other'])
    expect(ADDRESS_LABELS.map(l => l.text)).toEqual(['Home', 'Second home', 'Office', 'Storage', 'Other'])
  })

  it('the add form renders those five and nothing else', async () => {
    await mountField({ jobberLinked: true })
    await act(async () => { q('[data-address-add-open]')!.click() })
    const chips = Array.from(host.querySelectorAll('[data-address-label]'))
    expect(chips).toHaveLength(5)
    expect(chips.map(c => c.getAttribute('data-address-label')))
      .toEqual(['home', 'second_home', 'office', 'storage', 'other'])
    await unmountField()
  })

  it('anything outside the five is refused server-side', () => {
    expect(validateAddressLabel('holiday_home', null)).toEqual({ ok: false, error: 'invalid_address_label' })
    expect(validateAddressLabel('second_home', null)).toEqual({ ok: true, label: 'second_home', note: null })
    // absent → the default, so an add with no label still works
    expect(validateAddressLabel(undefined, null)).toEqual({ ok: true, label: 'home', note: null })
  })

  it('Other REQUIRES a note — an escape hatch that says nothing is worse than no label', () => {
    expect(validateAddressLabel('other', '')).toEqual({ ok: false, error: 'other_label_requires_a_note' })
    expect(validateAddressLabel('other', '  Mum’s house ')).toEqual({ ok: true, label: 'other', note: 'Mum’s house' })
    // and a note is dropped where it is meaningless
    expect(validateAddressLabel('office', 'ignored')).toEqual({ ok: true, label: 'office', note: null })
  })

  it('the card shows the note for Other, the word for the rest', () => {
    expect(addressLabelText('second_home', null)).toBe('Second home')
    expect(addressLabelText('other', 'Mum’s house')).toBe('Mum’s house')
    expect(addressLabelText('other', '')).toBe('Other') // degrades, never blank
    expect(addressLabelText(null, null)).toBeNull()
  })

  it('the label renders on the card next to the address it belongs to', async () => {
    await mountField({ jobberLinked: true, addressLabel: 'home', formerAddresses: [OTHER] })
    expect(host.textContent).toContain('Home')
    expect(host.textContent).toContain('Second home')
    await unmountField()
  })

  it('the label stays in Bee Hub — nothing pushes it to Jobber', () => {
    expect(addrSrc).not.toMatch(/name:\s*(v\.label|label)/)
    // and never smuggled into the address itself, which prints on invoices
    expect(addrSrc).not.toMatch(/street2:\s*(v\.label|label)/)
  })
})

// ═══ 6) one address is unchanged ═══════════════════════════════
describe('a client with ONE address behaves exactly as today', () => {
  it('no other-address rows, and the picker still sees a single choice', async () => {
    await mountField({ jobberLinked: true, formerAddresses: [] })
    expect(host.querySelector('[data-meta-row="former-addresses"]')).toBeNull()
    expect(host.querySelector('[data-address-entry]')).toBeNull()
    expect(buildAddressChoices(PRIMARY, '155681049', [])).toHaveLength(1)
    await unmountField()
  })

  it('the add form is closed until asked for, and posts nothing on its own', async () => {
    await mountField({ jobberLinked: true })
    expect(q('[data-address-add]')).toBeNull()
    expect(calls).toHaveLength(0)
    await unmountField()
  })

  it('buildAddedAddress composes the stored shape, active and labelled', () => {
    const e = buildAddedAddress({ street: '118 Elmhurst Rd', city: 'Pittsburgh', state: 'PA', zip: '15237' }, '90210', 'second_home', null, '2026-09-04T00:00:00Z')
    expect(e).toMatchObject({
      street: '118 Elmhurst Rd', display: '118 Elmhurst Rd, Pittsburgh, PA, 15237',
      jobber_property_id: '90210', label: 'second_home', status: 'active',
    })
    expect(buildAddedAddress({ street: '', city: '', state: '', zip: '' }, null, 'home', null, 'x')).toBeNull()
  })
})
