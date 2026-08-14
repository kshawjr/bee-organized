// @vitest-environment happy-dom
//
// lib/beta-location-panel-tabs-226.test.tsx — issue 226 step 4.
//
// The panel re-layout. Two claims are worth pinning, because both are things
// a reviewer reading a 400-line JSX diff would struggle to verify by eye:
//
//   1. WHERE each control ended up. Payment source and paid-through decide
//      whether someone is billed and when, so they are in Careful, not in
//      Settings next to the internal memo.
//   2. That splitting the form split the SAVE. One Save button used to write
//      payment_source, paid_through_date and billing_notes together, so
//      editing a note rewrote the billing model as a side effect. Each half
//      now sends only its own fields.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { LocationDetailSheet } from '@/components/BeeHub'

const LOC = {
  id: 'loc-kc-uuid', locationId: 'loc_kc', name: 'Kansas City', state: 'MO',
  owner: 'Lynette Ewy', crmStatus: 'active', lifecycle_status: 'active',
  subscription_status: 'active', payment_source: 'prepaid_corporate',
  paid_through_date: '2027-05-01', billing_notes: 'existing note',
  revenue: 0, collected: 0, leads: 0, address: '', phone: '',
  corporate_sponsorship_started_at: '2026-01-01', corporate_sponsorship_ends_at: '2027-05-01',
  seatCount: 1, seatLines: [{ tier: 'owner', count: 1 }],
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let patches: any[]

beforeEach(() => {
  patches = []
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ location: { ...LOC } }) }
    }
    if (String(url).includes('owner-status')) {
      return { ok: true, json: async () => ({ owners: [], pending_invite: null, count: 0 }) }
    }
    return { ok: true, json: async () => [] }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function open(props: any = {}) {
  await act(async () => {
    root.render(<LocationDetailSheet loc={LOC} role="super_admin" onClose={() => {}} {...props} />)
  })
}

const buttonByText = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)

const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

const gotoSettings = async () => click(buttonByText('Settings')!)

describe('two tabs, not three', () => {
  it('offers Billing & team and Settings, and nothing called Activity', async () => {
    await open()
    expect(buttonByText('Billing & team')).toBeTruthy()
    expect(buttonByText('Settings')).toBeTruthy()
    expect(container.textContent).not.toContain('Activity')
  })

  it('opens on Billing & team', async () => {
    await open()
    expect(container.textContent).toContain('Subscription')
    expect(container.textContent).toContain('Careful')
  })
})

describe('what lives where', () => {
  it('puts payment source and paid-through in Careful', async () => {
    await open()
    const careful = container.textContent!.slice(container.textContent!.indexOf('Careful'))
    expect(careful).toContain('Payment source')
    expect(careful).toContain('Paid through')
    expect(careful).toContain('These decide whether this location is billed, and when.')
    expect(container.querySelector('select')).toBeTruthy()
  })

  it('keeps payment source OUT of Settings', async () => {
    await open()
    await gotoSettings()
    expect(container.querySelector('select')).toBeNull()
    expect(container.textContent).not.toContain('These decide whether this location is billed')
  })

  it('puts billing notes and the sponsorship dates in Settings', async () => {
    await open()
    expect(container.querySelector('textarea')).toBeNull()
    await gotoSettings()
    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.textContent).toContain('Billing notes')
    expect(container.textContent).toContain('Sponsorship Period')
  })

  it('puts view-as-owner in Settings', async () => {
    const onViewLocation = vi.fn()
    await open({ onViewLocation })
    expect(container.textContent).not.toContain('View as Owner')
    await gotoSettings()
    expect(container.textContent).toContain('View as Owner')
  })

  it('shows who pays and paid-through as READ-ONLY facts on Billing & team', async () => {
    await open()
    expect(container.textContent).toContain('Who pays')
    expect(container.textContent).toContain('Corporate (prepaid)')
  })
})

describe('the mock Team block is gone', () => {
  it('renders no "Team · $X/yr" list', async () => {
    await open()
    expect(container.textContent).not.toMatch(/Team · \$/)
    await gotoSettings()
    expect(container.textContent).not.toMatch(/Team · \$/)
  })
})

// The behaviour half of the split. One Save wrote all three fields, so a
// note edit rewrote payment_source. The route builds its update object
// field-by-field, so a partial body is what it was built for.
describe('each half saves only its own fields', () => {
  async function typeInto(el: Element, value: string) {
    await act(async () => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('saving a note sends billing_notes and NOTHING else', async () => {
    await open()
    await gotoSettings()
    await typeInto(container.querySelector('textarea')!, 'a new note')
    await click(buttonByText('Save notes')!)

    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0].body)).toEqual(['billing_notes'])
    expect(patches[0].body.billing_notes).toBe('a new note')
    // The regression this prevents: payment_source riding along on a note save.
    expect(patches[0].body).not.toHaveProperty('payment_source')
    expect(patches[0].body).not.toHaveProperty('paid_through_date')
  })

  it('saving the billing model sends the model and NOT the note', async () => {
    await open()
    await act(async () => {
      const select = container.querySelector('select') as HTMLSelectElement
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, 'direct')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(buttonByText('Save changes')!)
    // issue 226 step 7 — Save opens the Careful confirmation; the write
    // happens only after it names the fields and is accepted.
    expect(patches).toHaveLength(0)
    expect(container.textContent).toContain('payment_source')
    await click(buttonByText('Write these changes')!)

    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0].body).sort()).toEqual(['paid_through_date', 'payment_source'])
    expect(patches[0].body.payment_source).toBe('direct')
    expect(patches[0].body).not.toHaveProperty('billing_notes')
  })

  // PRESERVED, not fixed: paid_through_date is force-nulled for every source
  // except prepaid_corporate, so switching to "None" erases the renewal date.
  // Step 4 is a re-layout; the confirmation that names this out loud comes
  // with the Careful section's guards.
  it('still nulls paid_through_date for a non-prepaid source', async () => {
    await open()
    await act(async () => {
      const select = container.querySelector('select') as HTMLSelectElement
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, 'none')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(buttonByText('Save changes')!)
    await click(buttonByText('Write these changes')!)
    expect(patches[0].body.paid_through_date).toBeNull()
  })

  it('each Save is disabled until its own half is dirty', async () => {
    await open()
    expect((buttonByText('Save changes') as HTMLButtonElement).disabled).toBe(true)
    await gotoSettings()
    expect((buttonByText('Save notes') as HTMLButtonElement).disabled).toBe(true)
  })
})

// ── issue 226 step 7 / issue 228 — the confirmation names the fields ───────
describe('the Careful confirmation', () => {
  const selectSource = async (value: string) => {
    await act(async () => {
      const select = container.querySelector('select') as HTMLSelectElement
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('names the field, the value now and the value after — not "are you sure"', async () => {
    await open()
    await selectSource('direct')
    await click(buttonByText('Save changes')!)

    expect(container.textContent).toContain('payment_source')
    expect(container.textContent).toContain('Corporate (prepaid)')
    expect(container.textContent).toContain('Franchisee (direct)')
    expect(container.textContent).not.toMatch(/are you sure/i)
  })

  // issue 228. The fixture is prepaid_corporate with paid_through 2027-05-01;
  // switching to anything else force-nulls it.
  it('says out loud that the renewal date will be erased, and names it', async () => {
    await open()
    await selectSource('none')
    await click(buttonByText('Save changes')!)

    expect(container.textContent).toContain('paid_through_date')
    expect(container.textContent).toContain('2027-05-01')
    expect(container.textContent).toContain('(nothing)')
    expect(container.textContent).toContain('Erased')
    expect(container.textContent).toContain('nothing will anchor its next renewal')
  })

  it('warns when the new source stops seat changes reaching Stripe', async () => {
    await open()
    await selectSource('corporate_sponsored')
    await click(buttonByText('Save changes')!)
    expect(container.textContent).toContain('stop sending seat changes to Stripe')
  })

  it('writes nothing if it is cancelled', async () => {
    await open()
    await selectSource('none')
    await click(buttonByText('Save changes')!)
    await click(buttonByText('Cancel')!)
    expect(patches).toHaveLength(0)
  })
})
