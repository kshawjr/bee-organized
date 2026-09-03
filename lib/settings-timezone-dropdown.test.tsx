// @vitest-environment happy-dom
//
// Settings → Location › Timezone is a DROPDOWN, not a text box.
//
// Background (2026-09-01, Scottsdale): the onboarding step offered a
// dropdown, but the post-onboarding Settings row was free text. Someone typed
// "Phoenix AZ". lib/drip-time's requireIanaTimezone rejects that, and Send to
// Jobber runs the check AFTER the Jobber client + request exist — so every
// assessment send failed with a 400 and each retry left another Jobber client
// behind. This suite pins:
//   • the row edits through a <select> fed by lib/us-timezones.ts
//   • an invalid stored value is SHOWN and FLAGGED, never blanked or swapped
//   • Save stays off until a listed value is picked, then PATCHes the label
//   • an IANA alias ('America/New_York', the DB default) displays as its label
//   • every timezone control and both write routes use the one list
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'
import { US_TIMEZONES, normalizeTimezoneLabel, isValidTimezoneValue } from '@/lib/us-timezones'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'

const selectedLoc = (over: any = {}) => ({
  id: LOC_UUID,
  name: 'Scottsdale',
  street: '1 Main St',
  city: 'Scottsdale',
  state: 'AZ',
  zip: '85251',
  phone: '(480) 555-0100',
  bookingLink: 'https://book.example.com/scottsdale',
  reviewsLink: 'https://g.page/r/scottsdale',
  ratePerHour: '',
  serviceRadius: '25 miles',
  timezone: 'Mountain Time (MT)',
  assessmentType: 'in-person',
  smsEnabled: false,
  jobberConnected: false,
  jobberAccountId: null,
  crmStatus: 'active',
  sendFromName: 'Bee Organized Scottsdale',
  sendFromEmail: 'scottsdale@x.com',
  replyToEmail: 'scottsdale@x.com',
  ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
const OK = async () => ({ ok: true, json: async () => ({}) })
const okFetch = vi.fn(OK)

beforeEach(() => {
  vi.stubGlobal('fetch', okFetch)
  vi.stubGlobal('alert', vi.fn())
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

const mount = async (loc: any) => {
  await act(async () => {
    root.render(<SettingsScreen selectedLoc={loc} initialSection="location" />)
  })
  await act(async () => {})
}

const rowFor = (label: string) => {
  const p = Array.from(container.querySelectorAll('p')).find(
    el => (el.textContent || '').trim().replace(/\*$/, '').trim() === label,
  )
  expect(p, `the "${label}" row`).toBeTruthy()
  return p!.parentElement!.parentElement as HTMLElement
}

const clickButton = async (row: HTMLElement, text: string) => {
  await act(async () => {
    (Array.from(row.querySelectorAll('button')).find(b => b.textContent === text) as HTMLElement).click()
  })
}

const pick = async (select: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const saveButton = (row: HTMLElement) =>
  Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLButtonElement

describe('Settings › Timezone is a dropdown fed by the one shared list', () => {
  it('editing opens a <select> with exactly the shared options, and no text input', async () => {
    await mount(selectedLoc())
    await clickButton(rowFor('Timezone'), 'Edit')
    const row = rowFor('Timezone')
    expect(row.querySelector('input'), 'no free-text input').toBeNull()
    const select = row.querySelector('select') as HTMLSelectElement
    expect(select).toBeTruthy()
    const values = Array.from(select.options).filter(o => !o.disabled).map(o => o.value)
    expect(values).toEqual(US_TIMEZONES.map(tz => tz.value))
  })

  it('a valid stored label displays as its full option label with no warning', async () => {
    await mount(selectedLoc({ timezone: 'Mountain Time (MT)' }))
    const row = rowFor('Timezone')
    expect(row.textContent).toContain('Mountain Time (MT) — Denver, Salt Lake City')
    expect(row.textContent).not.toContain('Not a valid timezone')
  })

  it("an IANA alias ('America/New_York', the DB default) displays as Eastern, not flagged", async () => {
    await mount(selectedLoc({ timezone: 'America/New_York' }))
    const row = rowFor('Timezone')
    expect(row.textContent).toContain('Eastern Time (ET) — New York, Miami')
    expect(row.textContent).not.toContain('Not a valid timezone')
  })
})

describe('Settings › Timezone with an invalid stored value ("Phoenix AZ")', () => {
  it('shows the stored value as-is AND flags it — never blanks it', async () => {
    await mount(selectedLoc({ timezone: 'Phoenix AZ' }))
    const row = rowFor('Timezone')
    expect(row.textContent).toContain('Phoenix AZ')
    expect(row.textContent).toContain('Not a valid timezone')
    expect(row.textContent).not.toContain('Not set')
  })

  it('on Edit the select shows the invalid value as the current (disabled) entry and Save is off', async () => {
    await mount(selectedLoc({ timezone: 'Phoenix AZ' }))
    await clickButton(rowFor('Timezone'), 'Edit')
    const row = rowFor('Timezone')
    const select = row.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('Phoenix AZ')
    const current = Array.from(select.options).find(o => o.value === 'Phoenix AZ')!
    expect(current.disabled).toBe(true)
    expect(current.textContent).toContain('not valid')
    expect(saveButton(row).disabled).toBe(true)
    expect(row.textContent).toContain('Not a valid timezone')
  })

  it('picking a listed value enables Save and PATCHes the label', async () => {
    await mount(selectedLoc({ timezone: 'Phoenix AZ' }))
    await clickButton(rowFor('Timezone'), 'Edit')
    okFetch.mockClear()
    const select = rowFor('Timezone').querySelector('select') as HTMLSelectElement
    await pick(select, 'Mountain Time (MT)')
    expect(saveButton(rowFor('Timezone')).disabled).toBe(false)
    await clickButton(rowFor('Timezone'), 'Save')
    await act(async () => {})
    const call = okFetch.mock.calls.find(
      ([url, opts]: any[]) => String(url) === `/api/locations/${LOC_UUID}` && opts?.method === 'PATCH',
    )
    expect(call, 'PATCH fired').toBeTruthy()
    expect(JSON.parse((call as any)[1].body)).toEqual({ timezone: 'Mountain Time (MT)' })
    expect(rowFor('Timezone').textContent).toContain('Mountain Time (MT) — Denver, Salt Lake City')
    expect(rowFor('Timezone').textContent).not.toContain('Not a valid timezone')
  })

  it('a blank timezone reads "Not set" and is flagged too', async () => {
    await mount(selectedLoc({ timezone: '' }))
    const row = rowFor('Timezone')
    expect(row.textContent).toContain('Not set')
    expect(row.textContent).toContain('Not a valid timezone')
  })
})

describe('lib/us-timezones — the one list', () => {
  it('accepts labels and their IANA aliases, rejects everything else', () => {
    expect(normalizeTimezoneLabel('Mountain Time (MT)')).toBe('Mountain Time (MT)')
    expect(normalizeTimezoneLabel('america/denver')).toBe('Mountain Time (MT)')
    expect(normalizeTimezoneLabel('America/New_York')).toBe('Eastern Time (ET)')
    expect(normalizeTimezoneLabel('Phoenix AZ')).toBeNull()
    expect(normalizeTimezoneLabel('America/Phoenix')).toBe('Arizona Time (AZ)')
    expect(normalizeTimezoneLabel('')).toBeNull()
    expect(normalizeTimezoneLabel(null)).toBeNull()
    expect(isValidTimezoneValue('Pacific Time (PT)')).toBe(true)
    expect(isValidTimezoneValue('Phoenix AZ')).toBe(false)
    expect(isValidTimezoneValue('')).toBe(false)
    expect(isValidTimezoneValue(undefined)).toBe(false)
  })

  it('every label resolves in lib/drip-time (the consumer that throws on bad values)', async () => {
    const { requireIanaTimezone } = await import('@/lib/drip-time')
    for (const tz of US_TIMEZONES) {
      expect(requireIanaTimezone(tz.value)).toBe(tz.iana)
    }
  })

  // Peoria, AZ held "Mountain Time (MT)" — a valid label and a wrong answer:
  // Denver springs forward, Phoenix does not. Pin that Arizona is its own
  // entry mapped to America/Phoenix, and that an Arizona pick puts a summer
  // 10:00 assessment at 10:00 Phoenix wall-clock while Mountain would have
  // landed it at 11:00 (the hour-off bug). Winter: identical.
  it('Arizona Time (AZ) → America/Phoenix, and differs from Mountain during DST only', async () => {
    const { requireIanaTimezone } = await import('@/lib/drip-time')
    const { formatInTimeZone } = await import('date-fns-tz')
    expect(requireIanaTimezone('Arizona Time (AZ)')).toBe('America/Phoenix')
    expect(US_TIMEZONES.find(tz => tz.value === 'Mountain Time (MT)')!.label).not.toContain('Phoenix')

    // 10:00 Phoenix on a July day = 17:00Z. Denver reads that instant as 11:00.
    const july = new Date('2026-07-15T17:00:00Z')
    expect(formatInTimeZone(july, requireIanaTimezone('Arizona Time (AZ)'), 'HH:mm')).toBe('10:00')
    expect(formatInTimeZone(july, requireIanaTimezone('Mountain Time (MT)'), 'HH:mm')).toBe('11:00')
    // January: no DST anywhere, both read 10:00.
    const jan = new Date('2026-01-15T17:00:00Z')
    expect(formatInTimeZone(jan, requireIanaTimezone('Arizona Time (AZ)'), 'HH:mm')).toBe('10:00')
    expect(formatInTimeZone(jan, requireIanaTimezone('Mountain Time (MT)'), 'HH:mm')).toBe('10:00')
  })
})

describe('source guards — no second copy of the timezone list anywhere', () => {
  const beehub = readFileSync('components/BeeHub.jsx', 'utf8')
  const patchRoute = readFileSync('app/api/locations/[id]/route.ts', 'utf8')
  const adminRoute = readFileSync('app/api/admin/locations/route.ts', 'utf8')

  it('BeeHub.jsx imports the list and has no inline option literals or local copy', () => {
    expect(beehub).toContain('from "@/lib/us-timezones"')
    expect(beehub).not.toContain('<option value="Eastern Time (ET)">')
    expect(beehub).not.toMatch(/const US_TIMEZONES\s*=/)
    // onboarding step, Settings row, admin Create Location — three consumers
    expect(beehub.match(/US_TIMEZONES/g)!.length).toBeGreaterThanOrEqual(4) // import + 3 uses
  })

  it('the Settings row is the dropdown variant, not the free-text one', () => {
    expect(beehub).toMatch(/<SettingsEditRow label="Timezone"[\s\S]*?options=\{US_TIMEZONES\}/)
  })

  it('PATCH /api/locations/[id] validates timezone against the shared list', () => {
    expect(patchRoute).toContain("from '@/lib/us-timezones'")
    expect(patchRoute).toContain('isValidTimezoneValue(patch.timezone)')
  })

  it('POST /api/admin/locations validates against the shared list, no local Set', () => {
    expect(adminRoute).toContain("from '@/lib/us-timezones'")
    expect(adminRoute).not.toMatch(/VALID_TIMEZONES\s*=\s*new Set/)
  })
})
