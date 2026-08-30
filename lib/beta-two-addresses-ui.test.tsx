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

describe('the question appears exactly when it matters', () => {
  it('linked client + real change → the question, with the approved wording, and NO fetch yet', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    await editStreetAndSave(host, '99 New Ave')
    const text = host.textContent || ''
    expect(text).toContain('Did they move?')
    expect(text).toContain('This client is connected to Jobber')
    expect(text).toContain('They moved')
    expect(text).toContain('Keeps the old address and its job history in Jobber. The new address starts fresh.')
    expect(text).toContain('Just fixing the address')
    expect(text).toContain('Corrects it everywhere, including Jobber. Nothing extra is kept.')
    expect(f).not.toHaveBeenCalled()
    await unmount()
  })

  it('"They moved" sends the save with address_change: move', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    await editStreetAndSave(host, '99 New Ave')
    await click(buttonByText(host, 'They moved')!)
    expect(f).toHaveBeenCalledTimes(1)
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.address_change).toBe('move')
    expect(body.address).toContain('99 New Ave')
    await unmount()
  })

  it('"Just fixing the address" sends a correction', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    await editStreetAndSave(host, '99 New Ave')
    await click(buttonByText(host, 'Just fixing the address')!)
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body.address_change).toBe('correction')
    await unmount()
  })

  it('an UNLINKED client is never asked — straight save, no flag', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: false })
    await editStreetAndSave(host, '99 New Ave')
    expect(host.textContent).not.toContain('Did they move?')
    expect(f).toHaveBeenCalledTimes(1)
    expect(JSON.parse(f.mock.calls[0][1].body).address_change).toBeUndefined()
    await unmount()
  })

  it('a formatting-only edit asks nothing and fetches nothing', async () => {
    const f = stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    await editStreetAndSave(host, '10 OLD RD') // same address, different case
    expect(host.textContent).not.toContain('Did they move?')
    expect(f).not.toHaveBeenCalled()
    await unmount()
  })
})

describe('the card with history, and without', () => {
  it('former addresses render as read-only history', async () => {
    stubFetch()
    const { host, unmount } = await mountField({
      formerAddresses: [{ display: '10 Old Rd, Fairway, KS, 66205', moved_at: '2026-08-30T00:00:00Z' }],
    })
    expect(host.textContent).toContain('Previously: 10 Old Rd, Fairway, KS, 66205')
    await unmount()
  })

  it('one address renders exactly as before — no history block, no question machinery visible', async () => {
    stubFetch()
    const { host, unmount } = await mountField({ jobberLinked: true })
    expect(host.textContent).not.toContain('Previously:')
    expect(host.textContent).not.toContain('Did they move?')
    await unmount()
  })
})
