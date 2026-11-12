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
//
// LATER THE SAME DAY — EVERY LINK IS CHECKED. The in-home link was the one
// booking link stored as free text. It is now a web address too (safeHttpUrl):
// in the panel, in the field further down, and on both routes that store it.
// Pinned at the foot of this file, with the proof that nothing else about the
// panel moved (fingerprints from main 2cc7183) and that NOTHING requires a
// discovery link — that idea is parked on the branch
// parked/discovery-link-required until the emails invite a discovery call.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const LOC_ID = '2b3c4d5e-1111-4222-8333-444455556666'
  const state = { updates: [] as { table: string; patch: any }[] }
  const from = (table: string) => {
    const b: any = { _patch: null as any }
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) b[m] = () => b
    b.update = (p: any) => { state.updates.push({ table, patch: p }); b._patch = p; return b }
    const row = () => ({ id: LOC_ID, role: 'owner', location_id: LOC_ID, ...(b._patch || {}) })
    b.maybeSingle = () => Promise.resolve({ data: row(), error: null })
    b.single = b.maybeSingle
    b.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
    return b
  }
  return { state, from, LOC_ID }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({ id: 'auth-1' })),
  getHubUser: vi.fn(async () => ({ id: 'u1', role: 'owner', location_id: h.LOC_ID })),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))
vi.mock('@/lib/sendable-domains', () => ({ getSendableDomains: vi.fn(async () => ['beeorganized.com']) }))

import * as BeeHubModule from '@/components/BeeHub'
import * as EmailsScreenModule from '@/components/settings/EmailsScreen'
import { safeHttpUrl } from './email-signature'
import { PATCH as locationPATCH } from '@/app/api/locations/[id]/route'
import { POST as pathsPOST } from '@/app/api/locations/[id]/paths/route'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// BeeHub.jsx is untyped JavaScript: taken as one value so this file adds
// nothing to the project's type-error count.
const { SettingsScreen, variantPrerequisiteMissing } = BeeHubModule as any
const { EmailDetailsSection } = EmailsScreenModule as any

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

// ═══════════════ every link is checked; nothing else moved ═══════════════

const IN_HOME = 'https://calendly.com/kc/in-home'
const DISCOVERY = 'https://calendly.com/kc/discovery'
const VIDEO = 'https://calendly.com/kc/video'
const BAD = ['not a link', 'javascript:alert(1)', 'mailto:me@x.com', 'http://', 'ftp://x.com/a']
const IN_HOME_SENTENCE = 'In-home assessment link must be a web address, like https://calendly.com/you'
const remount = () => { act(() => root.unmount()); root = createRoot(container) }
const details = () => (container.querySelector('#details') as HTMLElement).textContent
const blur = async (el: HTMLInputElement) => { await act(async () => { el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); el.dispatchEvent(new FocusEvent('blur')) }); for (let i = 0; i < 3; i++) await act(async () => {}) }

// Scripts that must give the same answer on main (2cc7183) and here. The
// first two and the rate one are the scripts the three fingerprints below
// were first taken with, unchanged.
const alreadyOn = async (o: Opts) => {
  await mount({ general: 'organizing-d', move: 'moving-d', loc: { bookingLink: IN_HOME }, ...o })
  const seen: any[] = [details(), isOn('link'), isOn('rate'), !!panel('link')]
  await click(sw('rate'))                       // d → b: a rate flip on a location that is on
  seen.push(details(), isOn('link'), isOn('rate'), !!panel('link'), !!panel('rate'))
  await click(sw('link'))                       // …and switching the link off: b → a
  seen.push(details(), isOn('link'), isOn('rate'), !!panel('link'))
  return { seen, writes: writes(), server: { ...server } }
}
const rateScript = async () => {
  await mount({ loc: { ratePerHour: '', bookingLink: IN_HOME } })
  await click(sw('rate'))
  const text = panel('rate')!.textContent
  await type(needed('rate'), '$90')
  await click(Array.from(panel('rate')!.querySelectorAll('button')).find(b => (b.textContent ?? '').startsWith('Turn it on'))!)
  return { text, writes: writes(), on: isOn('rate') }
}
// The turn-on panel itself: its whole markup as it opens (empty, and with
// links already stored), then every good-address path through it — the
// screen after each, and every write.
const panelScript = async () => {
  const out: any[] = []
  await mount()
  await click(sw('link'))
  out.push(panel('link')!.outerHTML)
  await type(needed('link'), IN_HOME)
  out.push(panel('link')!.outerHTML, turnOn('link').disabled)
  await click(turnOn('link'))
  out.push(details(), writes(), isOn('link'))
  remount()
  await mount({ discovery: DISCOVERY })
  await click(sw('link'))
  out.push(panel('link')!.outerHTML)
  await type(needed('link'), IN_HOME)
  await type(optional('discovery_booking_link'), 'https://calendly.com/kc/discovery-2')
  await type(optional('virtual_booking_link'), VIDEO)
  await click(turnOn('link'))
  out.push(details(), writes(), isOn('link'), { ...server })
  remount()
  await mount()
  await click(sw('link'))
  await type(optional('virtual_booking_link'), VIDEO)   // optional only: the button stays shut
  out.push(turnOn('link').disabled, panel('link')!.outerHTML)
  await click(Array.from(panel('link')!.querySelectorAll('button')).find(b => b.textContent === 'Cancel')!)
  out.push(details(), writes())
  return out
}

describe('the turn-on panel is what it was on main, apart from the address check', () => {
  it('its markup, every good-address path through it, and every write: one fingerprint, taken on 2cc7183', async () => {
    expect(fingerprint(await panelScript())).toBe('3a59580c3144b6a1')   // from main 2cc7183, same script
  })
  it('a location already on, in-home link only: untouched', async () => {
    expect(fingerprint(await alreadyOn({}))).toBe('2a5c4db0ff701800')
  })
  it('a location already on, all three links: untouched', async () => {
    expect(fingerprint(await alreadyOn({ discovery: DISCOVERY, video: VIDEO }))).toBe('c560e0a3c042e77c')
  })
  it('the rate switch: untouched', async () => {
    expect(fingerprint(await rateScript())).toBe('0c7ae05f1bc3695c')
  })
})

describe('the in-home link is refused when it is not a web address', () => {
  it('the panel: refused in words before ANYTHING is saved — with or without the optional links filled', async () => {
    for (const bad of BAD) {
      expect(safeHttpUrl(bad)).toBeNull()
      for (const withOptional of [false, true]) {
        remount()
        await mount()
        await click(sw('link'))
        await type(needed('link'), bad)
        if (withOptional) { await type(optional('discovery_booking_link'), DISCOVERY); await type(optional('virtual_booking_link'), VIDEO) }
        await click(turnOn('link'))
        expect(writes(), bad).toEqual([])
        expect(server).toMatchObject({ calendar: null, discovery: null, video: null, general: 'organizing-c', move: 'moving-c' })
        expect(isOn('link')).toBe(false)
        expect(container.querySelector('[data-variant-switch="both-link"]')!.textContent).toContain(IN_HOME_SENTENCE)
        expect(needed('link').value).toBe(bad)                    // still there to fix
      }
    }
    // fixed → goes through, exactly as a good one always did
    await type(needed('link'), IN_HOME)
    await click(turnOn('link'))
    expect(isOn('link')).toBe(true)
    expect(server.calendar).toBe(IN_HOME)
  })

  it('the panel’s OWN check, on its own: the in-home save is never even asked for (it does not lean on the field’s check behind it)', async () => {
    const onSaveLocation = vi.fn(async () => null), onSaveOption = vi.fn(async () => null), onVariant = vi.fn(async () => null)
    await act(async () => {
      root.render(<EmailDetailsSection rate="$95" calendarLink="" reviewsLink="" options={{ discoveryBookingLink: '', virtualBookingLink: '' }} ready={{ style: true, links: true }}
        counts={{}} waiting={{}} nothingWaiting={false} onSaveLocation={onSaveLocation} onSaveOption={onSaveOption}
        variant={{ split: false, sequences: [{ key: 'both', label: null, rate: false, link: false }] }} onVariant={onVariant} />)
    })
    await click(sw('link'))
    for (const bad of BAD) {
      await type(needed('link'), bad)
      await type(optional('discovery_booking_link'), DISCOVERY)
      await click(turnOn('link'))
      expect(onSaveLocation, bad).not.toHaveBeenCalled()
      expect(onSaveOption, bad).not.toHaveBeenCalled()
      expect(onVariant, bad).not.toHaveBeenCalled()
      expect(container.querySelector('[data-variant-switch="both-link"]')!.textContent).toContain(IN_HOME_SENTENCE)
    }
    await type(needed('link'), IN_HOME)
    await click(turnOn('link'))
    expect(onSaveLocation.mock.calls).toEqual([['booking', IN_HOME]])
    expect(onSaveOption.mock.calls).toEqual([[{ discovery_booking_link: DISCOVERY }]])
    expect(onVariant.mock.calls).toEqual([['both', { link: true }, { locationCalendarLink: IN_HOME }]])
  })

  it('the panel before the optional columns exist (in-home asked alone): refused the same way', async () => {
    await mount({ linksReady: false })
    await click(sw('link'))
    await type(needed('link'), 'not a link')
    await click(turnOn('link'))
    expect(writes()).toEqual([])
    expect(isOn('link')).toBe(false)
    expect(container.querySelector('[data-variant-switch="both-link"]')!.textContent).toContain(IN_HOME_SENTENCE)
  })

  it('the field further down the screen: refused before it is sent; a good one saves as it always did', async () => {
    await mount({ general: 'organizing-d', move: 'moving-d', loc: { bookingLink: IN_HOME } })
    const field = container.querySelector('#field-booking') as HTMLInputElement
    for (const bad of BAD) {
      await type(field, bad)
      await blur(field)
      expect(writes(), bad).toEqual([])
      expect(server.calendar).toBe(IN_HOME)
      expect(details()).toContain(IN_HOME_SENTENCE)
    }
    await type(field, 'https://calendly.com/kc/new')
    await blur(field)
    expect(writes()).toEqual([`PATCH /api/locations/${LOC} {"calendar_link":"https://calendly.com/kc/new"}`])
    // …and emptying it still clears, exactly as before — a blank is not "malformed"
    await type(field, '')
    await blur(field)
    expect(writes()).toEqual([
      `PATCH /api/locations/${LOC} {"calendar_link":"https://calendly.com/kc/new"}`,
      `PATCH /api/locations/${LOC} {"calendar_link":""}`,
    ])
    expect(server.calendar).toBeNull()
  })

  describe('the server', () => {
    const patchLocation = (body: any) => locationPATCH(new Request(`http://x/api/locations/${LOC}`, { method: 'PATCH', body: JSON.stringify(body) }) as any, { params: { id: LOC } })
    const postPaths = (body: any) => pathsPOST(new Request(`http://x/api/locations/${LOC}/paths`, { method: 'POST', body: JSON.stringify(body) }) as any, { params: { id: LOC } })
    for (const [name, call] of [['PATCH /api/locations/[id]', patchLocation], ['POST /api/locations/[id]/paths (onboarding)', postPaths]] as const) {
      it(`${name}: a malformed in-home link is refused and nothing is written`, async () => {
        for (const bad of BAD) {
          h.state.updates = []
          const res = await call({ calendar_link: bad, default_drip_path: 'organizing-d' })
          expect(res.status, bad).toBe(400)
          expect((await res.json()).error).toBe(IN_HOME_SENTENCE)
          expect(h.state.updates, bad).toEqual([])
        }
      })
      it(`${name}: a good one is stored as a full web address; blank still clears`, async () => {
        h.state.updates = []
        expect((await call({ calendar_link: ' calendly.com/kc/in-home ' })).status).toBe(200)
        expect(h.state.updates.map(u => u.patch.calendar_link)).toEqual([IN_HOME])
        h.state.updates = []
        expect((await call({ calendar_link: IN_HOME })).status).toBe(200)
        expect(h.state.updates.map(u => u.patch.calendar_link)).toEqual([IN_HOME])
        h.state.updates = []
        await call({ calendar_link: '', default_drip_path: 'organizing-c' })
        expect(h.state.updates.map(u => u.patch.calendar_link)).toEqual([null])
      })
    }
  })
})

describe('no stored link is changed, and none would be refused', () => {
  it('every in-home link stored in production on 2026-11-12 (13 locations) passes the rule', () => {
    const stored = ['https://calendar.app.google/pmJixDgNb3xwV7dPA', 'https://calendar.app.google/C1Ho7KFf4ShsAUkn7', 'https://calendly.com/linda-beeorganized', 'https://calendly.com/lvoytovich-beeorganized/30min', 'https://calendly.com/christina-beeorganized/60min', 'https://calendar.app.google/qrd8iKsRwWZh12Vx5', 'https://calendar.app.google/rCoh7DkvGgZYX6fg9', 'https://calendar.app.google/6fATo1bdAEokX87S7', 'https://calendar.app.google/v6n1xpirqLXY7ZPd9', 'https://beeorganized.com/pages/southwest-austin#schedule', 'https://test.com', 'https://calendly.com/jamie-beeorganized/30min', 'https://calendly.com/csullivan-beeorganized/30min']
    expect(stored.filter(s => safeHttpUrl(s) === null)).toEqual([])
  })
  it('the check runs only on a save that carries the link: a route call without it writes no calendar_link', async () => {
    h.state.updates = []
    await locationPATCH(new Request(`http://x/api/locations/${LOC}`, { method: 'PATCH', body: JSON.stringify({ rate_per_hour: '$90' }) }) as any, { params: { id: LOC } })
    expect(h.state.updates.length).toBe(1)
    expect('calendar_link' in h.state.updates[0].patch).toBe(false)
  })
})

describe('nothing requires a discovery link, anywhere', () => {
  it('turning on with the in-home link alone works; a discovery link alone does not open the button', async () => {
    await mount()
    await click(sw('link'))
    await type(optional('discovery_booking_link'), DISCOVERY)
    expect(turnOn('link').disabled).toBe(true)
    await type(optional('discovery_booking_link'), '')
    await type(needed('link'), IN_HOME)
    await click(turnOn('link'))
    expect(isOn('link')).toBe(true)
    expect(server).toMatchObject({ calendar: IN_HOME, discovery: null })
  })
  it('a location that is off with an in-home link and no discovery link (Southwest Austin) turns on in one click', async () => {
    await mount({ loc: { bookingLink: IN_HOME } })
    await click(sw('link'))
    expect(panel('link')).toBeNull()
    expect(isOn('link')).toBe(true)
    expect(writes()).toEqual([
      `PATCH /api/locations/${LOC}/drip-paths {"default":"organizing-d"}`,
      `PATCH /api/locations/${LOC}/drip-paths {"default_move":"moving-d"}`,
    ])
  })
  it('the guard behind the switch knows only the in-home link, as before', () => {
    expect(variantPrerequisiteMissing('online', 'call', { locationCalendarLink: IN_HOME })).toEqual([])
    expect(variantPrerequisiteMissing('online', 'call', { locationCalendarLink: '', discoveryBookingLink: DISCOVERY, turningLinkOn: true })).toEqual(['link'])
    for (const f of ['components/BeeHub.jsx', 'components/settings/EmailsScreen.jsx']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8')
      expect(src, f).not.toMatch(/Add your discovery call link first|turningLinkOn|BookingLinkSwitch|discoveryReady|in-home emails will wait/)
    }
  })
})
