// @vitest-environment happy-dom
//
// Settings → Pricing → Hourly Rate, VIEW-AS / preview session (#85).
//
// A view-as / preview session carries a non-UUID locId, so realLocId is null
// and there is no real location to write to. The bug (#85): persistRatePerHour
// painted local state and then `if (!realLocId) return` — the field read as
// saved while nothing persisted, and every rate-quoting drip stayed held with
// the owner none the wiser.
//
// These are MOUNT tests, not source pins. The load-bearing assertion is
// NO-SILENT-SUCCESS: saving from a view-as session must surface an error AND
// issue no write AND leave the field unchanged. A test that passed when the
// save quietly did nothing would be the bug, not the guard.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'
const LOC_SLUG = 'loc_seattle' // view-as / preview id — NOT a UUID

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
let alertMock: ReturnType<typeof vi.fn>

// Default: every request succeeds. Individual tests override for the
// real-save-error case. Mount-time reads (templates, masters, drip-paths)
// ride this same mock.
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
  alertMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', alertMock)
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
  await act(async () => {}) // flush mount-time fetches
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

// Type `value` into the Hourly Rate row and click Save.
const editAndSave = async (row: HTMLElement, value: string) => {
  await act(async () => {
    (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Edit') as HTMLElement).click()
  })
  const input = row.querySelector('input') as HTMLInputElement
  expect(input, 'rate input opens for editing').toBeTruthy()
  await act(async () => { setNativeValue(input, value) })
  await act(async () => {
    (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLElement).click()
  })
}

const ratePatchCalls = (id: string) =>
  fetchMock.mock.calls.filter(
    ([url, opts]: any[]) => String(url) === `/api/locations/${id}` && opts?.method === 'PATCH',
  )

describe('Settings — Hourly Rate, view-as / preview session (#85)', () => {
  it('saving from a non-UUID (view-as) session surfaces an error and writes NOTHING', async () => {
    await mount(selectedLoc({ id: LOC_SLUG }))
    const row = rateRow()
    // Precondition: the field is editable (this is exactly why it could lie).
    expect(row.textContent).toContain('Not set')

    await editAndSave(row, '$95')

    // 1. The user is told, plainly, that it did not save.
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock.mock.calls[0][0]).toContain('viewing this location')
    expect(alertMock.mock.calls[0][0]).toContain('open the real location')

    // 2. NO write was issued — not to the slug, not to anything.
    expect(ratePatchCalls(LOC_SLUG)).toHaveLength(0)
    expect(ratePatchCalls(LOC_UUID)).toHaveLength(0)
    const anyLocationWrite = fetchMock.mock.calls.filter(
      ([url, opts]: any[]) =>
        /\/api\/locations\//.test(String(url)) &&
        ['PATCH', 'POST', 'PUT', 'DELETE'].includes(opts?.method),
    )
    expect(anyLocationWrite, 'no location writes at all in a view-as session').toHaveLength(0)

    // 3. NO-SILENT-SUCCESS: the field must NOT read as saved. The shared
    //    "Not set" placeholder renders ONLY when the stored value is blank, so
    //    its presence proves the typed value was never committed to display. A
    //    version of the guard that painted the value and then no-op'd would
    //    have replaced "Not set" with the rate and failed here.
    const valueEl = Array.from(rateRow().querySelectorAll('p')).find(
      p => p.textContent?.trim() === 'Not set',
    )
    expect(valueEl, 'the value still reads "Not set" — nothing was painted').toBeTruthy()
  })

  it('saving from a real (UUID) session PATCHes as before — the guard does not over-reach', async () => {
    await mount(selectedLoc({ id: LOC_UUID }))
    const row = rateRow()

    await editAndSave(row, '$95')

    const patch = ratePatchCalls(LOC_UUID)
    expect(patch, 'PATCH /api/locations/<uuid> fires in a real session').toHaveLength(1)
    expect(JSON.parse((patch[0] as any)[1].body)).toEqual({ rate_per_hour: '$95' })
    // Real session: no view-as alert, and the display reflects the save.
    expect(alertMock).not.toHaveBeenCalled()
    expect(rateRow().textContent).toContain('$95')
  })

  it('a server error on a real save still surfaces the existing alert', async () => {
    // Fail only the rate PATCH; let mount-time reads succeed.
    fetchMock.mockImplementation(async (url: any, opts: any = {}) => {
      if (String(url) === `/api/locations/${LOC_UUID}` && opts?.method === 'PATCH') {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      }
      return { ok: true, json: async () => ({}) }
    })

    await mount(selectedLoc({ id: LOC_UUID }))
    const row = rateRow()

    await editAndSave(row, '$95')

    // The write was attempted (real session) and the failure was surfaced —
    // this is the pre-existing alert, distinct from the view-as message.
    expect(ratePatchCalls(LOC_UUID)).toHaveLength(1)
    expect(alertMock).toHaveBeenCalledTimes(1)
    expect(alertMock.mock.calls[0][0]).toContain('Could not save your hourly rate')
  })
})
