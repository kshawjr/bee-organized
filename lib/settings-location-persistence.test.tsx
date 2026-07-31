// @vitest-environment happy-dom
//
// Settings → Location + Online Presence + Communication — persistence of the
// rows that USED to be pure setSettings and vanished on reload (#93).
//
// Every migrated row now writes its own locations column through the honest
// PATCH /api/locations/<uuid> route (the same one the rate uses: 500 on DB
// error, ok:true only on a landed write). This suite pins, per field:
//   • real session (UUID locId) → PATCH fires with the RIGHT column
//   • view-as (non-UUID locId)  → alert, NO fetch, field does NOT paint
//   • server error              → alert, field does NOT show the saved value
// It asserts NO silent success explicitly: a row that only updated React
// state (the original bug) shows the value with no PATCH — which every case
// below forbids.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'

// A super_admin-picked location (selectedLoc). id is a real UUID → locId is a
// UUID → realLocId is set → writes are live. For the view-as cases we override
// id with a non-UUID slug so realLocId is null.
const selectedLoc = (over: any = {}) => ({
  id: LOC_UUID,
  name: 'Seattle',
  street: '1 Pike Pl',
  city: 'Seattle',
  state: 'WA',
  zip: '98101',
  phone: '(206) 555-0100',
  bookingLink: 'https://book.example.com/seattle',
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

const OK = async () => ({ ok: true, json: async () => ({}) })
const okFetch = vi.fn(OK)

beforeEach(() => {
  vi.stubGlobal('fetch', okFetch)
  alertMock = vi.fn()
  vi.stubGlobal('alert', alertMock)
  // mockReset (not just mockClear) so a prior server-error test's
  // mockImplementation can't leak its failure into the next test.
  okFetch.mockReset()
  okFetch.mockImplementation(OK)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mount = async (loc: any, section = 'location') => {
  await act(async () => {
    root.render(<SettingsScreen selectedLoc={loc} initialSection={section} />)
  })
  await act(async () => {})   // flush mount-time fetches
}

// Row container = the flex wrapper that holds this label's input AND its
// Edit/Save buttons. The label <p> is `{label}{required && <span>*</span>}`,
// so strip a trailing asterisk before matching.
const rowFor = (label: string) => {
  const p = Array.from(container.querySelectorAll('p')).find(
    el => (el.textContent || '').trim().replace(/\*$/, '').trim() === label,
  )
  expect(p, `the "${label}" row`).toBeTruthy()
  return p!.parentElement!.parentElement as HTMLElement
}

const setNativeValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// Open the row, type `value`, click Save, and flush the awaited PATCH + paint.
const editAndSave = async (label: string, value: string) => {
  const row = rowFor(label)
  await act(async () => {
    (Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Edit') as HTMLElement).click()
  })
  const input = rowFor(label).querySelector('input') as HTMLInputElement
  expect(input, `input for "${label}"`).toBeTruthy()
  await act(async () => { setNativeValue(input, value) })
  await act(async () => {
    (Array.from(rowFor(label).querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLElement).click()
  })
  await act(async () => {})   // paint-on-success happens AFTER the fetch resolves
}

const patchTo = (uuidOrSlug: string) =>
  okFetch.mock.calls.find(
    ([url, opts]: any[]) => String(url) === `/api/locations/${uuidOrSlug}` && opts?.method === 'PATCH',
  )

const anyLocationPatch = () =>
  okFetch.mock.calls.find(
    ([url, opts]: any[]) => String(url).startsWith('/api/locations/') && opts?.method === 'PATCH',
  )

// Every migrated Location + Online-Presence row: display label → DB column, and
// a distinctive value to type. Reviews must be a valid URL (row validates it).
const FIELDS: Array<{ label: string; column: string; value: string }> = [
  { label: 'Location Name', column: 'name',          value: 'Emerald City Organizers' },
  { label: 'Street Address', column: 'address',      value: '42 Rainier Ave' },
  { label: 'City',           column: 'city',         value: 'Bellevue' },
  { label: 'State',          column: 'state',        value: 'OR' },
  { label: 'ZIP',            column: 'zip',          value: '98004' },
  { label: 'Phone',          column: 'phone',        value: '(425) 555-0199' },
  { label: 'Timezone',       column: 'timezone',     value: 'America/Denver' },
  { label: 'Booking Link',   column: 'calendar_link', value: 'https://book.example.com/new' },
  { label: 'Google Reviews', column: 'reviews_link', value: 'https://g.page/r/newreview' },
]

describe('Settings — Location fields persist to their own column (#93)', () => {
  for (const f of FIELDS) {
    it(`"${f.label}" real session → PATCHes { ${f.column} } and paints only after the write lands`, async () => {
      await mount(selectedLoc())
      okFetch.mockClear()

      await editAndSave(f.label, f.value)

      const call = patchTo(LOC_UUID)
      expect(call, `PATCH /api/locations/${LOC_UUID} for ${f.label}`).toBeTruthy()
      expect(JSON.parse((call as any)[1].body)).toEqual({ [f.column]: f.value })
      // Landed → the row now shows the saved value (round-trip proof, not a
      // React-only echo: the PATCH above is what makes this legitimate).
      expect(rowFor(f.label).textContent).toContain(f.value)
    })

    it(`"${f.label}" view-as (non-UUID locId) → alert, NO fetch, does NOT paint`, async () => {
      await mount(selectedLoc({ id: 'loc_demo_slug' }))
      okFetch.mockClear()
      alertMock.mockClear()

      await editAndSave(f.label, f.value)

      expect(alertMock, `alert for ${f.label}`).toHaveBeenCalledTimes(1)
      expect(anyLocationPatch(), `no PATCH for ${f.label}`).toBeUndefined()
      // The value the user typed must NOT survive on screen — the guard fired
      // before any local paint, so the row shows its seeded value.
      expect(rowFor(f.label).textContent).not.toContain(f.value)
    })

    it(`"${f.label}" server error → alert, does NOT show the saved value`, async () => {
      await mount(selectedLoc())
      // Make only the PATCH fail; mount-time GETs stay ok.
      okFetch.mockImplementation(async (url: any, opts: any) => {
        if (String(url).startsWith('/api/locations/') && opts?.method === 'PATCH') {
          return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as any
        }
        return { ok: true, json: async () => ({}) } as any
      })
      alertMock.mockClear()

      await editAndSave(f.label, f.value)

      expect(patchTo(LOC_UUID), `PATCH attempted for ${f.label}`).toBeTruthy()
      expect(alertMock, `error alert for ${f.label}`).toHaveBeenCalledTimes(1)
      // Write failed → the field must NOT read as saved.
      expect(rowFor(f.label).textContent).not.toContain(f.value)
    })
  }
})

describe('Settings — Assessment Default is disabled, not silently-lost (#93)', () => {
  it('renders an explanation and NO interactive option buttons', async () => {
    await mount(selectedLoc())
    expect(container.textContent).toContain('Assessment Default')
    // The old bug: clickable buttons that wrote session-only state. They must
    // no longer be buttons, and the row must say saving isn't available yet.
    expect(container.textContent).toContain('isn’t available yet')
    const inPerson = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent?.includes('In-Person'),
    )
    expect(inPerson, 'In-Person must not be a clickable button').toBeUndefined()
  })
})

// ── Source-level guards ────────────────────────────────────────────────────
// The behavioral matrix above proves persistLocationField end-to-end. The
// Communication-tab sender rows use the SAME helper; these string assertions
// pin their wiring (and the route allowlist) without mounting the comms tab.
describe('Settings — no row is left on the local-only path (#93 source guards)', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')
  const route = readFileSync('app/api/locations/[id]/route.ts', 'utf8')

  it('no Settings row still saves via onSave/onUpdate/onDelete → updateLocation', () => {
    expect(src).not.toContain('onSave={v=>updateLocation(')
    expect(src).not.toContain('onUpdate={v=>updateLocation(')
    expect(src).not.toContain('onDelete={()=>updateLocation(')
  })

  it('sender rows persist to sender_name / send_from_email / reply_to_email', () => {
    expect(src).toContain("persistLocationField('sendFromName','sender_name'")
    expect(src).toContain("persistLocationField('sendFromEmail','send_from_email'")
    expect(src).toContain("persistLocationField('replyToEmail','reply_to_email'")
  })

  it('the PATCH route allowlists name (the added column) alongside address parts', () => {
    for (const col of ['name', 'address', 'city', 'state', 'zip']) {
      expect(route).toContain(`'${col}'`)
    }
  })
})
