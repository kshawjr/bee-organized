// @vitest-environment happy-dom
//
// MOVE OR CORRECTION — the owner-facing question, and when it appears.
//
// The two cannot be told apart mechanically (a move across the street diffs
// like a typo), so the card asks — but ONLY when it matters: a Jobber-linked
// client, a real previous address, a real new one. First addresses,
// unlinked clients, and formatting-only edits never see it. The wording is
// pinned because it is owner-facing copy Kevin approved.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The autofill widget talks to Google; a plain input keeps the test about
// the question, not the autocomplete.
vi.mock('@/components/hive/shared/AddressAutofill', () => ({
  default: ({ value, onChange, onKeyDown, placeholder }: any) => (
    <input aria-label="Street" value={value} placeholder={placeholder}
      onChange={(e: any) => onChange(e.target.value)} onKeyDown={onKeyDown} />
  ),
}))

import AddressField from '@/components/hive/shared/AddressField'

const VALUE = { address: '10 Old Rd, Fairway, KS, 66205', city: 'Fairway', state: 'KS', zip: '66205' }

function stubFetch() {
  const f = vi.fn(async () => ({
    ok: true,
    json: async () => ({ lead: {}, address_move: { created: true, propertyId: '999', billing: 'updated', kept: true } }),
  })) as any
  ;(globalThis as any).fetch = f
  return f
}

async function mountField(props: any = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AddressField leadId="lead-1" value={VALUE} setToast={() => {}} {...props} />)
  })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const input = (host: HTMLElement, label: string) =>
  host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement

const setValue = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const pressEnter = async (el: Element) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
const buttonByText = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

// Open the editor (click the display row), change the street, press Enter.
async function editStreetAndSave(host: HTMLElement, street: string) {
  await click(host.querySelector('[data-meta-row="address"]')!)
  const s = input(host, 'Street')
  await setValue(s, street)
  await pressEnter(s)
}

afterEach(() => { vi.restoreAllMocks() })

// THE QUESTION IS GONE. "Did they move?" fired ~75 times in eight weeks and
// produced zero moves — every owner picked "just fixing the address". Three
// intents now have three controls: the pencil corrects, "+ Add address" adds,
// "Stop using" retires. What is pinned here is that the pencil is now
// unconditional and silent about intent, on both linked and unlinked clients.
describe('the pencil saves straight through — no question, ever', () => {
  it('linked client + real change → ONE save, no question, no interstitial', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    await editStreetAndSave(host, '99 New Ave')
    const text = host.textContent || ''
    expect(text).not.toContain('Did they move?')
    expect(text).not.toContain('They moved')
    expect(text).not.toContain('Just fixing the address')
    expect(f).toHaveBeenCalledTimes(1)
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.address).toContain('99 New Ave')
    // no intent flag is sent at all — the default IS the correction
    expect(body.address_change).toBeUndefined()
    await unmount()
  })

  it('an UNLINKED client saves the same way — one call, no flag', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: false })
    await editStreetAndSave(host, '99 New Ave')
    expect(host.textContent).not.toContain('Did they move?')
    expect(f).toHaveBeenCalledTimes(1)
    expect(JSON.parse(f.mock.calls[0][1].body).address_change).toBeUndefined()
    await unmount()
  })

  it('a formatting-only edit still fetches nothing', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    await editStreetAndSave(host, '10 OLD RD') // same address, different case
    expect(f).not.toHaveBeenCalled()
    await unmount()
  })
})

describe('the card with history, and without', () => {
  it('the second address renders read-only, as "Other address" — not as history', async () => {
    stubFetch()
    const { host, unmount } = await mountField({
      formerAddresses: [{ display: '10 Old Rd, Fairway, KS, 66205', moved_at: '2026-08-30T00:00:00Z' }],
    })
    // Wording deliberately changed with the address picker: a client who
    // moved can still have live work at the old house (Jobber keeps both
    // properties bookable), so 'Previously' — and its 'moved' date — read
    // as history the record cannot actually vouch for.
    // The per-row "Other address:" prefix became one quiet heading over the
    // list, because each row now carries its own label pill. An UNLABELLED
    // entry like this one still reads correctly under the heading.
    expect(host.textContent).toContain('Other addresses')
    expect(host.textContent).toContain('10 Old Rd, Fairway, KS, 66205')
    expect(host.textContent).not.toContain('Previously:')
    expect(host.textContent).not.toContain('moved Aug')
    await unmount()
  })

  it('one address renders exactly as before — no history block, no question machinery visible', async () => {
    stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    expect(host.textContent).not.toContain('Other addresses')
    expect(host.textContent).not.toContain('Did they move?')
    await unmount()
  })
})
