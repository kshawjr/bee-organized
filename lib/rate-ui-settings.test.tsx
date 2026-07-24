// @vitest-environment happy-dom
//
// Settings → Pricing → Hourly Rate — MOUNT test of SettingsScreen.
//
// The row writes locations.rate_per_hour and, UNLIKE the legacy
// local-only SettingsEditRows (Phone, Booking Link…), it must PERSIST:
// a blank rate actively HOLDS every rate-quoting drip send
// (lib/rate-guard.ts), so this suite pins the actual PATCH
// /api/locations/<uuid> {rate_per_hour} call, the optimistic display
// update, and the seed round-trip (a saved rate renders on mount).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'

const selectedLoc = (over: any = {}) => ({
  id: LOC_UUID,
  name: 'Seattle',
  address: '1 Pike Pl',
  phone: '(206) 555-0100',
  bookingLink: '',
  reviewsLink: 'https://g.page/r/seattle',
  ratePerHour: '',
  serviceRadius: '25 miles',
  timezone: 'America/Los_Angeles',
  assessmentType: 'in-person',
  smsEnabled: false,
  jobberConnected: false,
  jobberAccountId: null,
  crmStatus: 'active',
  sendFromName: 'Bee Organized Seattle',
  sendFromEmail: 'seattle@x.com',
  replyToEmail: 'seattle@x.com',
  ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({}),
}))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mount = async (loc: any) => {
  await act(async () => {
    root.render(<SettingsScreen selectedLoc={loc} initialSection="location" />)
  })
  await act(async () => {})   // flush mount-time fetches
}

const rateRow = () => {
  const label = Array.from(container.querySelectorAll('p')).find(
    p => p.textContent?.trim() === 'Hourly Rate',
  )
  expect(label, 'the Hourly Rate row').toBeTruthy()
  return label!.parentElement!.parentElement as HTMLElement
}

const setNativeValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Settings — Hourly Rate field', () => {
  it('renders under Pricing with consequence-forward helper text', async () => {
    await mount(selectedLoc())
    expect(container.textContent).toContain('Pricing')
    const row = rateRow()
    // The helper spells out that the value lands verbatim in client emails
    // and that leaving it blank holds rate-quoting sends.
    expect(row.textContent).toContain('word-for-word in client emails')
    expect(row.textContent).toContain('held')
    // Blank → the shared "Not set" placeholder.
    expect(row.textContent).toContain('Not set')
  })

  it('saving PATCHes locations.rate_per_hour and updates the display (round-trip)', async () => {
    await mount(selectedLoc())
    const row = rateRow()

    await act(async () => {
      (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Edit') as HTMLElement).click()
    })
    const input = row.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => { setNativeValue(input, '$95') })
    await act(async () => {
      (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLElement).click()
    })

    const patchCall = fetchMock.mock.calls.find(
      ([url, opts]: any[]) => String(url) === `/api/locations/${LOC_UUID}` && opts?.method === 'PATCH',
    )
    expect(patchCall, 'PATCH /api/locations/<uuid>').toBeTruthy()
    expect(JSON.parse((patchCall as any)[1].body)).toEqual({ rate_per_hour: '$95' })

    // Display reflects the save immediately.
    expect(rateRow().textContent).toContain('$95')
  })

  it('a location with a saved rate renders it on mount (seed round-trip, free-form text intact)', async () => {
    await mount(selectedLoc({ ratePerHour: '$85/hr (3-hour minimum)' }))
    expect(rateRow().textContent).toContain('$85/hr (3-hour minimum)')
  })
})
