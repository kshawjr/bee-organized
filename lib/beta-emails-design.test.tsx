// @vitest-environment happy-dom
//
// The designer's Emails screen (2026-10-30), mounted for real.
//
//   • a paused email STAYS in the list, in its place, says Paused, and offers
//     Start; a removed one leaves the timeline for "Removed from this group"
//   • Pause is offered where Remove is — never on the first email
//   • the Look picker shows five real emails, Soft marked Default, and saves
//     the pick to the location
//   • the two switches save to the location, and with rates off the rate
//     field is hidden
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EmailsList, SettingsScreen } from '@/components/BeeHub'
import { expandAllEmailGroups } from './emails-test-helpers'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const step = (order: number, over: any = {}) => ({
  id: `db_${order}`, dbId: `st-${order}`, order, type: 'email', delay_days: (order - 1) * 5,
  subject: `Subject ${order}`, body: `Body ${order}`, isActive: true, ...over,
})

const mountList = async (steps: any[]) => {
  const actions = { edit: vi.fn(), reset: vi.fn(), remove: vi.fn(), restore: vi.fn(), pause: vi.fn(), editTiming: vi.fn() }
  await act(async () => {
    root.render(<EmailsList pathSteps={{ p: steps }} masterSteps={{ p: steps }} templates={[]} generalDefault="p" moveDefault={null} actions={actions} sendConfig={{}} />)
  })
  await expandAllEmailGroups(container, act as any)
  return actions
}
const rows = () => Array.from(container.querySelectorAll('li[data-email-row]')) as HTMLElement[]
const rowFor = (subject: string) => rows().find(r => r.querySelector('p')?.parentElement?.textContent?.includes(subject) && r.textContent!.includes(subject))!

describe('Pause one email', () => {
  it('a paused email stays in its place, says Paused, and offers Start', async () => {
    const actions = await mountList([step(1), step(2, { isPaused: true }), step(3)])
    expect(rows().map(r => (r.textContent || '').match(/Subject \d/)![0])).toEqual(['Subject 1', 'Subject 2', 'Subject 3'])
    const r = rows()[1]
    expect(r.textContent).toContain('Paused')
    expect(r.textContent).toContain('no client gets this one until you start it again')
    expect(r.style.opacity).toBe('0.6')
    const start = Array.from(r.querySelectorAll('button')).find(b => b.textContent === '▶ Start')!
    await act(async () => { start.click() })
    expect(actions.pause).toHaveBeenCalledWith(expect.objectContaining({ order: 2 }), false)
    expect(container.textContent).not.toContain('Removed from this group')
  })

  it('Pause sits where Remove does — never on the first email', async () => {
    const actions = await mountList([step(1), step(2), step(3)])
    const pauses = rows().map(r => Array.from(r.querySelectorAll('button')).some(b => b.textContent === '⏸ Pause'))
    expect(pauses).toEqual([false, true, true])
    await act(async () => { (Array.from(rows()[2].querySelectorAll('button')).find(b => b.textContent === '⏸ Pause') as HTMLElement).click() })
    expect(actions.pause).toHaveBeenCalledWith(expect.objectContaining({ order: 3 }), true)
  })

  it('removed is different: it leaves the timeline for the group’s removed list', async () => {
    await mountList([step(1), step(2, { isActive: false }), step(3)])
    expect(rows()).toHaveLength(2)
    expect(container.textContent).toContain('Removed from this group')
  })
})

// ─── The whole screen ──────────────────────────────────────────────────
const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'
const selectedLoc = {
  id: LOC_UUID, name: 'Seattle', address: '1 Pike Pl', phone: '(206) 555-0100',
  bookingLink: '', reviewsLink: 'https://g.page/r/seattle', ratePerHour: '$95', serviceRadius: '25 miles',
  timezone: 'America/Los_Angeles', assessmentType: 'in-person', smsEnabled: false, jobberConnected: false,
  jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee Organized Seattle', sendFromEmail: 'seattle@x.com', replyToEmail: 'seattle@x.com',
}
const SETTINGS = { settings: { style: 'soft', showsHourlyRate: true, usesBookingLinks: true, discoveryBookingLink: null, virtualBookingLink: null }, ready: { style: true, switches: true, links: true } }
let fetchMock: ReturnType<typeof vi.fn>
const mountScreen = async () => {
  fetchMock = vi.fn(async (url: string, opts?: any) => {
    if (String(url).endsWith('/email-settings') && opts?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true, settings: { ...SETTINGS.settings, ...(JSON.parse(opts.body).shows_hourly_rate === false ? { showsHourlyRate: false } : {}), ...(JSON.parse(opts.body).email_style ? { style: JSON.parse(opts.body).email_style } : {}) } }) }
    }
    if (String(url).endsWith('/email-settings')) return { ok: true, status: 200, json: async () => SETTINGS }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => { root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="emails" />) })
  await act(async () => {})
  await act(async () => {})
}
const settingsPatches = () => fetchMock.mock.calls.filter(([u, o]: any[]) => String(u).endsWith('/email-settings') && o?.method === 'PATCH').map(([, o]: any[]) => JSON.parse(o.body))

describe('Look', () => {
  it('five real emails to choose from; Soft is marked Default and chosen', async () => {
    await mountScreen()
    const radios = Array.from(container.querySelectorAll('#style [role="radio"]')) as HTMLElement[]
    expect(radios.map(r => r.textContent?.match(/^(Soft|Outline|Bold|Rounded|Classic)/)?.[0])).toEqual(['Soft', 'Outline', 'Bold', 'Rounded', 'Classic'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios[0].textContent).not.toContain('Default')       // chosen shows the tick instead
    expect(radios.every(r => r.querySelector('iframe')?.getAttribute('srcdoc')?.includes('<!doctype html>'))).toBe(true)
  })

  it('picking a look saves it to the location', async () => {
    await mountScreen()
    const bold = (Array.from(container.querySelectorAll('#style [role="radio"]')) as HTMLElement[])[2]
    await act(async () => { bold.click() })
    expect(settingsPatches()).toEqual([{ email_style: 'bold' }])
  })
})

describe('Your details — the two switches', () => {
  it('"I share my hourly rate" off saves it, and hides the rate field', async () => {
    await mountScreen()
    expect(container.querySelector('#field-rate')).toBeTruthy()
    const sw = Array.from(container.querySelectorAll('#details [role="switch"]')).find(b => b.textContent?.includes('I share my hourly rate')) as HTMLElement
    await act(async () => { sw.click() })
    await act(async () => {})
    expect(settingsPatches()).toEqual([{ shows_hourly_rate: false }])
    expect(container.querySelector('#field-rate')).toBeNull()
  })
})
