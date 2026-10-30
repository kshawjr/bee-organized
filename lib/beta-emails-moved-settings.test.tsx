// @vitest-environment happy-dom
//
// THE SETTINGS THAT MOVED ONTO SETTINGS → EMAILS (2026-10-30).
//
// The hourly rate, the in-home booking link (locations.calendar_link) and the
// Google Reviews link lived on Settings → Location; the designer's Emails
// screen puts them under "Your details", because they only exist to fill
// emails. They were pinned on Location by lib/rate-ui-settings.test.tsx,
// lib/rate-ui-viewas.test.tsx and lib/settings-location-persistence.test.tsx;
// those guarantees move HERE with the fields, unchanged in substance:
//
//   • real session        → PATCH /api/locations/<uuid> with ONLY its column,
//                           and the field reads the saved value
//   • view-as (non-UUID)  → refused in words, NO fetch, nothing saved
//   • server error        → the problem is shown, and the field never says Saved
//   • a saved value       → renders on mount, free-form text intact
//
// And the one-copy rule: Location no longer carries any of them.
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
const OK = async (url: any, opts: any) => {
  if (String(url) === `/api/locations/${LOC_UUID}` && opts?.method === 'PATCH') {
    const body = JSON.parse(opts.body)
    return { ok: true, status: 200, json: async () => ({ ok: true, location: body }) } as any
  }
  return { ok: true, status: 200, json: async () => ({}) } as any
}
const fetchMock = vi.fn(OK)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(OK)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('alert', vi.fn())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mount = async (loc: any, section = 'emails') => {
  await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection={section} />) })
  await act(async () => {})
}

// The design's Field: <label><span>{label}…</span><div><input/></div>…</label>
const fieldFor = (label: string) => {
  const l = Array.from(container.querySelectorAll('#details label')).find(x => (x.querySelector('span')?.firstChild?.textContent ?? '').trim() === label)
  expect(l, `the "${label}" field`).toBeTruthy()
  return l as HTMLElement
}
const inputFor = (label: string) => fieldFor(label).querySelector('input') as HTMLInputElement
const typeAndLeave = async (label: string, value: string) => {
  const el = inputFor(label)
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  await act(async () => {})
}
const patches = () => fetchMock.mock.calls.filter(([url, opts]: any[]) => String(url).startsWith('/api/locations/') && opts?.method === 'PATCH')

const FIELDS = [
  { label: 'Hourly rate', column: 'rate_per_hour', value: '$85/hr (3-hour minimum)' },
  { label: 'In-home assessment booking link', column: 'calendar_link', value: 'https://book.example.com/new' },
  { label: 'Google Reviews link', column: 'reviews_link', value: 'https://g.page/r/newreview' },
]

describe('Settings → Emails → Your details: the moved fields persist to their own column', () => {
  for (const f of FIELDS) {
    it(`"${f.label}" real session → PATCHes only { ${f.column} } and reads the saved value`, async () => {
      await mount(selectedLoc())
      fetchMock.mockClear()
      await typeAndLeave(f.label, f.value)
      expect(patches()).toHaveLength(1)
      expect(String(patches()[0][0])).toBe(`/api/locations/${LOC_UUID}`)
      expect(JSON.parse((patches()[0] as any)[1].body)).toEqual({ [f.column]: f.value })
      expect(inputFor(f.label).value).toBe(f.value)
      expect(fieldFor(f.label).textContent).toContain('Saved')
    })

    it(`"${f.label}" view-as (non-UUID locId) → refused in words, NO fetch`, async () => {
      await mount(selectedLoc({ id: 'loc_demo_slug' }))
      fetchMock.mockClear()
      await typeAndLeave(f.label, f.value)
      expect(patches()).toHaveLength(0)
      expect(fieldFor(f.label).textContent).toContain('open the real location')
      expect(fieldFor(f.label).textContent).not.toContain('Saved')
    })

    it(`"${f.label}" server error → the problem shows, never "Saved"`, async () => {
      await mount(selectedLoc())
      fetchMock.mockImplementation(async (url: any, opts: any) => {
        if (String(url).startsWith('/api/locations/') && opts?.method === 'PATCH') {
          return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as any
        }
        return { ok: true, json: async () => ({}) } as any
      })
      await typeAndLeave(f.label, f.value)
      expect(patches()).toHaveLength(1)
      expect(fieldFor(f.label).textContent).toContain('boom')
      expect(fieldFor(f.label).textContent).not.toContain('Saved')
    })
  }

  it('a saved rate renders on mount, free-form text intact', async () => {
    await mount(selectedLoc({ ratePerHour: '$85/hr (3-hour minimum)' }))
    expect(inputFor('Hourly rate').value).toBe('$85/hr (3-hour minimum)')
  })

  it('the Google Reviews link is still checked before it saves', async () => {
    await mount(selectedLoc())
    fetchMock.mockClear()
    await typeAndLeave('Google Reviews link', 'not a link')
    expect(patches()).toHaveLength(0)
    expect(fieldFor('Google Reviews link').textContent).toContain('valid URL')
  })
})

describe('one editable copy — Location keeps a pointer, not the fields', () => {
  it('Settings → Location no longer edits the rate, the booking link or the reviews link', async () => {
    await mount(selectedLoc(), 'location')
    const ps = Array.from(container.querySelectorAll('p')).map(p => (p.textContent || '').trim().replace(/\*$/, '').trim())
    for (const gone of ['Hourly Rate', 'Booking Link', 'Google Reviews', 'Website', 'Facebook']) {
      expect(ps, `"${gone}" row on Location`).not.toContain(gone)
    }
    expect(container.textContent).toContain('is now on')
    expect(container.textContent).toContain('Settings → Emails')
  })
})
