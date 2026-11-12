// @vitest-environment happy-dom
//
// THE LINK SWITCH OFFERS ALL THREE LINKS WHILE IT ASKS (2026-11-12).
//
// Turning on "Clients book through a link" with no in-home link used to ask
// for that one link and promise the other two "once it's on" — two trips.
// The panel now shows all three: the in-home link NEEDED, the discovery and
// video links optional. Pinned on the real Settings screen against a fake
// server that records every write, in order:
//
//   • "Turn it on" is disabled until the in-home link has a value
//   • in-home only → exactly the writes it made before (fingerprint from main)
//   • both optional links go in the same click, in ONE email-settings save
//   • an optional link that isn't a web address is refused; nothing is stored
//   • the switch cannot be turned on with no in-home link
//   • the rate switch writes exactly what it wrote before (fingerprint from main)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHubModule from '@/components/BeeHub'
import { safeHttpUrl } from './email-signature'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// BeeHub.jsx is untyped JavaScript: taken as one value so this file adds
// nothing to the project's type-error count.
const { SettingsScreen } = BeeHubModule as any

const LOC = '2b3c4d5e-1111-4222-8333-444455556666'
const selectedLoc = (over: any = {}) => ({
  id: LOC, name: 'Kansas City', address: '1 Main', phone: '(816) 555-0100',
  bookingLink: '', reviewsLink: 'https://g.page/r/kc', ratePerHour: '$95',
  serviceRadius: '25 miles', timezone: 'America/Chicago', assessmentType: 'in-person', smsEnabled: false,
  jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
  sendFromName: 'Bee KC', sendFromEmail: 'kc@x.com', replyToEmail: 'kc@x.com', ...over,
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let server: { general: string; move: string | null; calendar: string | null; rate: string | null; discovery: string | null; video: string | null }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

type Opts = { loc?: any; general?: string; move?: string; discovery?: string | null; video?: string | null; linksReady?: boolean; failExtras?: string | null }
const mount = async (o: Opts = {}) => {
  const loc = selectedLoc(o.loc)
  server = { general: o.general ?? 'organizing-c', move: o.move ?? 'moving-c', calendar: loc.bookingLink || null, rate: loc.ratePerHour || null, discovery: o.discovery ?? null, video: o.video ?? null }
  const settings = () => ({ style: 'classic', discoveryBookingLink: server.discovery, virtualBookingLink: server.video })
  fetchMock = vi.fn(async (url: string, opts?: any) => {
    const u = String(url)
    const ok = (j: any) => ({ ok: true, status: 200, json: async () => j })
    const no = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) })
    if (u === `/api/locations/${LOC}/drip-paths` && opts?.method === 'PATCH') {
      const b = JSON.parse(opts.body)
      if (b.default) server.general = b.default
      if (b.default_move) server.move = b.default_move
      return ok({ ok: true })
    }
    if (u === `/api/locations/${LOC}/drip-paths`) return ok({ paths: [], default_drip_path: server.general, default_move_drip_path: server.move })
    if (u === `/api/locations/${LOC}/email-settings` && opts?.method === 'PATCH') {
      if (o.failExtras) return no(500, o.failExtras)
      const b = JSON.parse(opts.body)
      // the route's own rule (app/api/locations/[id]/email-settings/route.ts)
      for (const [k, noun] of [['discovery_booking_link', 'Discovery call link'], ['virtual_booking_link', 'Video assessment link']] as const) {
        if (!(k in b)) continue
        const v = b[k]
        if (v === null || !String(v).trim()) { server[k === 'discovery_booking_link' ? 'discovery' : 'video'] = null; continue }
        const url2 = safeHttpUrl(v)
        if (!url2) return no(400, `${noun} must be a web address, like https://calendly.com/you`)
        server[k === 'discovery_booking_link' ? 'discovery' : 'video'] = url2
      }
      return ok({ ok: true, settings: settings() })
    }
    if (u === `/api/locations/${LOC}/email-settings`) return ok({ settings: settings(), ready: { style: true, links: o.linksReady !== false } })
    if (u === `/api/locations/${LOC}` && opts?.method === 'PATCH') {
      const b = JSON.parse(opts.body)
      if ('calendar_link' in b) server.calendar = b.calendar_link || null
      if ('rate_per_hour' in b) server.rate = b.rate_per_hour || null
      return ok({ ok: true, location: b })
    }
    return ok({})
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection="emails" />) })
  for (let i = 0; i < 4; i++) await act(async () => {})
}

// Every write, in the order it was sent.
const writes = () => fetchMock.mock.calls
  .filter(([, o]: any[]) => o?.method && o.method !== 'GET')
  .map(([u, o]: any[]) => `${o.method} ${String(u)} ${o.body}`)
const fingerprint = (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

const sw = (which: 'rate' | 'link', key = 'both') => container.querySelector(`[data-variant-switch="${key}-${which}"] [role="switch"]`) as HTMLElement
const isOn = (which: 'rate' | 'link') => sw(which)?.getAttribute('aria-checked') === 'true'
const panel = (which: 'rate' | 'link') => container.querySelector(`[data-variant-switch="both-${which}"] [role="group"]`) as HTMLElement | null
const turnOn = (which: 'rate' | 'link') => Array.from(panel(which)!.querySelectorAll('button')).find(b => b.textContent === 'Turn it on') as HTMLButtonElement
const needed = (which: 'rate' | 'link') => panel(which)!.querySelector('input') as HTMLInputElement          // the first field: the one it needs
const optional = (k: 'discovery_booking_link' | 'virtual_booking_link') => panel('link')!.querySelector(`[data-optional-link="${k}"]`) as HTMLInputElement
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }); for (let i = 0; i < 3; i++) await act(async () => {}) }
const type = async (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const enter = async (el: HTMLInputElement) => {
  await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  for (let i = 0; i < 3; i++) await act(async () => {})
}

// ── the two paths that must not move, fingerprinted against main ──────────
// These two scripts use only what exists on both sides of the change (the
// switch, the panel's first field, "Turn it on"). Run on main at 6f587fa they
// produced the two fingerprints below; they must produce them still.
const inHomeOnly = async () => {
  await mount()
  await click(sw('link'))
  await type(needed('link'), 'https://calendly.com/kc/in-home')
  await click(turnOn('link'))
  return writes()
}
const rateOnly = async () => {
  await mount({ loc: { ratePerHour: '', bookingLink: 'https://cal.example.com/kc' } })
  await click(sw('rate'))
  await type(needed('rate'), '$90')
  await click(turnOn('rate'))
  return writes()
}

describe('the common path writes what it always wrote', () => {
  it('in-home link only: the link, then the two sequences — nothing else, same order, same bodies', async () => {
    const w = await inHomeOnly()
    expect(w).toEqual([
      `PATCH /api/locations/${LOC} {"calendar_link":"https://calendly.com/kc/in-home"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default":"organizing-d"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default_move":"moving-d"}`,
    ])
    expect(fingerprint(w)).toBe('b8db4785ce9d13a4')   // from main 6f587fa, same script
    expect(isOn('link')).toBe(true)
    expect(panel('link')).toBeNull()
    expect(w.some(x => x.includes('/email-settings'))).toBe(false)     // the optional save is not even sent
  })

  it('the rate switch: the rate, then the two sequences — and its panel offers no extra fields', async () => {
    await mount({ loc: { ratePerHour: '', bookingLink: 'https://cal.example.com/kc' } })
    await click(sw('rate'))
    const p = panel('rate')!
    expect(p.querySelectorAll('input').length).toBe(1)
    expect(p.querySelector('[data-optional-links]')).toBeNull()
    expect(p.querySelector('[data-needed]')).toBeNull()
    expect(p.textContent).toBe('Your hourly rateWe need your hourly rate before this can turn on — it’s written into your emails, so without it they’d wait.Turn it onCancel')
    act(() => root.unmount()); root = createRoot(container)
    const w = await rateOnly()
    expect(w).toEqual([
      `PATCH /api/locations/${LOC} {"rate_per_hour":"$90"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default":"organizing-a"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default_move":"moving-a"}`,
    ])
    expect(fingerprint(w)).toBe('0a860957f2e6da31')   // from main 6f587fa, same script
    expect(isOn('rate')).toBe(true)
  })
})

describe('all three links are offered, and it is plain which one is needed', () => {
  it('the panel shows the in-home link marked Needed and the other two marked optional, in one go', async () => {
    await mount()
    await click(sw('link'))
    const p = panel('link')!
    expect(p.querySelectorAll('input').length).toBe(3)
    const labels = Array.from(p.querySelectorAll('label')).map(l => l.textContent)
    expect(labels).toEqual(['Your in-home assessment linkNeeded', 'Discovery call link · optional', 'Video assessment link · optional'])
    expect(p.textContent).toContain('We need your in-home assessment link before this can turn on — it’s written into your emails, so without it they’d wait. It’s the only one you need.')
    expect(p.textContent).toContain('If you have these too, add them now. They’re optional — leave them blank and it still turns on, and you can add them later.')
    // the promise of a second trip is gone
    expect(p.textContent).not.toMatch(/Once it.s on you can add/)
    expect(readFileSync(join(__dirname, '..', 'components/settings/EmailsScreen.jsx'), 'utf8')).not.toMatch(/Once it’s on you can add a discovery call link/)
    expect(writes()).toEqual([])                                   // asking saves nothing
  })

  it('before the two optional columns exist, only the in-home link is asked for (as before)', async () => {
    await mount({ linksReady: false })
    await click(sw('link'))
    expect(panel('link')!.querySelectorAll('input').length).toBe(1)
    expect(panel('link')!.querySelector('[data-optional-links]')).toBeNull()
  })

  it('links the location saved earlier are shown in the panel, and are not rewritten if left alone', async () => {
    await mount({ discovery: 'https://calendly.com/kc/discovery' })
    await click(sw('link'))
    expect(optional('discovery_booking_link').value).toBe('https://calendly.com/kc/discovery')
    await type(needed('link'), 'https://calendly.com/kc/in-home')
    await click(turnOn('link'))
    expect(writes().some(x => x.includes('/email-settings'))).toBe(false)
    expect(server.discovery).toBe('https://calendly.com/kc/discovery')
  })
})

describe('"Turn it on" waits for the in-home link, and only for it', () => {
  it('disabled with nothing typed; still disabled with BOTH optional links filled; enabled the moment the in-home link has a value', async () => {
    await mount()
    await click(sw('link'))
    expect(turnOn('link').disabled).toBe(true)
    await type(optional('discovery_booking_link'), 'https://calendly.com/kc/discovery')
    await type(optional('virtual_booking_link'), 'https://calendly.com/kc/video')
    expect(turnOn('link').disabled).toBe(true)
    await type(needed('link'), '   ')
    expect(turnOn('link').disabled).toBe(true)
    await type(needed('link'), 'https://calendly.com/kc/in-home')
    expect(turnOn('link').disabled).toBe(false)
    expect(writes()).toEqual([])
  })

  it('a blank optional link never blocks: one filled, one blank, turns on and sends only the filled one', async () => {
    await mount()
    await click(sw('link'))
    await type(needed('link'), 'https://calendly.com/kc/in-home')
    await type(optional('virtual_booking_link'), 'https://calendly.com/kc/video')
    await click(turnOn('link'))
    expect(writes()).toEqual([
      `PATCH /api/locations/${LOC} {"calendar_link":"https://calendly.com/kc/in-home"}`,
      `PATCH /api/locations/${LOC}/email-settings {"virtual_booking_link":"https://calendly.com/kc/video"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default":"organizing-d"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default_move":"moving-d"}`,
    ])
    expect(isOn('link')).toBe(true)
    expect(server.discovery).toBeNull()
  })
})

describe('both optional links, filled in the panel, are saved by the same click', () => {
  it('one click: the in-home link, ONE email-settings save carrying both, then the switch', async () => {
    await mount()
    await click(sw('link'))
    await type(needed('link'), 'https://calendly.com/kc/in-home')
    await type(optional('discovery_booking_link'), ' calendly.com/kc/discovery ')
    await type(optional('virtual_booking_link'), 'https://calendly.com/kc/video')
    await click(turnOn('link'))
    expect(writes()).toEqual([
      `PATCH /api/locations/${LOC} {"calendar_link":"https://calendly.com/kc/in-home"}`,
      `PATCH /api/locations/${LOC}/email-settings {"discovery_booking_link":"calendly.com/kc/discovery","virtual_booking_link":"https://calendly.com/kc/video"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default":"organizing-d"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default_move":"moving-d"}`,
    ])
    expect(server).toMatchObject({ calendar: 'https://calendly.com/kc/in-home', discovery: 'https://calendly.com/kc/discovery', video: 'https://calendly.com/kc/video', general: 'organizing-d', move: 'moving-d' })
    expect(isOn('link')).toBe(true)
    expect(panel('link')).toBeNull()
    // …and the fields further down, now showing, hold what was just saved
    expect((container.querySelector('#field-discovery-booking') as HTMLInputElement).value).toBe('https://calendly.com/kc/discovery')
    expect((container.querySelector('#field-virtual-booking') as HTMLInputElement).value).toBe('https://calendly.com/kc/video')
    expect((container.querySelector('#field-booking') as HTMLInputElement).value).toBe('https://calendly.com/kc/in-home')
  })

  it('if the optional save fails, the switch still turns on (it has what it needs) and the owner is told the extras did not save', async () => {
    await mount({ failExtras: 'update_failed' })
    await click(sw('link'))
    await type(needed('link'), 'https://calendly.com/kc/in-home')
    await type(optional('discovery_booking_link'), 'https://calendly.com/kc/discovery')
    await click(turnOn('link'))
    expect(isOn('link')).toBe(true)
    expect(server.calendar).toBe('https://calendly.com/kc/in-home')
    expect(server.discovery).toBeNull()
    expect(container.querySelector('[data-variant-switch="both-link"]')!.textContent).toContain('It’s on, but the optional links didn’t save')
  })
})

describe('a malformed optional link is refused, not stored', () => {
  for (const bad of ['not a link', 'javascript:alert(1)', 'mailto:me@x.com', 'http://', 'ftp://x.com/a']) {
    it(`${JSON.stringify(bad)}: refused in words before ANYTHING is saved — not the in-home link, not the switch`, async () => {
      expect(safeHttpUrl(bad)).toBeNull()                           // the rule: lib/email-signature.ts, as the route applies it
      await mount()
      await click(sw('link'))
      await type(needed('link'), 'https://calendly.com/kc/in-home')
      await type(optional('discovery_booking_link'), bad)
      await click(turnOn('link'))
      expect(writes()).toEqual([])
      expect(server).toMatchObject({ calendar: null, discovery: null, video: null, general: 'organizing-c', move: 'moving-c' })
      expect(isOn('link')).toBe(false)
      expect(container.querySelector('[data-variant-switch="both-link"]')!.textContent).toContain('Discovery call link must be a web address, like https://calendly.com/you')
      // what they typed is still there to fix
      expect(needed('link').value).toBe('https://calendly.com/kc/in-home')
      expect(optional('discovery_booking_link').value).toBe(bad)
      // fixed → goes through
      await type(optional('discovery_booking_link'), 'https://calendly.com/kc/discovery')
      await click(turnOn('link'))
      expect(isOn('link')).toBe(true)
      expect(server.discovery).toBe('https://calendly.com/kc/discovery')
    })
  }
  it('the client refusal is the route’s own sentence and rule', () => {
    const route = readFileSync(join(__dirname, '..', 'app/api/locations/[id]/email-settings/route.ts'), 'utf8')
    expect(route).toContain("import { safeHttpUrl } from '@/lib/email-signature'")
    expect(route).toContain('must be a web address, like https://calendly.com/you')
  })
})

describe('the switch cannot be turned on with no in-home link', () => {
  it('Enter in an optional field with the in-home link blank does nothing', async () => {
    await mount()
    await click(sw('link'))
    await type(optional('discovery_booking_link'), 'https://calendly.com/kc/discovery')
    await enter(optional('discovery_booking_link'))
    await enter(optional('virtual_booking_link'))
    await enter(needed('link'))
    expect(writes()).toEqual([])
    expect(isOn('link')).toBe(false)
    expect(server.discovery).toBeNull()
  })

  it('clicking the disabled button, or the switch again, saves nothing and leaves it off', async () => {
    await mount()
    await click(sw('link'))
    await type(optional('virtual_booking_link'), 'https://calendly.com/kc/video')
    await click(turnOn('link'))
    await click(sw('link'))
    expect(writes()).toEqual([])
    expect(isOn('link')).toBe(false)
    expect(server).toMatchObject({ general: 'organizing-c', move: 'moving-c', video: null })
  })

  it('Cancel throws the three drafts away; nothing is saved and the next ask starts clean', async () => {
    await mount()
    await click(sw('link'))
    await type(needed('link'), 'https://calendly.com/kc/in-home')
    await type(optional('discovery_booking_link'), 'https://calendly.com/kc/discovery')
    await click(Array.from(panel('link')!.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!)
    expect(panel('link')).toBeNull()
    expect(writes()).toEqual([])
    await click(sw('link'))
    expect(needed('link').value).toBe('')
    expect(optional('discovery_booking_link').value).toBe('')
  })

  it('the backstop behind the panel still refuses: the variant save itself says "Add your in-home assessment link first."', () => {
    const src = readFileSync(join(__dirname, '..', 'components/BeeHub.jsx'), 'utf8')
    expect(src).toContain("if (missing.length) return missing.includes('rate') ? 'Add your hourly rate first.' : 'Add your in-home assessment link first.'")
    const es = readFileSync(join(__dirname, '..', 'components/settings/EmailsScreen.jsx'), 'utf8')
    // the button's own gate reads the in-home value and nothing else
    expect(es).toContain("<EBtn variant=\"primary\" disabled={!value.trim() || busy} onClick={confirm}>")
    expect(es).toMatch(/const confirm = async \(\) => \{\n    const v = value\.trim\(\)\n    if \(!v\) return\n/)
  })
})
