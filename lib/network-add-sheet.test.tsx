// @vitest-environment happy-dom
//
// NetworkAddSheet — the ONE Add entry for Network (Person / Company
// segmented toggle, beta shell). Mount tests, asserting PERSISTENCE
// through the real client→column mapping (partnerPatchToRow /
// companyPatchToRow — the exact row the API sends to supabase), not
// just the emitted payload:
//
//   0a. TITLE LANDS IN THE DB — the Classic modal collected it and
//       dropped it; here it must survive all the way to the column.
//   0b. A person created into a company carries BOTH company_id (FK,
//       source of truth) AND the company display string (the cache).
//   0c. Every new row starts at stage 'New Contact' — never 'Contact'
//       (outside the stage vocabulary).
//   §2. Toggling Person↔Company PRESERVES the shared field values.
//   §4. Every inventoried field round-trips.
//   §5. defaultCompany preset applies AND the sheet opens on Person.
//   Company branch: industry/notes/link-people; link-people writes BOTH
//   keys per person.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkAddSheet from '@/components/hive/NetworkAddSheet'
import { partnerPatchToRow, companyPatchToRow } from '@/lib/crm'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const SPECIALTIES = [
  { id: 'real-estate', label: '🏠 Realtor' },
  { id: 'senior-living', label: '🏥 Senior Living' },
]
const TIERS = [
  { id: 'referral-partner', label: 'Referral Partner' },
  { id: 'power-partner', label: 'Power Partner' },
]
const COMPANIES = [
  { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', isDeleted: false },
]
const PARTNERS = [
  { id: 'p1', name: 'Existing Erin', title: 'Agent', isDeleted: false },
  { id: 'p2', name: 'Linkable Lou', title: '', isDeleted: false },
]

let host: HTMLDivElement
let root: Root

const mount = async (props: any = {}) => {
  // AddressAutofill debounces fetches; a resolved stub keeps it quiet.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ predictions: [] }) })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <NetworkAddSheet
        partners={PARTNERS}
        companies={COMPANIES}
        specialties={SPECIALTIES}
        tiers={TIERS}
        {...props}
      />
    )
  })
}

const input = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
const type = (el: Element, value: string) => act(async () => {
  const proto = el.tagName === 'TEXTAREA'
    ? (globalThis as any).window.HTMLTextAreaElement.prototype
    : (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const mousedown = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
})
const btn = (text: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)!
const tab = (label: string) => [...host.querySelectorAll('[role="tab"]')].find(t => t.textContent === label)!

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

describe('0a + 0c) title lands in the DB row; stage is always New Contact', () => {
  it('the persisted row (partnerPatchToRow) carries title + stage', async () => {
    const onAddPerson = vi.fn(async () => ({ id: 'new-1' }))
    await mount({ onAddPerson })
    await type(input('First name'), 'Karen')
    await type(input('Last name'), 'Martinez')
    await type(input('Title'), 'Real Estate Agent')
    await click(btn('Add person'))

    expect(onAddPerson).toHaveBeenCalledTimes(1)
    const emitted = onAddPerson.mock.calls[0][0]
    // THE 0a assertion: run the exact server mapping the POST runs —
    // the row that reaches supabase must carry the column.
    const row = partnerPatchToRow(emitted)
    expect(row.title).toBe('Real Estate Agent')
    expect(row.stage).toBe('New Contact')     // 0c — never 'Contact'
    expect(row.name).toBe('Karen Martinez')
    expect(row.type).toBe('partner')
  })
})

describe('0b) company link writes BOTH keys', () => {
  it('picking an existing company → company_id AND the display string in the DB row', async () => {
    const onAddPerson = vi.fn(async () => ({ id: 'new-1' }))
    await mount({ onAddPerson })
    await type(input('First name'), 'Karen')
    await type(input('Last name'), 'Martinez')
    await type(input('Company'), 'Meri')
    await mousedown([...host.querySelectorAll('button')].find(b => b.textContent!.includes('Meridian Realty'))!)
    expect(host.querySelector('[data-testid="company-chip"]')!.textContent).toContain('Meridian Realty')
    await click(btn('Add person'))

    const row = partnerPatchToRow(onAddPerson.mock.calls[0][0])
    expect(row.company_id).toBe('co1')
    expect(row.company).toBe('Meridian Realty')  // the display cache — was dropped
  })

  it('inline name-only company create → real id from the server, both keys ride', async () => {
    const onAddPerson = vi.fn(async () => ({ id: 'new-1' }))
    const onAddCompany = vi.fn(async (co: any) => ({ id: 'co-new-9', name: co.name }))
    await mount({ onAddPerson, onAddCompany })
    await type(input('First name'), 'Karen')
    await type(input('Last name'), 'Martinez')
    await type(input('Company'), 'Fresh Staging Co')
    await mousedown([...host.querySelectorAll('button')].find(b => b.textContent!.includes('Create “Fresh Staging Co”'))!)
    expect(onAddCompany).toHaveBeenCalledWith(expect.objectContaining({ name: 'Fresh Staging Co' }))
    await click(btn('Add person'))
    const row = partnerPatchToRow(onAddPerson.mock.calls[0][0])
    expect(row.company_id).toBe('co-new-9')
    expect(row.company).toBe('Fresh Staging Co')
  })
})

describe('§2) the toggle preserves shared values', () => {
  it('phone/email/website/address survive Person → Company → Person', async () => {
    await mount()
    await type(input('Phone'), '(816) 555-0916')
    await type(input('Email'), 'karen@meridian.com')
    await type(input('Website'), 'meridian.com')
    await click(host.querySelector('[aria-label="Add address"]')!)
    await type(input('City'), 'Kansas City')

    await click(tab('Company'))
    expect(input('Phone').value).toBe('(816) 555-0916')
    expect(input('Email').value).toBe('karen@meridian.com')
    expect(input('City').value).toBe('Kansas City')

    await click(tab('Person'))
    expect(input('Website').value).toBe('meridian.com')
    expect(input('City').value).toBe('Kansas City')
  })
})

describe('§4) every inventoried person field round-trips', () => {
  it('name/title/company/phone/email/website/address/how-met/relationship/specialties/tier all land', async () => {
    const onAddPerson = vi.fn(async () => ({ id: 'new-1' }))
    await mount({ onAddPerson })
    await type(input('First name'), 'Karen')
    await type(input('Last name'), 'Martinez')
    await type(input('Title'), 'Agent')
    await type(input('Phone'), '(816) 555-0916')
    await type(input('Email'), 'karen@meridian.com')
    await type(input('Website'), 'meridian.com')
    await type(input('How met'), 'Denver Expo')
    await click(host.querySelector('[aria-label="Add address"]')!)
    await type(host.querySelector('[placeholder="Start typing a street address..."]')!, '123 Main St')
    await type(input('Apt'), 'Suite 4')
    await type(input('City'), 'Kansas City')
    await type(input('State'), 'MO')
    await type(input('Zip'), '64111')
    await click(btn('Realtor'))
    await click(host.querySelector('[data-spec="real-estate"]')!)
    await click(host.querySelector('[data-tier="power-partner"]')!)
    await click(btn('Add person'))

    const row = partnerPatchToRow(onAddPerson.mock.calls[0][0])
    expect(row).toMatchObject({
      name: 'Karen Martinez', title: 'Agent',
      phone: '(816) 555-0916', email: 'karen@meridian.com', website: 'meridian.com',
      how_we_met: 'Denver Expo', relationship: 'Realtor',
      specialties: ['real-estate'], tier: 'power-partner',
      stage: 'New Contact', is_customer: false,
    })
    expect(row.addresses[0]).toMatchObject({
      value: '123 Main St Suite 4, Kansas City, MO, 64111',
      street: '123 Main St', apt: 'Suite 4', city: 'Kansas City', state: 'MO', zip: '64111',
    })
    expect(row.tags).toEqual([])
    expect(row.notes).toEqual([])
  })
})

describe('§5) defaultCompany preset', () => {
  it('applies the preset, opens on Person, and the emitted row carries both keys', async () => {
    const onAddPerson = vi.fn(async () => ({ id: 'new-1' }))
    await mount({ onAddPerson, defaultCompany: { id: 'co1', name: 'Meridian Realty' } })
    // Person position is active (its tab selected, person fields visible).
    expect(tab('Person').getAttribute('aria-selected')).toBe('true')
    expect(input('First name')).toBeTruthy()
    expect(host.querySelector('[data-testid="company-chip"]')!.textContent).toContain('Meridian Realty')
    await type(input('First name'), 'New')
    await type(input('Last name'), 'Hire')
    await click(btn('Add person'))
    const row = partnerPatchToRow(onAddPerson.mock.calls[0][0])
    expect(row.company_id).toBe('co1')
    expect(row.company).toBe('Meridian Realty')
  })
})

describe('company branch', () => {
  it('industry/notes/address land in the DB row; link-people writes BOTH keys per person', async () => {
    const onAddCompany = vi.fn(async (co: any) => ({ id: 'co-new-1', name: co.name }))
    const onUpdatePartner = vi.fn()
    await mount({ onAddCompany, onUpdatePartner })
    await click(tab('Company'))
    await type(input('Company name'), 'ABC Moving')
    await type(input('Industry'), 'Moving Services')
    await type(input('Phone'), '(303) 555-0000')
    await click(host.querySelector('[aria-label="Add address"]')!)
    await type(input('City'), 'Denver')
    await type(host.querySelector('[aria-label="Company notes"]')!, 'Great pipeline for move-ins')
    await click(host.querySelector('[data-link-person="p2"]')!)
    await click(btn('Add company'))

    expect(onAddCompany).toHaveBeenCalledTimes(1)
    const row = companyPatchToRow(onAddCompany.mock.calls[0][0])
    expect(row).toMatchObject({ name: 'ABC Moving', industry: 'Moving Services', phone: '(303) 555-0000' })
    expect(row.addresses[0].city).toBe('Denver')
    expect(row.notes[0].text).toBe('Great pipeline for move-ins')
    // Link-people: the FK AND the display cache, per linked person.
    expect(onUpdatePartner).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p2', companyId: 'co-new-1', company: 'ABC Moving',
    }))
  })

  it('validation posture: name gates the submit; person branch needs first+last', async () => {
    const onAddCompany = vi.fn()
    await mount({ onAddCompany })
    await click(tab('Company'))
    expect((btn('Add company') as HTMLButtonElement).disabled).toBe(true)
    await type(input('Company name'), 'X Co')
    expect((btn('Add company') as HTMLButtonElement).disabled).toBe(false)
    await click(tab('Person'))
    expect((btn('Add person') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed create surfaces the danger strip and stays open', async () => {
    const onAddPerson = vi.fn(async () => { throw new Error('forbidden') })
    await mount({ onAddPerson })
    await type(input('First name'), 'K')
    await type(input('Last name'), 'M')
    await click(btn('Add person'))
    expect(host.textContent).toContain('forbidden')
    expect(input('First name')).toBeTruthy() // sheet did not close
  })
})
