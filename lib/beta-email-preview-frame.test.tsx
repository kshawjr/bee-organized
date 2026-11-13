// @vitest-environment happy-dom
//
// THE EMAIL PREVIEW: THE RIGHT HEIGHT, THE WHOLE EMAIL, AND IMAGES THAT MAY
// NOT LOAD (2026-11-12). Three things, each measured in a real browser engine
// before it was changed (Safari's, which Apple Mail uses):
//
// 1. HEIGHT. EmailFrame started 1,100px tall and read
//    documentElement.scrollHeight, which never answers less than the frame —
//    so a 779px email showed 1,100px, the rest pale mint, and never shrank.
//    It reads the body's height now, and re-reads when the content changes.
//    The fake document below answers the way a browser does (the root's
//    scrollHeight is never less than the frame's own height), so reading the
//    wrong one fails here exactly as it failed on screen.
//
// 2. THE WHOLE EMAIL. The welcome and the two job follow-ups end with an
//    unsubscribe line and a postal address. The preview left that out; it is
//    built now by the same function the sends use.
//
// 3. IMAGES OFF. The two honeycomb bands and the logo had a width and no
//    height; a band that does not load was drawn 600×600. They carry their
//    height now. That is the ONLY change to anything that is sent, and it is
//    pinned byte for byte against main (969a658).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { const b: any = {}; for (const m of ['select', 'eq', 'limit', 'in']) b[m] = () => b; b.maybeSingle = () => Promise.resolve({ data: { id: 'loc', email_style: 'soft', discovery_booking_link: null, virtual_booking_link: null }, error: null }); b.then = (r: any, j: any) => Promise.resolve({ data: [{ button_align: null }], error: null }).then(r, j); return b } } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'a1' } }, error: null }) }, from: () => { const b: any = {}; for (const m of ['select', 'eq', 'limit']) b[m] = () => b; b.maybeSingle = () => Promise.resolve({ data: { id: 'u1', role: 'super_admin', location_id: 'loc' }, error: null }); b.single = b.maybeSingle; return b } }) }))
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn(async () => ({ id: 'a1' })), getHubUser: vi.fn(async () => ({ id: 'u1', role: 'super_admin', location_id: 'loc' })), isAdmin: () => true }))

import * as EmailsScreenModule from '@/components/settings/EmailsScreen'
import { buildBrandedDripHtml, buildBrandedDripText, buildBrandedShellHtml, EMAIL_STYLES, EMAIL_HONEYCOMB_HEIGHT, DRIP_LOGO_HEIGHT } from './drip-email-layout'
import { buildMarketingFooter, COMMERCIAL_EMAIL_AUDIENCE } from './marketing-consent'
import { GET as emailSettingsGET } from '@/app/api/locations/[id]/email-settings/route'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// Untyped JavaScript module: taken as one value so this file adds nothing to
// the project's type-error count.
const { EmailFrame, EmailStyleSection, previewEmailHtml, previewCardFooter, sampleEmailHtml, EMAIL_FRAME_UNMEASURED_PX } = EmailsScreenModule as any

const sha = (v: any) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16)
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
// The image-height attributes item 3 added — and nothing else.
const withoutHeights = (html: string) => html.replace(/(<img src="[^"]*" width="600") height="150"( alt="")/g, '$1$2').replace(/(<img src="[^"]*" width="72") height="51"( alt="Bee Organized")/g, '$1$2')

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let observers: { cb: () => void; targets: any[]; disconnected: boolean }[]
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  observers = []
  // The test environment loads an iframe's srcDoc itself and fires "load" with
  // an empty, zero-height document. Until a test supplies a document, there is
  // none to read — so only the readings a test makes count.
  vi.spyOn(window.HTMLIFrameElement.prototype, 'contentDocument', 'get').mockReturnValue(null as any)
  vi.stubGlobal('ResizeObserver', class { o: any; constructor(cb: () => void) { this.o = { cb, targets: [], disconnected: false }; observers.push(this.o) } observe(t: any) { this.o.targets.push(t) } disconnect() { this.o.disconnected = true } unobserve() {} })
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

// A document that answers the way a browser's does: the BODY is as tall as the
// email; the ROOT's scrollHeight is never less than the frame it sits in.
type FakeDoc = { body: { scrollHeight: number } | null; documentElement: { scrollHeight: number }; addEventListener: any; listeners: Record<string, (() => void)[]> }
const fakeDoc = (frame: HTMLIFrameElement, bodyHeight: number | null): FakeDoc => {
  const listeners: Record<string, (() => void)[]> = {}
  const body = bodyHeight == null ? null : { scrollHeight: bodyHeight }
  return {
    body,
    documentElement: { get scrollHeight() { return Math.max(parseFloat(frame.style.height) || 0, body ? body.scrollHeight : 0) } },
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ||= []).push(fn) },
    listeners,
  }
}
const iframe = () => container.querySelector('iframe') as HTMLIFrameElement
const wrap = () => iframe().parentElement as HTMLElement
const load = async (doc: FakeDoc | null | 'throws') => {
  Object.defineProperty(iframe(), 'contentDocument', { configurable: true, get() { if (doc === 'throws') throw new Error('blocked'); return doc } })
  await act(async () => { iframe().dispatchEvent(new Event('load')) })
}
const show = async (html: string, fit = false) => { await act(async () => { root.render(<EmailFrame html={html} fit={fit} />) }) }
const state = () => ({ shown: wrap().style.height, frame: iframe().style.height, state: wrap().getAttribute('data-email-frame'), scrolling: iframe().getAttribute('scrolling') })

// ═══════════════════════════ 1. the height ═══════════════════════════════

describe('a short email’s preview is the height of the email, not 1,100', () => {
  for (const [name, h] of [['the sample email', 779], ['a two-line email', 549], ['Rounded’s sample', 927]] as const) {
    it(`${name}: ${h}px tall, shown ${h}px — no padding`, async () => {
      await show('<p>x</p>')
      const doc = fakeDoc(iframe(), h)
      await load(doc)
      expect(state()).toEqual({ shown: `${h}px`, frame: `${h}px`, state: 'measured', scrolling: 'no' })
    })
  }
  it('an email taller than 1,100 is its own height too, as it always was', async () => {
    await show('<p>x</p>')
    await load(fakeDoc(iframe(), 2059))
    expect(state().frame).toBe('2059px')
  })
  it('the reading is the body’s, in the source', () => {
    const src = read('components/settings/EmailsScreen.jsx')
    const fn = src.slice(src.indexOf('export function EmailFrame('), src.indexOf('export function EmailStyleSection('))
    expect(fn).toContain('const h = doc && doc.body ? doc.body.scrollHeight : 0')
    // the root's reading survives only on the look cards' own branch
    expect(fn.split('documentElement.scrollHeight').length - 1).toBe(1)
    expect(fn.indexOf('documentElement.scrollHeight')).toBeLessThan(fn.indexOf('measure()\n'))
    expect(fn.indexOf('if (fit) {')).toBeLessThan(fn.indexOf('documentElement.scrollHeight'))
  })
})

describe('a short email shown after a long one in the same frame shrinks to fit', () => {
  it('long, then short: the same iframe, re-read on its next load, comes down', async () => {
    await show('<p>long</p>')
    const el = iframe()
    await load(fakeDoc(el, 2059))
    expect(state().frame).toBe('2059px')
    await show('<p>short</p>')                       // new srcDoc → the frame reloads
    expect(iframe()).toBe(el)                        // the SAME frame, still 2,059 tall when it is asked
    expect(el.getAttribute('srcdoc')).toBe('<p>short</p>')
    await load(fakeDoc(el, 549))
    expect(state()).toEqual({ shown: '549px', frame: '549px', state: 'measured', scrolling: 'no' })
  })
  it('…and back up again', async () => {
    await show('a'); await load(fakeDoc(iframe(), 549))
    await show('b'); await load(fakeDoc(iframe(), 1198))
    expect(state().frame).toBe('1198px')
  })
})

describe('it is re-read when the content changes after load', () => {
  it('the body changing size (a late image, a late font): the frame follows, up and down', async () => {
    await show('<p>x</p>')
    const doc = fakeDoc(iframe(), 594)                // images not in yet
    await load(doc)
    expect(state().frame).toBe('594px')
    const watching = observers.filter(o => o.targets.includes(doc.body))
    expect(watching.length).toBe(1)
    doc.body!.scrollHeight = 779                      // the band and the logo arrive
    await act(async () => { watching[0].cb() })
    expect(state().frame).toBe('779px')
    doc.body!.scrollHeight = 700
    await act(async () => { watching[0].cb() })
    expect(state().frame).toBe('700px')
  })
  it('an image inside finishing its load re-reads too', async () => {
    await show('<p>x</p>')
    const doc = fakeDoc(iframe(), 594)
    await load(doc)
    expect(doc.listeners.load.length).toBe(1)
    doc.body!.scrollHeight = 779
    await act(async () => { doc.listeners.load[0]() })
    expect(state().frame).toBe('779px')
  })
  it('a new email stops watching the old one’s body and watches the new one', async () => {
    await show('a')
    const first = fakeDoc(iframe(), 600); await load(first)
    await show('b')
    const second = fakeDoc(iframe(), 800); await load(second)
    expect(observers.find(o => o.targets.includes(first.body))!.disconnected).toBe(true)
    expect(observers.find(o => o.targets.includes(second.body))!.disconnected).toBe(false)
  })
})

describe('when the height cannot be read, no number is invented', () => {
  it('before its first reading: 700px and scrolling — not 1,100', async () => {
    await show('<p>x</p>')
    expect(EMAIL_FRAME_UNMEASURED_PX).toBe(700)
    expect(state()).toEqual({ shown: '700px', frame: '700px', state: 'unmeasured', scrolling: 'auto' })
  })
  for (const [name, doc] of [['the document cannot be reached', null], ['reading it throws', 'throws'], ['it has no body', 'nobody'], ['the body reads as zero', 'zero']] as const) {
    it(`${name}: 700px, scrolling, marked unmeasured — the whole email stays reachable`, async () => {
      await show('<p>x</p>')
      await load(doc === 'nobody' ? fakeDoc(iframe(), null) : doc === 'zero' ? fakeDoc(iframe(), 0) : (doc as any))
      expect(state()).toEqual({ shown: '700px', frame: '700px', state: 'unmeasured', scrolling: 'auto' })
    })
  }
  it('a reading that fails AFTER a good one does not keep the stale height', async () => {
    await show('a'); await load(fakeDoc(iframe(), 2059))
    await show('b'); await load('throws')
    expect(state()).toEqual({ shown: '700px', frame: '700px', state: 'unmeasured', scrolling: 'auto' })
  })
  it('1,100 is gone from the full-size preview', () => {
    const src = read('components/settings/EmailsScreen.jsx')
    const fn = src.slice(src.indexOf('export function EmailFrame('), src.indexOf('export function EmailStyleSection('))
    expect(fn.match(/1100/g)).toEqual(['1100'])       // the look cards' starting height, and only that
    expect(fn).toContain('React.useState(fit ? 1100 : null)')
  })
})

describe('the five small look cards are unchanged', () => {
  // The same script run on main (969a658): mount the section, let every card
  // load with a browser-like document, take the whole row's markup. The email
  // inside each card is compared with the three image heights taken back out —
  // item 3's change, pinned on its own below.
  const cards = async (bodyHeights: number[]) => {
    await act(async () => { root.render(<EmailStyleSection style="soft" onPick={() => {}} />) })
    const frames = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[]
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      const doc = fakeDoc(f, bodyHeights[i])
      Object.defineProperty(f, 'contentDocument', { configurable: true, get: () => doc })
      await act(async () => { f.dispatchEvent(new Event('load')) })
    }
    const row = container.querySelector('[data-look-row]') as HTMLElement
    return { n: frames.length, html: withoutHeights(row.outerHTML.replace(/&quot;/g, '"').replace(/height=&quot;1[0-9]{2}&quot;/g, '')), heights: frames.map(f => [f.style.height, (f.parentElement as HTMLElement).style.height, f.getAttribute('scrolling'), (f.parentElement as HTMLElement).getAttribute('data-email-frame')]) }
  }
  it('with images in (every sample taller than 700): cropped at 700, exactly as before', async () => {
    const r = await cards([779, 779, 779, 927, 769])
    expect(r.n).toBe(5)
    expect(r.heights).toEqual(Array(5).fill(['1100px', '210px', 'no', null]))
    expect(sha(r)).toBe('edafc24fb3ec02d5')   // from main 969a658, same script
  })
  it('with images failing (samples shorter than 700): still exactly as before — left alone, as asked', async () => {
    const r = await cards([594, 594, 594, 597, 584])
    expect(r.heights).toEqual(Array(5).fill(['1100px', '210px', 'no', null]))
    expect(sha(r)).toBe('edafc24fb3ec02d5')   // from main 969a658, same script
  })
  it('a look card is never watched, never scrolls, never marked', async () => {
    await show('<p>x</p>', true)
    const doc = fakeDoc(iframe(), 779)
    await load(doc)
    expect(observers.filter(o => o.targets.includes(doc.body))).toEqual([])
    expect(doc.listeners.load).toBeUndefined()
    expect(state()).toEqual({ shown: '210px', frame: '1100px', state: null, scrolling: 'no' })
  })
})

// ═══════════════════ 3. the sent email: image heights only ════════════════

const BODY = 'Jordan,\n\nThank you for reaching out!\n\nA 30-minute video or phone call.'
const ctx = (style: string, over: any = {}) => ({ location_name: 'Central Denver', location_phone: '(303) 555-0142', reviews_link: 'https://g.page/r/x', style, heading: 'Thank you for reaching out!', button: { label: 'Book a Discovery Call', href: 'https://beeorganized.com' }, ...over })
const FOOTER = buildMarketingFooter({ unsubscribeUrl: 'https://beehive.beeorganized.com/unsubscribe/abc123', postalAddress: '123 Main St, Kansas City, MO 64111', audience: 'inquiry' })
const sentCases = () => {
  const out: Record<string, string> = {}
  for (const s of EMAIL_STYLES.map((x: any) => x.id)) {
    out[`${s}/drip`] = buildBrandedDripHtml(BODY, ctx(s) as any)
    out[`${s}/commercial`] = buildBrandedDripHtml(BODY, ctx(s) as any, FOOTER)
    out[`${s}/bare`] = buildBrandedDripHtml('Hi.', ctx(s, { heading: null, button: null, reviews_link: null, location_phone: null }) as any)
    out[`${s}/shell`] = buildBrandedShellHtml('<p>New lead</p>', 'Bee Organized', '', { style: s, heading: 'New lead' })
  }
  return out
}

describe('the sent email is what it was on main, apart from three image heights', () => {
  it('every look, drip / commercial / bare / notification shell: with the heights taken back out, byte for byte main’s', () => {
    const cases = sentCases()
    expect(Object.keys(cases).length).toBe(20)
    expect(sha(Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, sha(withoutHeights(v))])))).toBe('247c0183cb70b2b2')   // from main 969a658, same script
  })
  it('…and the heights are exactly: one per band, one on the logo, each the artwork’s own proportion', () => {
    expect([EMAIL_HONEYCOMB_HEIGHT, DRIP_LOGO_HEIGHT]).toEqual([150, 51])       // 1200×300 → 600×150; 300×211 → 72×51
    for (const [k, html] of Object.entries(sentCases())) {
      const bands = k.startsWith('rounded/') ? 2 : 1
      expect(html.split(' width="600" height="150" alt=""').length - 1, k).toBe(bands)
      expect(html.split(' width="72" height="51" alt="Bee Organized"').length - 1, k).toBe(1)
      expect(html.length - withoutHeights(html).length, k).toBe(bands * ' height="150"'.length + ' height="51"'.length)
      // every one still scales: height:auto stays in the style, so the attribute is only a shape hint
      for (const img of html.match(/<img [^>]*>/g)!.filter(t => /width="(600|72)"/.test(t))) expect(img, k).toContain('height:auto;')
    }
  })
  it('no image in the layout is left with a width and no height', () => {
    for (const [k, html] of Object.entries(sentCases())) {
      for (const img of html.match(/<img [^>]*>/g)!) expect(img, k).toMatch(/ width="\d+" height="\d+" /)
    }
  })
  it('the plain-text half and the unsubscribe block are untouched', () => {
    const texts = Object.fromEntries(EMAIL_STYLES.map((x: any) => [x.id, [buildBrandedDripText(BODY, ctx(x.id) as any), buildBrandedDripText(BODY, ctx(x.id) as any, FOOTER)]]))
    expect(sha({ texts, FOOTER })).toBe('66b5f42b93ba0f31')   // from main 969a658, same script
  })
})

describe('nothing about what is sent changes because of the preview', () => {
  it('the files that build and send an email are byte for byte main’s — all but the two this change names', () => {
    const files = ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'lib/marketing-unsubscribe.ts', 'lib/booking-link.ts', 'lib/rate-guard.ts', 'lib/email-signature.ts', 'lib/resend.ts', 'app/api/emails/test-send/route.ts', 'app/api/cron/send-drips/route.ts']
    expect(sha(Object.fromEntries(files.map(f => [f, sha(read(f))])))).toBe('33fa2be6cafc2c58')   // was 45a3bbde79ea16f8 until 2026-11-13 (booking links): the held-email reason now names the box that is blank — lib/booking-link.ts swapped one fixed sentence for missingBookingLinkMessage(), and lib/drip-send.ts calls it with the same links the guard just read. Checked by diff: the guard, what is sent and when are unchanged; lib/booking-link.test.ts pins the new sentence. Before that: was 04070b0206a5984a on main 969a658. ONE sentence changed since, in lib/drip-send.ts (Settings slice 2, 2026-11-13): the held-email reason stopped sending owners to "Settings → New leads", a section that no longer exists. Checked by diff when it was made: that one line is the file's only difference.
  })
  it('lib/marketing-consent.ts gained one list and lost nothing: with it taken out the file is main’s', () => {
    const src = read('lib/marketing-consent.ts')
    const a = src.indexOf('// WHICH EMAILS CARRY IT'), b = src.indexOf('export function buildMarketingFooter(')
    expect(a).toBeGreaterThan(0)
    expect(sha(src.slice(0, a) + src.slice(b))).toBe('fbe03e19bc7817eb')   // from main 969a658, same script
  })
  it('lib/drip-email-layout.ts: with the heights and their note taken out, the file is main’s', () => {
    const src = read('lib/drip-email-layout.ts')
    const a = src.indexOf('// IMAGE HEIGHTS, AS ATTRIBUTES'), b = src.indexOf('export const resolveHoneycombUrl')
    const back = (src.slice(0, a) + src.slice(b)).replace(/ height="\$\{EMAIL_HONEYCOMB_HEIGHT\}"/g, '').replace(' height="${DRIP_LOGO_HEIGHT}"', '')
    expect(sha(back)).toBe('a082bf9c1e160398')   // from main 969a658, same script
  })
})

// ═════════════════ 2. the preview shows the whole email ═══════════════════

const values = { first_name: 'Jordan', location_name: 'Central Denver', location_phone: '(303) 555-0142', reviews_link: null }
const row = (over: any = {}) => ({ subject: 'Welcome, {{first_name}}', body: 'Hi {{first_name}},\n\nThanks for getting in touch.', buttonText: '', buttonLink: '', ...over })

describe('the preview of a commercial email ends the way the sent one does', () => {
  it('the three commercial emails are the three the sends treat as commercial', () => {
    expect(COMMERCIAL_EMAIL_AUDIENCE).toEqual({ welcome: 'inquiry', opp_closed_job_3mo: 'client', opp_closed_job_12mo: 'client' })
    const testSend = read('app/api/emails/test-send/route.ts')
    expect(testSend).toContain("const COMMERCIAL_TEMPLATE_KEYS = new Set(['welcome', 'opp_closed_job_3mo', 'opp_closed_job_12mo'])")
    expect(testSend).toContain("audience: source.render === 'welcome' ? 'inquiry' : 'client',")
    const stage = read('lib/stage-emails.ts')
    expect(stage).toContain('const COMMERCIAL_STAGE_EMAIL_KEYS = new Set(CLOSED_WON_TRIGGERS.map(t => t.key))')
    expect(stage.slice(stage.indexOf('const CLOSED_WON_TRIGGERS'), stage.indexOf(']', stage.indexOf('const CLOSED_WON_TRIGGERS: StageTrigger[] = [') + 50)).match(/key: '([a-z0-9_]+)'/g)).toEqual(["key: 'opp_closed_job_3mo'", "key: 'opp_closed_job_12mo'"])
    expect(read('lib/welcome-email.ts')).toContain("buildCanSpamFooter({ leadId: lead.id, audience: 'inquiry' })")
  })

  for (const [key, why] of [['welcome', 'You’re receiving this because you inquired about Bee Organized.'], ['opp_closed_job_3mo', null], ['opp_closed_job_12mo', null]] as const) {
    it(`${key}: the block is there, inside the white card, built by the sends’ own function`, () => {
      const r = row({ templateKey: key })
      const html = previewEmailHtml({ row: r, style: 'soft', values, postalAddress: '123 Main St, Kansas City, MO 64111' })
      const footer = buildMarketingFooter({ unsubscribeUrl: previewCardFooter(r, 'x').html.match(/href="([^"]+)"/)![1], postalAddress: '123 Main St, Kansas City, MO 64111', audience: COMMERCIAL_EMAIL_AUDIENCE[key] })
      // exactly what a send builds for it: the same layout call, with the footer
      expect(html).toBe(buildBrandedDripHtml('Hi Jordan,\n\nThanks for getting in touch.', { location_name: 'Central Denver', location_phone: '(303) 555-0142', reviews_link: null, signature: null, style: 'soft', heading: 'Welcome, Jordan', button: null } as any, footer))
      expect(html).toContain('class="bo-card-footer')
      expect(html).toContain('>Unsubscribe</a> at any time')
      expect(html).toContain('Bee Organized &middot; 123 Main St, Kansas City, MO 64111')
      if (why) expect(html.replace(/&#39;/g, '’')).toContain(why.replace('’', '’'))
      // …and it comes before the location line under the card, not after the document
      expect(html.indexOf('bo-card-footer')).toBeLessThan(html.indexOf('Bee Organized Central Denver'))
    })
  }

  it('nothing is invented: no client means a link that goes nowhere, and no configured address means it says so', () => {
    const f = previewCardFooter(row({ templateKey: 'welcome' }), null)
    expect(f.html).toContain('/unsubscribe/test-email"')
    expect(f.html).toContain('Bee Organized &middot; (your postal address)')
    expect(previewCardFooter(row({ templateKey: 'welcome' }), '   ').html).toContain('(your postal address)')
    // the same two stand-ins the test send uses
    const testSend = read('app/api/emails/test-send/route.ts')
    expect(testSend).toContain('unsubscribeUrl: `${base}/unsubscribe/test-email`,')
    expect(testSend).toContain("|| '(your postal address)',")
  })

  it('a drip email carries no such block when sent, so its preview has none — and is main’s preview, image heights aside', () => {
    for (const r of [row(), row({ templateKey: null }), row({ templateKey: 'some_other_template' }), row({ templateKey: 'opp_organizing_estimate_3d' })]) {
      expect(previewCardFooter(r, '123 Main St')).toBeNull()
      expect(previewEmailHtml({ row: r, style: 'soft', values, postalAddress: '123 Main St' })).not.toContain('bo-card-footer')
    }
    const previews = Object.fromEntries(EMAIL_STYLES.map((x: any) => [x.id, sha(withoutHeights(previewEmailHtml({ row: row({ buttonText: 'Book', buttonLink: 'https://x.com/{{first_name}}' }), style: x.id, values })))]))
    expect(sha(previews)).toBe('850f3c5bb64321d0')   // from main 969a658, same script
    expect(sha(Object.fromEntries(EMAIL_STYLES.map((x: any) => [x.id, sha(withoutHeights(sampleEmailHtml(x.id)))])))).toBe('af505ea77b6077e8')   // from main 969a658, same script
  })

  it('the editor’s preview of the welcome knows which email it is', () => {
    const src = read('components/BeeHub.jsx')
    expect(src.split('templateKey: row.templateKey }} />').length - 1).toBe(1)
    expect(src).toContain('postalAddress: preview.postalAddress })} />')
    expect(read('components/settings/EmailsScreen.jsx')).toContain('signature: ctx.signature, postalAddress: ctx.postalAddress })} />')
  })

  describe('the address comes from the server, read-only', () => {
    const get = () => emailSettingsGET(new Request('http://x/api/locations/loc/email-settings') as any, { params: { id: 'loc' } })
    const old = process.env.MARKETING_POSTAL_ADDRESS
    afterEach(() => { if (old === undefined) delete process.env.MARKETING_POSTAL_ADDRESS; else process.env.MARKETING_POSTAL_ADDRESS = old })
    it('GET …/email-settings carries the configured address, trimmed', async () => {
      process.env.MARKETING_POSTAL_ADDRESS = '  123 Main St, Kansas City, MO 64111 '
      const j = await (await get()).json()
      expect(j.postalAddress).toBe('123 Main St, Kansas City, MO 64111')
      expect(Object.keys(j).sort()).toEqual(['postalAddress', 'ready', 'settings'])
    })
    it('…and null when it is not configured — never a made-up one', async () => {
      delete process.env.MARKETING_POSTAL_ADDRESS
      expect((await (await get()).json()).postalAddress).toBeNull()
      process.env.MARKETING_POSTAL_ADDRESS = '   '
      expect((await (await get()).json()).postalAddress).toBeNull()
    })
  })
})
