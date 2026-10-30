// @vitest-environment happy-dom
//
// ONE CONTROL, NOT TWO (2026-10-30 follow-up).
//
// The Emails screen's "I share my hourly rate" and "Clients book through a
// link" switches ARE the location's sequence variant — default_drip_path /
// default_move_drip_path, a–d — which the retired "two questions" modal used
// to set. Pinned on the real Settings screen against a fake server that
// remembers what was written:
//
//   • the switches show the location's real current position on load
//   • a location with no split behaves as today: one switch writes BOTH
//   • an existing organizing/moving split is never silently merged
//   • turning the rate on with no rate set ASKS for it and saves nothing
//     until it is given; same for the booking link
//   • nothing can reach TwoQuestionsModal any more
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = '2b3c4d5e-1111-4222-8333-444455556666'
const selectedLoc = (over: any = {}) => ({
  id: LOC, name: 'Kansas City', address: '1 Main', phone: '(816) 555-0100',
  bookingLink: 'https://cal.example.com/kc', reviewsLink: 'https://g.page/r/kc', ratePerHour: '$95',
  serviceRadius: '25 miles', timezone: 'America/Chicago', assessmentType: 'in-person', smsEnabled: false,
  jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
  sendFromName: 'Bee KC', sendFromEmail: 'kc@x.com', replyToEmail: 'kc@x.com', ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let server: { general: string; move: string | null }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const mount = async (general: string, move: string | null, loc: any = selectedLoc()) => {
  server = { general, move }
  fetchMock = vi.fn(async (url: string, opts?: any) => {
    const u = String(url)
    if (u === `/api/locations/${LOC}/drip-paths` && opts?.method === 'PATCH') {
      const b = JSON.parse(opts.body)
      if (b.default) server.general = b.default
      if (b.default_move) server.move = b.default_move
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u === `/api/locations/${LOC}/drip-paths`) {
      return { ok: true, status: 200, json: async () => ({ paths: [], default_drip_path: server.general, default_move_drip_path: server.move }) }
    }
    if (u === `/api/locations/${LOC}` && opts?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true, location: JSON.parse(opts.body) }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection="emails" />) })
  await act(async () => {})
  await act(async () => {})
}

const variantWrites = () => fetchMock.mock.calls
  .filter(([u, o]: any[]) => String(u) === `/api/locations/${LOC}/drip-paths` && o?.method === 'PATCH')
  .map(([, o]: any[]) => JSON.parse(o.body))
const locationWrites = () => fetchMock.mock.calls
  .filter(([u, o]: any[]) => String(u) === `/api/locations/${LOC}` && o?.method === 'PATCH')
  .map(([, o]: any[]) => JSON.parse(o.body))
const sw = (key: string, which: 'rate' | 'link') =>
  container.querySelector(`[data-variant-switch="${key}-${which}"] [role="switch"]`) as HTMLElement
const on = (key: string, which: 'rate' | 'link') => sw(key, which)?.getAttribute('aria-checked') === 'true'
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); await act(async () => {}) }
const type = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label) as HTMLElement

describe('the switches show the location’s real position on load', () => {
  for (const [letter, rate, link] of [['a', true, false], ['b', true, true], ['c', false, false], ['d', false, true]] as const) {
    it(`organizing-${letter} / moving-${letter}: rate ${rate ? 'on' : 'off'}, link ${link ? 'on' : 'off'}`, async () => {
      await mount(`organizing-${letter}`, `moving-${letter}`)
      expect(on('both', 'rate')).toBe(rate)
      expect(on('both', 'link')).toBe(link)
      expect(container.querySelector('[data-variant-switch^="organizing-"]')).toBeNull()
    })
  }
})

describe('a location with no split behaves exactly as today', () => {
  it('one set of switches; a flip writes BOTH sequences to the matching letter', async () => {
    await mount('organizing-b', 'moving-b')
    await click(sw('both', 'rate'))                 // rate off: b → d
    expect(variantWrites()).toEqual([{ default: 'organizing-d' }, { default_move: 'moving-d' }])
    expect(server).toEqual({ general: 'organizing-d', move: 'moving-d' })
    expect(on('both', 'rate')).toBe(false)
    expect(on('both', 'link')).toBe(true)
  })
  it('the moving choice reads "the same emails"', async () => {
    await mount('organizing-b', 'moving-b')
    const same = container.querySelector('[data-moving-choice] [role="radio"]') as HTMLElement
    expect(same.textContent).toContain('Get the same emails as organizing clients')
    expect(same.getAttribute('aria-checked')).toBe('true')
  })
})

describe('an existing organizing/moving split is never silently merged', () => {
  it('loc_kc (organizing-a / moving-c) loads as "their own", each sequence showing its own answers', async () => {
    await mount('organizing-a', 'moving-c')
    const radios = Array.from(container.querySelectorAll('[data-moving-choice] [role="radio"]')) as HTMLElement[]
    expect(radios[1].textContent).toContain('Get their own set of emails')
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(sw('both', 'rate')).toBeNull()
    expect([on('organizing', 'rate'), on('organizing', 'link')]).toEqual([true, false])     // a
    expect([on('moving', 'rate'), on('moving', 'link')]).toEqual([false, false])            // c
  })

  it('a flip on one sequence writes ONLY that sequence', async () => {
    await mount('organizing-a', 'moving-c')
    await click(sw('organizing', 'link'))            // a → b, organizing only
    expect(variantWrites()).toEqual([{ default: 'organizing-b' }])
    expect(server).toEqual({ general: 'organizing-b', move: 'moving-c' })
    await click(sw('moving', 'link'))                // c → d, moving only
    expect(variantWrites()).toEqual([{ default: 'organizing-b' }, { default_move: 'moving-d' }])
    expect(server).toEqual({ general: 'organizing-b', move: 'moving-d' })
  })

  it('choosing "the same" asks first, writes nothing until confirmed, and "Keep them separate" keeps it', async () => {
    await mount('organizing-a', 'moving-c')
    const same = (Array.from(container.querySelectorAll('[data-moving-choice] [role="radio"]')) as HTMLElement[])[0]
    await click(same)
    expect(container.textContent).toContain('Replace the moving emails?')
    expect(variantWrites()).toEqual([])
    await click(button('Keep them separate'))
    expect(variantWrites()).toEqual([])
    expect(server.move).toBe('moving-c')
    await click(same)
    await click(button('Yes, use the same'))
    expect(variantWrites()).toEqual([{ default_move: 'moving-a' }])
    expect(server).toEqual({ general: 'organizing-a', move: 'moving-a' })
    expect(sw('both', 'rate')).toBeTruthy()
  })
})

describe('the guard is the switch’s own', () => {
  it('rate ON with no rate set asks for the rate and saves NOTHING', async () => {
    await mount('organizing-c', 'moving-c', selectedLoc({ ratePerHour: '' }))
    await click(sw('both', 'rate'))
    expect(variantWrites()).toEqual([])
    expect(locationWrites()).toEqual([])
    expect(on('both', 'rate')).toBe(false)
    const ask = container.querySelector('[data-variant-switch="both-rate"] [role="group"]') as HTMLElement
    expect(ask.textContent).toContain('Your hourly rate')
    expect((Array.from(ask.querySelectorAll('button')).find(b => b.textContent === 'Turn it on') as HTMLButtonElement).disabled).toBe(true)
    await click(button('Cancel'))
    expect(variantWrites()).toEqual([])
    expect(server).toEqual({ general: 'organizing-c', move: 'moving-c' })
  })

  it('…and once the rate is given, saves the rate FIRST, then the variant', async () => {
    await mount('organizing-c', 'moving-c', selectedLoc({ ratePerHour: '' }))
    await click(sw('both', 'rate'))
    await type(container.querySelector('[data-variant-switch="both-rate"] input') as HTMLInputElement, '$90')
    await click(button('Turn it on'))
    expect(locationWrites()).toEqual([{ rate_per_hour: '$90' }])
    expect(variantWrites()).toEqual([{ default: 'organizing-a' }, { default_move: 'moving-a' }])
    const order = fetchMock.mock.calls.map(([u, o]: any[]) => `${o?.method || 'GET'} ${u}`).filter(x => x.startsWith('PATCH'))
    expect(order[0]).toBe(`PATCH /api/locations/${LOC}`)
    expect(on('both', 'rate')).toBe(true)
  })

  it('link ON with no booking link set asks for the link and saves NOTHING', async () => {
    await mount('organizing-c', 'moving-c', selectedLoc({ bookingLink: '' }))
    await click(sw('both', 'link'))
    expect(variantWrites()).toEqual([])
    expect(locationWrites()).toEqual([])
    const ask = container.querySelector('[data-variant-switch="both-link"] [role="group"]') as HTMLElement
    expect(ask.textContent).toContain('Your booking link')
  })

  it('with the value already set, a switch turns on straight away', async () => {
    await mount('organizing-c', 'moving-c')
    await click(sw('both', 'rate'))
    expect(variantWrites()).toEqual([{ default: 'organizing-a' }, { default_move: 'moving-a' }])
  })
})

describe('nothing can reach TwoQuestionsModal any more', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  it('it is not defined, mounted or exported, and nothing opens it', () => {
    expect(src).not.toMatch(/function TwoQuestionsModal|<TwoQuestionsModal|openVariantQuestions\(|changeVariant:/)
  })
  it('the Emails screen offers no "Change how this works" link', async () => {
    await mount('organizing-a', 'moving-c')
    expect(container.textContent).not.toContain('Change how this works')
  })
})
