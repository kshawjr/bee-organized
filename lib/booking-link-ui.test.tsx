// @vitest-environment happy-dom
//
// Settings → Profile → Booking Link — MOUNT test of SettingsScreen.
//
// The user's OWN scheduling link, set by them and not by an admin. Unlike
// the other Profile rows (First/Last/Email/Phone, which are local-only in
// this screen), this one must PERSIST: it is what {{owner_booking_link}}
// renders into client emails, and a link saved only into session state would
// leave booking sends held forever (lib/booking-link). So this suite pins the
// actual PATCH /api/hub_users/me {booking_link} call, the optimistic display
// update, and the seed round-trip from CurrentUserContext.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const USER_ID = '9a8b7c6d-1111-4222-8333-444455556666'

const currentUser = (over: any = {}) => ({
  id: USER_ID,
  email: 'owner@bee.test',
  name: 'Sarah Chen',
  role: 'franchise',
  locationId: 'loc-uuid-1',
  first_name: 'Sarah',
  last_name: 'Chen',
  phone: '(206) 555-0100',
  booking_link: null,
  ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', vi.fn())
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

const mount = async (user: any) => {
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={user}>
        <SettingsScreen initialSection="profile" />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
}

const linkRow = () => {
  const label = Array.from(container.querySelectorAll('p')).find(
    p => p.textContent?.trim() === 'Booking Link',
  )
  expect(label, 'the Booking Link row').toBeTruthy()
  return label!.parentElement!.parentElement as HTMLElement
}

const setNativeValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const editSave = async (row: HTMLElement, value: string) => {
  await act(async () => {
    (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Edit') as HTMLElement).click()
  })
  const input = row.querySelector('input') as HTMLInputElement
  expect(input).toBeTruthy()
  await act(async () => { setNativeValue(input, value) })
  await act(async () => {
    (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLElement).click()
  })
}

const patchCall = () =>
  fetchMock.mock.calls.find(
    ([url, opts]: any[]) => String(url) === '/api/hub_users/me' && opts?.method === 'PATCH',
  )

describe('Settings → Profile — Booking Link field', () => {
  it('renders under a Scheduling section with consequence-forward helper text', async () => {
    await mount(currentUser())
    expect(container.textContent).toContain('Scheduling')
    const row = linkRow()
    // The helper must make the consequence obvious: this goes to clients.
    expect(row.textContent).toContain('CLIENT emails')
    // ...and that leaving it blank is a fallback, not a break.
    expect(row.textContent).toContain('location Booking Link')
    expect(row.textContent).toContain('held')
    // Unset → the shared "Not set" placeholder.
    expect(row.textContent).toContain('Not set')
  })

  it('saving PATCHes hub_users.booking_link and updates the display (round-trip)', async () => {
    await mount(currentUser())
    await editSave(linkRow(), 'https://calendly.com/sarah-chen')

    const call = patchCall()
    expect(call, 'PATCH /api/hub_users/me').toBeTruthy()
    expect(JSON.parse((call as any)[1].body)).toEqual({
      booking_link: 'https://calendly.com/sarah-chen',
    })

    // Display reflects the save immediately.
    expect(linkRow().textContent).toContain('https://calendly.com/sarah-chen')
  })

  it('a user with a saved link renders it on mount (seed round-trip from context)', async () => {
    await mount(currentUser({ booking_link: 'https://cal.com/sarah' }))
    expect(linkRow().textContent).toContain('https://cal.com/sarah')
  })

  it('clearing the field PATCHes an empty string — the API stores null, which means "fall back"', async () => {
    await mount(currentUser({ booking_link: 'https://cal.com/sarah' }))
    await editSave(linkRow(), '')

    const call = patchCall()
    expect(call).toBeTruthy()
    expect(JSON.parse((call as any)[1].body)).toEqual({ booking_link: '' })
  })

  it('a manager reaches this field — it is a self-edit, not owner-only config', async () => {
    await act(async () => {
      root.render(
        <CurrentUserContext.Provider value={currentUser()}>
          <SettingsScreen initialSection="profile" franchiseRole="manager" />
        </CurrentUserContext.Provider>,
      )
    })
    await act(async () => {})
    expect(linkRow().textContent).toContain('Not set')
    // ...while owner-only config stays out of their Settings entirely.
    expect(container.textContent).not.toContain('My Location')
  })
})
