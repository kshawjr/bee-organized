// @vitest-environment happy-dom
//
// THREE BOOKING LINKS, EACH OPTIONAL (Kevin, 2026-10-30).
//
// "Some owners want to have their Discovery Calls book on a calendar, some
// don't. If the button is toggled that they use a link they should be able to
// enter 3 different types of links."
//
// Pinned on the real Settings screen against a fake server that remembers
// what was written:
//
//   • with "Clients book through a link" on, all three fields show
//   • with it off, none of them does
//   • a link saved, the switch turned off and on again, is still there
//   • filling only one of the three is a valid, saved state with no error
//   • all three tags are in the merge-tag picker whatever the switch says
//   • an email using a tag whose link is blank is still held, and names it
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHub from '@/components/BeeHub'
import { OWNER_MERGE_TAGS } from './merge-tags'
const { SettingsScreen, DripPathStepEditor } = BeeHub as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = '3c4d5e6f-2222-4333-8444-555566667777'
const selectedLoc = (over: any = {}) => ({
  id: LOC, name: 'Kansas City', address: '1 Main', phone: '(816) 555-0100',
  bookingLink: '', reviewsLink: 'https://g.page/r/kc', ratePerHour: '$95',
  serviceRadius: '25 miles', timezone: 'America/Chicago', assessmentType: 'in-person', smsEnabled: false,
  jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
  sendFromName: 'Bee KC', sendFromEmail: 'kc@x.com', replyToEmail: 'kc@x.com', ...over,
})

const FIELDS = { discovery: '#field-discovery-booking', video: '#field-virtual-booking', inHome: '#field-booking' }
const LABELS = ['Discovery call link', 'Video assessment link', 'In-home assessment link']

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let server: any
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const settingsOut = () => ({ style: 'soft', discoveryBookingLink: server.discovery, virtualBookingLink: server.virtual })

const mount = async (general: string, { discovery = null as string | null, virtual = null as string | null, steps = [] as any[], loc = selectedLoc() } = {}) => {
  server = { general, move: general.replace('organizing', 'moving'), discovery, virtual }
  fetchMock = vi.fn(async (url: string, opts?: any) => {
    const u = String(url)
    if (u === `/api/locations/${LOC}/email-settings` && opts?.method === 'PATCH') {
      const b = JSON.parse(opts.body)
      if ('discovery_booking_link' in b) server.discovery = b.discovery_booking_link || null
      if ('virtual_booking_link' in b) server.virtual = b.virtual_booking_link || null
      return { ok: true, status: 200, json: async () => ({ ok: true, settings: settingsOut() }) }
    }
    if (u === `/api/locations/${LOC}/email-settings`) {
      return { ok: true, status: 200, json: async () => ({ settings: settingsOut(), ready: { style: true, links: true } }) }
    }
    if (u === `/api/locations/${LOC}/drip-paths` && opts?.method === 'PATCH') {
      const b = JSON.parse(opts.body)
      if (b.default) server.general = b.default
      if (b.default_move) server.move = b.default_move
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u === `/api/locations/${LOC}/drip-paths`) {
      return { ok: true, status: 200, json: async () => ({
        default_drip_path: server.general, default_move_drip_path: server.move,
        paths: steps.length ? [{ id: 'p-org', location_uuid: LOC, path_key: server.general, name: 'Org', is_active: true, is_default: true, steps }] : [],
      }) }
    }
    if (u === `/api/locations/${LOC}` && opts?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true, location: JSON.parse(opts.body) }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection="emails" />) })
  await act(async () => {}); await act(async () => {})
}

const field = (k: keyof typeof FIELDS) => container.querySelector(FIELDS[k]) as HTMLInputElement | null
const labelOf = (el: Element) => (el.closest('label')!.querySelector('span') as HTMLElement).textContent
const linkSwitch = () => container.querySelector('[data-variant-switch="both-link"] [role="switch"]') as HTMLElement
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); await act(async () => {}) }
const type = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const commit = async (el: HTMLInputElement) => {
  await act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); el.dispatchEvent(new FocusEvent('blur')) })
  await act(async () => {}); await act(async () => {})
}
const linkWrites = () => fetchMock.mock.calls
  .filter(([u, o]: any[]) => String(u) === `/api/locations/${LOC}/email-settings` && o?.method === 'PATCH')
  .map(([, o]: any[]) => JSON.parse(o.body))

describe('the switch decides whether the three links show', () => {
  it('on → all three, each its own field, under the three names', async () => {
    await mount('organizing-b')
    expect(linkSwitch().getAttribute('aria-checked')).toBe('true')
    const shown = (['discovery', 'video', 'inHome'] as const).map(k => field(k))
    for (const f of shown) expect(f).toBeTruthy()
    expect(shown.map(f => labelOf(f!))).toEqual(LABELS)
    for (const f of shown) expect(f!.readOnly).toBe(false)
  })

  it('off → none of them', async () => {
    await mount('organizing-a')
    expect(linkSwitch().getAttribute('aria-checked')).toBe('false')
    for (const k of ['discovery', 'video', 'inHome'] as const) expect(field(k)).toBeNull()
  })
})

describe('a saved link survives the switch', () => {
  it('saved, switched off, switched on again → still there, and the off never cleared it', async () => {
    await mount('organizing-b', { loc: selectedLoc({ bookingLink: 'https://cal.example.com/home' }) })
    await type(field('discovery')!, 'https://cal.example.com/discovery')
    await commit(field('discovery')!)
    expect(server.discovery).toBe('https://cal.example.com/discovery')

    await click(linkSwitch())                                   // off: b → a
    expect(server.general).toBe('organizing-a')
    expect(field('discovery')).toBeNull()
    await click(linkSwitch())                                   // on: a → b (in-home set, so no ask)
    expect(server.general).toBe('organizing-b')

    expect(field('discovery')!.value).toBe('https://cal.example.com/discovery')
    expect(field('inHome')!.value).toBe('https://cal.example.com/home')
    expect(server.discovery).toBe('https://cal.example.com/discovery')
    expect(linkWrites()).toEqual([{ discovery_booking_link: 'https://cal.example.com/discovery' }])   // nothing cleared it
  })
})

describe('one of the three is enough', () => {
  it('only the video link filled → saved, "Saved" shows, no error on any of the three', async () => {
    await mount('organizing-b', { loc: selectedLoc({ bookingLink: '' }) })
    await type(field('video')!, 'https://cal.example.com/video')
    await commit(field('video')!)
    expect(server.virtual).toBe('https://cal.example.com/video')
    expect(server.discovery).toBeNull()
    expect(field('video')!.closest('label')!.textContent).toContain('Saved')
    for (const k of ['discovery', 'video', 'inHome'] as const) {
      expect(field(k)!.closest('label')!.textContent, k).not.toContain('⚠')
    }
  })
})

describe('the picker offers all three, whatever the switch says', () => {
  const keys = ['discovery_booking_link', 'virtual_booking_link', 'book_assessment_link', 'booking_link']
  it('the list itself carries all of them, under the three names', () => {
    const by = Object.fromEntries(OWNER_MERGE_TAGS.map(t => [t.key, t]))
    for (const k of keys) expect(by[k], k).toBeTruthy()
    expect(by.discovery_booking_link.label).toBe('Discovery call link')
    expect(by.virtual_booking_link.label).toBe('Video assessment link')
    expect(by.book_assessment_link.label).toBe('In-home assessment link')
    // The in-home link is no longer described as the discovery one.
    expect(by.book_assessment_link.description.toLowerCase()).not.toContain('discovery')
  })
  it('the email editor shows all of them — it takes no switch at all', async () => {
    await act(async () => { root.render(<DripPathStepEditor step={{ step_order: 2, subject: 'Hi', body: 'b', delay_days: 5 }} onSave={vi.fn()} onClose={() => {}} />) })
    for (const k of keys) expect(container.querySelector(`[data-merge-tag="${k}"]`), k).toBeTruthy()
  })
})

describe('a blank link still holds the email that uses it, and says which', () => {
  const step = (o: number, body: string) => ({ id: `s${o}`, step_order: o, delay_days: (o - 1) * 5, channel: 'email', subject: `Step ${o}`,
    body, master_template_id: null, template_name: null, template_legacy_id: null, is_active: true })
  it('discovery tag + blank discovery link → "Not sending — add your discovery call link"; the filled one sends', async () => {
    await mount('organizing-b', {
      virtual: 'https://cal.example.com/video',
      loc: selectedLoc({ bookingLink: 'https://cal.example.com/home' }),
      steps: [step(1, 'Book a call: {{discovery_booking_link}}'), step(2, 'Book a video visit: {{virtual_booking_link}}')],
    })
    const text = container.textContent || ''
    expect(text).toContain('Not sending — add your discovery call link')
    expect(text).not.toContain('add your video assessment link')
    expect(text).not.toContain('add your in-home assessment link')
    expect(field('discovery')!.closest('label')!.textContent).toContain('1 email is waiting for this')
  })
  it('in-home tag + blank in-home link names the in-home link', async () => {
    await mount('organizing-b', { discovery: 'https://cal.example.com/discovery', steps: [step(1, 'Book here: {{book_assessment_link}}')] })
    expect(container.textContent).toContain('Not sending — add your in-home assessment link')
  })
})
