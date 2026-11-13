// @vitest-environment happy-dom
//
// THE BOOKING LINKS NO EMAIL USES ARE REACHABLE (2026-11-13).
//
// An owner at Portland saved a discovery call link and picked a look from a
// sample showing a "Book a Discovery Call" button. She got neither: no email
// anywhere used the discovery or video link, and no email had a button. Both
// settings saved correctly and did nothing. Her second test email was then
// held for a blank in-home link, and the message sent her to Settings →
// Profile → Booking Link, which does not release that email.
//
// Pinned here:
//   • a link no email uses says so, with the way out; a used one says nothing
//   • the way out opens "Which email?", then that email's own editor with the
//     link's button picked as a DRAFT — nothing is written until Save
//   • an email that already has a button keeps it
//   • the look section says when no email has a button, and only then
//   • the same-address warning fires on Portland's exact values
//   • the hold message names the field that actually releases the email
//   • no master wording, drip step or email body changes — by fingerprint
//   • opened the old way, both editors are exactly as they were
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { expandAllEmailGroups } from './emails-test-helpers'

const h = vi.hoisted(() => {
  const LOC_ID = '2b3c4d5e-1111-4222-8333-444455556666'
  const from = () => {
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'insert']) b[m] = () => b
    b.maybeSingle = () => Promise.resolve({ data: { id: 'u1', role: 'owner', location_id: LOC_ID }, error: null })
    b.single = b.maybeSingle
    b.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
    return b
  }
  return { from, LOC_ID }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => h.from() } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'auth-1' } }, error: null }) }, from: () => h.from() }),
}))
vi.mock('@/lib/auth', () => ({ isAdmin: (r: string) => r === 'super_admin' || r === 'admin', requireAuth: vi.fn(async () => ({})), getHubUser: vi.fn(async () => ({ role: 'owner', location_id: h.LOC_ID })) }))

import * as BeeHubModule from '@/components/BeeHub'
import * as EmailsScreenModule from '@/components/settings/EmailsScreen'
import { blockedOnMissingBookingLink, missingBookingLinkMessage } from './booking-link'
import { buildBrandedDripHtml, buildBrandedDripText, EMAIL_STYLES } from './drip-email-layout'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// Both are untyped JavaScript: taken as one value each so this file adds
// nothing to the project's type-error count.
const { SettingsScreen, DripPathStepEditor, EmailTemplateEditor } = BeeHubModule as any
const { EmailDetailsSection, EmailStyleSection, AddButtonDialog, linkUsage, sameAddressFields, sameAddressWarning, startButtonDraft } = EmailsScreenModule as any

// Portland, as production held it on 13 Nov 2026.
const IN_HOME = 'https://calendar.app.google/5bk5TcMVfkixPaBV7'
const DISCOVERY = 'https://calendar.app.google/rCoh7DkvGgZYX6fg9'
const OWN = 'https://calendar.app.google/rCoh7DkvGgZYX6fg9'

const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16)

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const click = async (el: Element | undefined | null) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => { (el as HTMLElement).click() })
  for (let i = 0; i < 4; i++) await act(async () => {})
}
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const dialog = (label: string) => q(`[role="dialog"][aria-label="${label}"]`)
const button = (label: string, within: ParentNode = document) =>
  Array.from(within.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === label) as HTMLElement | undefined
const pillOn = (within: ParentNode) => (within.querySelector('[data-button-pill][aria-checked="true"]') as HTMLElement | null)?.getAttribute('data-button-pill')

// ── the rules, on their own ───────────────────────────────────────────────
describe('which links a location’s emails use', () => {
  const rows = [
    { subject: 'Thank you', body: 'Schedule here: ({{book_assessment_link}})', buttonText: '', buttonLink: '' },
    { subject: 'Following up', body: 'click here ({{booking_link}})', buttonText: '', buttonLink: '' },
    { subject: 'Welcome', body: 'Hello', buttonText: '', buttonLink: '' },
  ]
  it('counts the in-home link under both of its tags, and nothing for the two no email uses', () => {
    expect(linkUsage(rows)).toEqual({ discovery: 0, inHome: 2, video: 0, buttons: 0 })
  })
  it('a button’s link counts as a use, and a button needs both its words and its link', () => {
    expect(linkUsage([...rows, { subject: 'x', body: 'y', buttonText: 'Book a Discovery Call', buttonLink: '{{discovery_booking_link}}' }]))
      .toEqual({ discovery: 1, inHome: 2, video: 0, buttons: 1 })
    expect(linkUsage([{ subject: 'x', body: 'y', buttonText: '', buttonLink: '{{virtual_booking_link}}' }]).buttons).toBe(0)
  })
  it('a link in the wording counts too, and a removed email does not', () => {
    expect(linkUsage([{ subject: 'x', body: 'Video: {{virtual_booking_link}}' }]).video).toBe(1)
    expect(linkUsage([{ subject: 'x', body: 'Video: {{virtual_booking_link}}', removed: true }]).video).toBe(0)
  })
})

describe('two boxes holding the same address', () => {
  it('fires on Portland’s exact values: her own link and the discovery link are one address', () => {
    const same = sameAddressFields({ inHome: IN_HOME, discovery: DISCOVERY, video: null, own: OWN })
    expect(same).toEqual({ discovery: ['own'], own: ['discovery'] })
    expect(sameAddressWarning('discovery', same.discovery))
      .toBe('This is the same address as your own booking link in Settings → Profile. If they are booked on different pages, one of them has the wrong address.')
  })
  it('fires when the in-home and discovery boxes match, however the address was typed', () => {
    const same = sameAddressFields({ inHome: 'https://Calendar.app.google/rCoh7DkvGgZYX6fg9/', discovery: 'http://calendar.app.google/rcoh7dkvggzyx6fg9', video: '', own: '' })
    expect(same.inHome).toEqual(['discovery'])
    expect(same.discovery).toEqual(['inHome'])
  })
  it('says nothing for three different addresses, or for blanks', () => {
    expect(sameAddressFields({ inHome: IN_HOME, discovery: DISCOVERY, video: 'https://calendly.com/v', own: '' })).toEqual({})
    expect(sameAddressFields({ inHome: '', discovery: '', video: null, own: undefined })).toEqual({})
  })
})

// ── Your details ──────────────────────────────────────────────────────────
describe('Your details: the three links', () => {
  const render = async (over: any = {}) => {
    const onAddButton = vi.fn()
    await act(async () => {
      root.render(<EmailDetailsSection rate="" calendarLink={IN_HOME} reviewsLink="https://g.page/r/x"
        options={{ discoveryBookingLink: DISCOVERY, virtualBookingLink: '' }} ready={{ links: true, style: true }}
        counts={{ rate: 0, discoveryBooking: 0, booking: 6, virtualBooking: 0, reviews: 2 }} waiting={{}} nothingWaiting
        onSaveLocation={async () => null} onSaveOption={async () => null}
        variant={{ split: false, sequences: [{ key: 'both', label: null, rate: false, link: true }] }} onVariant={async () => null}
        usage={{ inHome: 6, discovery: 0, video: 0, buttons: 0 }} ownBookingLink="" onAddButton={onAddButton} {...over} />)
    })
    return onAddButton
  }
  const field = (id: string) => container.querySelector(`[data-link-field="${id}"]`) as HTMLElement

  it('a saved link no email uses says so and offers the way out; the used one says nothing', async () => {
    const onAddButton = await render()
    const unused = container.querySelector('[data-link-unused="discovery"]') as HTMLElement
    expect(unused.textContent).toBe('Saved, but none of your emails use it yet.Add it to an email')
    expect(container.querySelector('[data-link-unused="inHome"]')).toBeNull()
    expect(field('inHome').textContent).toContain('Used in 6 emails')
    await click(container.querySelector('[data-add-button="discovery"]'))
    expect(onAddButton.mock.calls).toEqual([['discovery']])
  })
  it('a blank link is not "unused" — there is nothing saved to use', async () => {
    await render()
    expect(container.querySelector('[data-link-unused="video"]')).toBeNull()
    expect(field('video').textContent).toContain('Optional')
  })
  it('once an email uses it, the line goes', async () => {
    await render({ usage: { inHome: 6, discovery: 1, video: 0, buttons: 1 } })
    expect(container.querySelector('[data-link-unused="discovery"]')).toBeNull()
    expect(field('discovery').textContent).toContain('Used in 1 email')
    expect(field('discovery').textContent).not.toContain('Used in 1 emails')
  })
  it('the in-home link comes first, then discovery, video, and reviews last', async () => {
    await render()
    const ids = Array.from(container.querySelectorAll('input[id^="field-"]')).map(i => i.id)
    expect(ids).toEqual(['field-booking', 'field-discovery-booking', 'field-virtual-booking', 'field-reviews'])
  })
  it('each link says what it is for', async () => {
    await render()
    expect(field('inHome').textContent).toContain('The link in the emails we write for you')
    expect(field('discovery').textContent).toContain('For a phone or video chat before an assessment')
    expect(field('video').textContent).toContain('For an assessment done over video')
  })
  it('the two sentences that were false are gone', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).not.toContain('These are written into your emails for you')
    expect(text).not.toContain('Emails include your booking links')
    expect(text).toContain('Your emails include your in-home assessment link.')
    expect(text).toContain('The discovery call and video assessment links are only used in an email you add a button for.')
  })
  it('Portland’s exact case shows the warning under the discovery link, and nowhere else', async () => {
    await render({ ownBookingLink: OWN })
    const warn = Array.from(container.querySelectorAll('[data-same-address]'))
    expect(warn.map(w => w.getAttribute('data-same-address'))).toEqual(['discovery'])
    expect(warn[0].textContent).toContain('the same address as your own booking link in Settings → Profile')
  })
  it('the same address in the in-home and discovery boxes warns under both', async () => {
    await render({ calendarLink: DISCOVERY })
    expect(Array.from(container.querySelectorAll('[data-same-address]')).map(w => w.getAttribute('data-same-address'))).toEqual(['inHome', 'discovery'])
  })
  it('while the emails are not known (still loading) nothing is called unused, and no count is invented', async () => {
    await render({ usage: null })
    expect(container.querySelector('[data-link-unused]')).toBeNull()
    expect(field('discovery').textContent).not.toContain('Used in')
    expect(field('inHome').textContent).not.toContain('Used in')
  })
})

// ── the look ──────────────────────────────────────────────────────────────
describe('How your emails look', () => {
  const render = async (props: any) => { await act(async () => { root.render(<EmailStyleSection style="rounded" onPick={() => {}} {...props} />) }) }
  it('says so when none of the location’s emails has a button, with the way to add one', async () => {
    const onAddButton = vi.fn()
    await render({ buttonCount: 0, onAddButton })
    expect(container.querySelector('[data-no-buttons]')!.textContent).toContain('None of your emails has a button yet.')
    await click(container.querySelector('[data-add-button="look"]'))
    expect(onAddButton.mock.calls).toEqual([[null]])
  })
  it('says nothing once one email has a button, or when the count is not known', async () => {
    await render({ buttonCount: 1, onAddButton: vi.fn() })
    expect(container.querySelector('[data-no-buttons]')).toBeNull()
    await render({})
    expect(container.querySelector('[data-no-buttons]')).toBeNull()
    expect(container.querySelector('[data-add-button]')).toBeNull()
  })
})

// ── the editors, opened from "Which email?" ───────────────────────────────
describe('the draft button an editor opens with', () => {
  it('an email with no button gets the link picked and its usual words', () => {
    expect(startButtonDraft('', '', 'discovery')).toEqual({ text: 'Book a Discovery Call', link: '{{discovery_booking_link}}', picked: true })
    expect(startButtonDraft('', '', 'video')).toEqual({ text: 'Book a Video Assessment', link: '{{virtual_booking_link}}', picked: true })
  })
  it('an email that already has a button keeps it', () => {
    expect(startButtonDraft('Book Your Assessment', '{{book_assessment_link}}', 'discovery'))
      .toEqual({ text: 'Book Your Assessment', link: '{{book_assessment_link}}', picked: false })
  })
  it('opened the old way, or from the look section, nothing is picked', () => {
    expect(startButtonDraft('', '', null)).toEqual({ text: '', link: '', picked: false })
    expect(startButtonDraft('', '', 'pick')).toEqual({ text: '', link: '', picked: false })
  })

  const step = { step_order: 1, subject: 'Thank you', body: 'Hello', delay_days: 0, button_text: '', button_link: '', button_align: null }
  const links = { discovery: DISCOVERY, inHome: IN_HOME, video: '' }
  it('the drip editor without startButton is as it was: no note, None chosen', async () => {
    await act(async () => { root.render(<DripPathStepEditor step={step} onSave={vi.fn()} onClose={() => {}} links={links} />) })
    expect(q('[data-start-button-note]')).toBeNull()
    expect(pillOn(document)).toBe('none')
  })
  it('the job follow-up editor without startButton is as it was, and Save stays off until something changes', async () => {
    const row = { subject: 'We hope', body: 'Hello', buttonText: '', buttonLink: '', when: 'Day 30' }
    await act(async () => { root.render(<EmailTemplateEditor row={row} onCancel={() => {}} onSave={vi.fn()} links={links} />) })
    expect(q('[data-start-button-note]')).toBeNull()
    expect(pillOn(document)).toBe('none')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
  })
  it('the job follow-up editor with startButton saves the button and leaves the wording alone', async () => {
    const row = { subject: 'We hope', body: 'Hello', buttonText: '', buttonLink: '', when: 'Day 30' }
    const onSave = vi.fn(async () => {})
    await act(async () => { root.render(<EmailTemplateEditor row={row} onCancel={() => {}} onSave={onSave} links={links} startButton="discovery" />) })
    expect(pillOn(document)).toBe('discovery')
    expect(q('[data-start-button-note]')!.textContent).toContain('We’ve set the button to your discovery call link.')
    expect(onSave).not.toHaveBeenCalled()
    await click(button('Save'))
    expect(onSave.mock.calls).toEqual([['We hope', 'Hello', { button_text: 'Book a Discovery Call', button_link: '{{discovery_booking_link}}', button_align: null }]])
  })
})

describe('Which email?', () => {
  const rows = [
    { key: 'a', subject: 'Thank you for reaching out!', when: 'Straight away', group: 'When someone new gets in touch', buttonText: '', buttonLink: '' },
    { key: 'b', subject: 'Still interested?', when: 'Day 30', group: 'When someone new gets in touch', buttonText: 'Book Your Assessment', buttonLink: '{{book_assessment_link}}' },
  ]
  it('names the link, lists the emails, says which already has a button, and hands back the one picked', async () => {
    const onPick = vi.fn()
    await act(async () => { root.render(<AddButtonDialog linkId="discovery" rows={rows} onPick={onPick} onClose={() => {}} />) })
    const d = dialog('Add a button to an email')!
    expect(d.textContent).toContain('Which email should offer your discovery call link?')
    expect(d.textContent).toContain('Nothing changes until you press Save there.')
    expect(d.querySelector('[data-add-button-row="b"]')!.textContent).toContain('already has a button: “Book Your Assessment”')
    expect(d.querySelector('[data-add-button-row="a"]')!.textContent).not.toContain('already has a button')
    await click(d.querySelector('[data-add-button-row="a"]'))
    expect(onPick.mock.calls.map(c => c[0].key)).toEqual(['a'])
  })
})

// ── the whole way through, on the real screen ─────────────────────────────
describe('from the unused link to a saved button, on the Emails screen', () => {
  const LOC = h.LOC_ID
  const selectedLoc = () => ({
    id: LOC, name: 'Portland', address: '1 Main', phone: '(503) 555-0100',
    bookingLink: IN_HOME, reviewsLink: 'https://g.page/r/pdx', ratePerHour: '',
    serviceRadius: '25 miles', timezone: 'America/Los_Angeles', assessmentType: 'in-person', smsEnabled: false,
    jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
    sendFromName: 'Bee PDX', sendFromEmail: 'pdx@beeorganized.com', replyToEmail: 'pdx@beeorganized.com',
  })
  const step = (id: string, order: number, days: number, subject: string, extra: any = {}) =>
    ({ id, step_order: order, delay_days: days, channel: 'email', subject, body: `${subject}. Schedule here: ({{book_assessment_link}})`, master_template_id: null, origin: 'master', is_active: true, ...extra })
  const pathRow = (key: string, word: string, extra: any = {}) => ({
    id: `path-${key}`, path_key: key, name: key, is_default: true, location_uuid: LOC,
    steps: [step(`${key}-1`, 1, 0, `${word} one`, extra), step(`${key}-2`, 2, 5, `${word} two`), step(`${key}-3`, 3, 30, `${word} three`)],
  })
  const masterRow = (key: string, word: string) => ({ ...pathRow(key, `Master ${word}`), id: `master-${key}`, location_uuid: null })
  let server: { paths: any[]; masters: any[] }
  let fetchMock: ReturnType<typeof vi.fn>

  const mount = async (o: { owned?: string[]; firstStep?: any } = {}) => {
    const owned = o.owned ?? ['organizing-d', 'moving-d']
    server = {
      paths: owned.map(k => pathRow(k, k.startsWith('moving') ? 'Moving' : 'Organizing', k.startsWith('organizing') ? (o.firstStep || {}) : {})),
      masters: ['a', 'b', 'c', 'd'].flatMap(l => [masterRow(`organizing-${l}`, 'organizing'), masterRow(`moving-${l}`, 'moving')]),
    }
    fetchMock = vi.fn(async (url: string, opts?: any) => {
      const u = String(url)
      const ok = (j: any) => ({ ok: true, status: 200, json: async () => j })
      if (u === `/api/locations/${LOC}/drip-paths` && !opts?.method) return ok({ paths: server.paths, default_drip_path: 'organizing-d', default_move_drip_path: 'moving-d' })
      if (u === '/api/drip-paths/masters') return ok({ masters: server.masters })
      if (u === `/api/locations/${LOC}/email-settings` && !opts?.method) return ok({ settings: { style: 'rounded', discoveryBookingLink: DISCOVERY, virtualBookingLink: null }, ready: { style: true, links: true, align: true } })
      const m = u.match(/^\/api\/drip-paths\/([^/]+)\/steps$/)
      if (m && opts?.method === 'PATCH') {
        const p = server.paths.find(x => x.id === m[1])
        p.steps = JSON.parse(opts.body).steps.map((s: any, i: number) => ({ ...s, id: `saved-${i + 1}` }))
        return ok({ ok: true })
      }
      if (/active-lead-count$/.test(u)) return ok({ count: 0 })
      return ok({})
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => { root.render(<SettingsScreen selectedLoc={selectedLoc()} initialSection="emails" />) })
    for (let i = 0; i < 4; i++) await act(async () => {})
    await expandAllEmailGroups(container, act as any)
  }
  const writes = () => fetchMock.mock.calls.filter(([, o]: any[]) => o?.method && o.method !== 'GET').map(([u, o]: any[]) => `${o.method} ${String(u)}`)
  const stored = () => sha(JSON.stringify(server.paths.map(p => [p.id, p.steps])))
  const openChooser = async (from: string) => {
    await click(container.querySelector(`[data-add-button="${from}"]`))
    const d = dialog('Add a button to an email')!
    expect(d).toBeTruthy()
    return d
  }
  const pickFirst = async (d: HTMLElement) => {
    const first = Array.from(d.querySelectorAll('[data-add-button-row]')).find(b => (b.textContent ?? '').includes('Organizing one'))
    await click(first)
    expect(dialog('Add a button to an email')).toBeNull()
    return dialog('Edit step 1')!
  }

  it('the discovery link is called unused, the in-home one is not, and the look says no email has a button', async () => {
    await mount()
    expect(container.querySelector('[data-link-unused="discovery"]')).toBeTruthy()
    expect(container.querySelector('[data-link-unused="inHome"]')).toBeNull()
    // three organizing + three moving emails use the in-home link
    expect(container.querySelector('[data-link-field="inHome"]')!.textContent).toContain('Used in 6 emails')
    expect(container.querySelector('[data-no-buttons]')).toBeTruthy()
  })

  it('Add it to an email → Which email? → the editor with the discovery button picked; nothing is written, and Cancel leaves everything as it was', async () => {
    await mount()
    const before = stored()
    const d = await openChooser('discovery')
    // organizing and moving, three each
    expect(d.querySelectorAll('[data-add-button-row]').length).toBe(6)
    const ed = await pickFirst(d)
    expect(ed).toBeTruthy()
    expect(pillOn(ed)).toBe('discovery')
    expect((Array.from(ed.querySelectorAll('input[type="text"]')).pop() as HTMLInputElement).value).toBe('Book a Discovery Call')
    expect(ed.querySelector('[data-start-button-note]')!.textContent).toContain('We’ve set the button to your discovery call link.')
    expect(writes()).toEqual([])
    await click(button('Cancel', ed))
    expect(dialog('Edit step 1')).toBeNull()
    expect(writes()).toEqual([])
    expect(stored()).toBe(before)
    // and the email opened the ordinary way afterwards has no button waiting in it
    expect(container.querySelector('[data-link-unused="discovery"]')).toBeTruthy()
  })

  it('Save writes that one email’s button and no wording; the unused line and the look note then go', async () => {
    await mount()
    const bodiesBefore = server.paths.flatMap(p => p.steps.map((s: any) => [s.subject, s.body]))
    const ed = await pickFirst(await openChooser('discovery'))
    await click(button('Save', ed))
    expect(writes()).toEqual(['PATCH /api/drip-paths/path-organizing-d/steps'])
    const org = server.paths.find(p => p.path_key === 'organizing-d').steps
    expect(org.map((s: any) => [s.button_text ?? null, s.button_link ?? null])).toEqual([
      ['Book a Discovery Call', '{{discovery_booking_link}}'], [null, null], [null, null],
    ])
    expect(server.paths.flatMap(p => p.steps.map((s: any) => [s.subject, s.body]))).toEqual(bodiesBefore)
    for (let i = 0; i < 4; i++) await act(async () => {})
    expect(container.querySelector('[data-link-unused="discovery"]')).toBeNull()
    expect(container.querySelector('[data-no-buttons]')).toBeNull()
  })

  it('an email that already has a button opens with its own button, not this link', async () => {
    await mount({ firstStep: { button_text: 'Book Your Assessment', button_link: '{{book_assessment_link}}' } })
    const ed = await pickFirst(await openChooser('discovery'))
    expect(pillOn(ed)).toBe('inHome')
    expect(ed.querySelector('[data-start-button-note]')!.textContent).toContain('This email already has a button, so we’ve left it alone.')
    expect(writes()).toEqual([])
  })

  it('from the look section the editor opens at the button with nothing picked', async () => {
    await mount()
    const ed = await pickFirst(await openChooser('look'))
    expect(pillOn(ed)).toBe('none')
    expect(ed.querySelector('[data-start-button-note]')!.textContent).toBe('Choose what the button links to. Nothing changes until you press Save.')
    expect(writes()).toEqual([])
  })

  it('emails still on the Bee Organized wording ask before a copy is made — picking one writes nothing', async () => {
    await mount({ owned: [] })
    const d = await openChooser('discovery')
    const first = Array.from(d.querySelectorAll('[data-add-button-row]')).find(b => (b.textContent ?? '').includes('Master organizing one'))
    await click(first)
    expect(dialog('Edit step 1')).toBeNull()
    expect(document.body.textContent).toContain('Create my copy')
    expect(writes()).toEqual([])
  })
})

// ── the hold message ──────────────────────────────────────────────────────
describe('a held email names the box that releases it', () => {
  const tpl = (body: string) => ({ subject: 'Thank you', body })
  const none = { ownerBookingLink: null, locationCalendarLink: null, discoveryBookingLink: null, virtualBookingLink: null }
  it('Portland, 13 Nov: in-home tag, in-home box blank, the owner’s own link set → names the in-home box, not Profile', () => {
    const links = { ...none, ownerBookingLink: OWN, discoveryBookingLink: DISCOVERY }
    const t = tpl('Schedule here: ({{book_assessment_link}})')
    expect(blockedOnMissingBookingLink(t, links)).toBe(true)
    const msg = missingBookingLinkMessage(t, links)
    expect(msg).toBe('This email asks the client to click a booking link that is blank. Fill in the In-home assessment link in Settings → Emails → Your details. The email is held until then and goes out on its own once it is saved.')
    expect(msg).not.toContain('Profile')
  })
  it('names the discovery and video boxes for their tags', () => {
    expect(missingBookingLinkMessage(tpl('{{discovery_booking_link}}'), { ...none, locationCalendarLink: IN_HOME })).toContain('Fill in the Discovery call link in')
    expect(missingBookingLinkMessage(tpl('{{virtual_booking_link}} {{booking_link}}'), none)).toContain('Fill in the In-home assessment link and Video assessment link in')
  })
  it('only the assigned person’s tag is sent to Profile, with the in-home box as the other way', () => {
    const msg = missingBookingLinkMessage(tpl('{{owner_booking_link}}'), none)
    expect(msg).toContain('Settings → Profile → Booking Link')
    expect(msg).toContain('In-home assessment link in Settings → Emails')
  })
  it('every email the guard holds gets a named box, for every mix of tags and blanks', () => {
    const tags = ['{{book_assessment_link}}', '{{booking_link}}', '{{owner_booking_link}}', '{{discovery_booking_link}}', '{{virtual_booking_link}}']
    const keys = Object.keys(none) as (keyof typeof none)[]
    let held = 0
    for (let t = 1; t < 1 << tags.length; t++) for (let l = 0; l < 1 << keys.length; l++) {
      const body = tags.filter((_, i) => t & (1 << i)).join(' ')
      const links: any = Object.fromEntries(keys.map((k, i) => [k, l & (1 << i) ? 'https://x.example/y' : null]))
      if (!blockedOnMissingBookingLink(tpl(body), links)) continue
      held++
      expect(missingBookingLinkMessage(tpl(body), links)).toMatch(/In-home assessment link|Discovery call link|Video assessment link/)
      expect(missingBookingLinkMessage(tpl(body), links)).not.toContain('Check the links')
    }
    expect(held).toBeGreaterThan(100)
  })
})

// ── nothing that is sent changed ──────────────────────────────────────────
describe('no master wording, drip step or email body changed', () => {
  // The files the Bee Organized wording was seeded from. Taken at 4c956ba,
  // before this change; this change touches none of them.
  const SEEDS: Record<string, string> = {
    'seed_master_drip_paths.sql': 'e99fe439085bc668',
    'seed_returning_drip_path.sql': '59062314bd16cd84',
    'returning_drip_path_variants.sql': 'f76ba3017dddf0f3',
    'drips_infrastructure.sql': '7b59351ea82ccef8',
  }
  it('the seeded wording is byte for byte what it was', () => {
    for (const [file, want] of Object.entries(SEEDS)) {
      expect(`${file} ${sha(readFileSync(join(process.cwd(), 'migrations', file), 'utf8'))}`).toBe(`${file} ${want}`)
    }
  })
  it('an email with no button renders exactly as it did, in every look', () => {
    const body = 'Jordan,\n\nThank you for reaching out! Schedule here: (https://example.com/in-home)\n\nThank you,\nWhitney'
    const ctx = { location_name: 'Portland', location_phone: '(503) 555-0100', reviews_link: 'https://g.page/r/pdx', heading: 'Thank you for reaching out!' }
    const out = EMAIL_STYLES.map(s => `${s.id}:${sha(buildBrandedDripHtml(body, { ...ctx, style: s.id } as any))}:${sha(buildBrandedDripText(body, { ...ctx, style: s.id } as any))}`)
    expect(out).toEqual(RENDER_FINGERPRINTS)
  })
  it('the draft button is only ever handed to the two Emails editors', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    const mounts = src.split('\n').filter(l => /startButton=\{/.test(l)).map(l => l.trim())
    expect(mounts).toEqual([
      "<StartButtonNote startButton={startButton} picked={start.picked} hadButton={!!(row.buttonLink || '').trim()} />",
      'startButton={emailTemplateEditor.startButton || null}',
      'startButton={stepContentEditor.startButton || null}',
      "<StartButtonNote startButton={startButton} picked={start.picked} hadButton={!!(step.button_link || '').trim()} />",
    ])
  })
})
// Taken on 4c956ba, before this change, and again after it: the same. (Soft,
// Outline and Bold are one email when there is no button — the look only
// reaches the button, which is the fault this file is about.)
const RENDER_FINGERPRINTS: string[] = [
  'soft:dffd0261320b5d74:2a9a6086e364a014', 'outline:dffd0261320b5d74:2a9a6086e364a014', 'bold:dffd0261320b5d74:2a9a6086e364a014',
  'rounded:ce88493c0f0fa4a3:2a9a6086e364a014', 'classic:280a9800ef12867d:2a9a6086e364a014',
]
