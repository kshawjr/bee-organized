// @vitest-environment happy-dom
//
// AddressAutofill must not call Google Places after it has gone.
//
// Typing starts a 175 ms wait before the suggestion lookup
// (/api/places/autocomplete). Nothing cancelled that wait when the box was
// removed — so typing an address and pressing Save inside 175 ms still sent a
// lookup afterwards: a wasted, billable Places request for a box nobody can
// see, and a state update on a component that no longer exists.
//
// In the test suite it showed up as the "flaky" address test: the first
// tests in lib/beta-address-model.test.tsx type "9 New Street" and save; the
// orphaned lookup fired later, under load, into a test that asserts nothing
// was sent. Found 2026-09-28 by capturing the stray call's URL (2 failures in
// 37 full runs, both this). These tests reproduce it deterministically with
// a fake clock, so it cannot come back quietly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AddressAutofill from '@/components/hive/shared/AddressAutofill'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let urls: string[] = []

beforeEach(() => {
  vi.useFakeTimers()
  urls = []
  global.fetch = vi.fn(async (url: any) => {
    urls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ predictions: [] }) } as any
  }) as any
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  vi.useRealTimers()
  host.remove()
})

function Harness() {
  const [v, setV] = React.useState('')
  return <AddressAutofill value={v} onChange={setV} />
}

const type = async (text: string) => {
  const input = host.querySelector('input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AddressAutofill — the suggestion lookup', () => {
  it('still happens normally: type, wait, one lookup', async () => {
    await act(async () => root.render(<Harness />))
    await type('9 New Street')
    expect(urls).toEqual([])
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(urls).toEqual(['/api/places/autocomplete'])
    await act(async () => root.unmount())
  })

  it('typed, then the box goes away inside the wait → NO lookup is ever sent', async () => {
    await act(async () => root.render(<Harness />))
    await type('9 New Street')
    await act(async () => root.unmount()) // e.g. Save closes the edit box
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(urls).toEqual([])
  })
})
