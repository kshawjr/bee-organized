// @vitest-environment happy-dom
//
// FL-75 slice 5 (2026-11-24) — the "Who goes to Mailchimp" screen itself
// (components/settings/MailchimpReviewScreen.jsx), mounted for real:
//   • the big number comes first and moves as the owner ticks
//   • archived people are in the list without any filter, unticked, with the day
//   • people who said no are not in the list at all — there is no box to tick
//   • a phone match is asked one at a time; "same" changes only the count
//   • every tick is sent to the screen's own route, and a reload shows it back
//   • nothing else is called — no Sync now, no Mailchimp
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import MailchimpReviewScreen from '@/components/settings/MailchimpReviewScreen'
import { buildReview, type ReviewLead, type StoredChoice } from './mailchimp-review'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = '22222222-2222-4222-8222-222222222222'
const lead = (id: string, over: Partial<ReviewLead> = {}): ReviewLead => ({ id, email: `${id}@example.com`, first_name: id[0].toUpperCase() + id.slice(1), last_name: 'Doe', created_at: '2026-05-01T15:00:00Z', ...over })

function answer(choices: StoredChoice[]) {
  const leads = [
    lead('ann'), lead('bob'), lead('cat', { phone: '(423) 555-0199' }),
    lead('dee', { archived_at: '2026-08-17T15:00:00Z' }),
    lead('eve', { marketing_opt_out: true }),
    lead('fay'),
  ]
  const members = [{ id: 'm1', email: 'ann@example.com', emailKey: 'ann@example.com', status: 'subscribed', phone: null }, { id: 'm2', email: 'cat.old@example.org', emailKey: 'cat.old@example.org', status: 'subscribed', phone: '423-555-0199' }]
  return {
    ok: true, choicesReady: true, mailchimpWords: null,
    location: { id: LOC, name: 'Test', audienceName: 'Friends', timeZone: 'America/New_York' },
    model: buildReview({ leads, contacted: new Set(['bob']), suppressed: new Set(['fay@example.com']), members, choices, timeZone: 'America/New_York' }),
  }
}

let host: HTMLElement
let root: Root
let calls: { url: string; init: any }[] = []
let saved: StoredChoice[] = []
function installFetch() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    if (init?.method === 'POST') {
      const b = JSON.parse(init.body)
      saved = saved.filter((c) => !(c.scope === b.scope && c.key === b.key))
      if (b.choice !== null) saved.push({ scope: b.scope, key: b.key, choice: b.choice })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    return new Response(JSON.stringify(answer(saved)), { status: 200 })
  }))
}
async function mount() {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={() => {}} />) })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const big = () => host.querySelector('[data-testid="mc-big-number"]')!.textContent
const person = (name: string) => Array.from(host.querySelectorAll('[data-testid="mc-person"]')).find((el) => el.textContent!.includes(name)) as HTMLElement | undefined
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click() }) ; await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const openList = async () => { const b = host.querySelector('[data-testid="mc-open-list"]'); if (b) await click(b) }
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); saved = [] })

describe('the screen', () => {
  it('shows the big number first, and the parts under it add up (Kevin, 2026-11-26)', async () => {
    installFetch(); await mount()
    // new: bob (worked), cat (no history), dee (archived, unticked) → 2 ticked
    expect(big()).toBe('2')
    expect(host.querySelector('[data-testid="mc-big-words"]')!.textContent).toBe('people will be added to Friends')
    expect(host.querySelector('[data-testid="mc-audience"]')!.textContent).toBe('Friends')
    // Was "1 already in your Mailchimp · 3 new to Mailchimp" — the 3 counted
    // Dee (archived, unticked), whom the big 2 did not. Now every part is named
    // and they add up: 2 + 1 + 1 = 4.
    expect(host.querySelector('[data-testid="mc-gap"]')!.textContent).toBe('2 to add · 1 archived, not ticked · 1 already in your Mailchimp — 4 in all')
    const first = host.querySelector('section')!
    expect(first.contains(host.querySelector('[data-testid="mc-big-number"]'))).toBe(true)
  })
  it('archived people are in the list with no filter, unticked, with their archive day', async () => {
    installFetch(); await mount()
    await openList()
    const dee = person('Dee Doe')!
    expect(dee).toBeTruthy()
    expect((dee.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
    expect(dee.textContent).toContain('Archived on Aug 17, 2026')
    expect((host.querySelector('select[aria-label="Filter by group"]') as HTMLSelectElement).value).toBe('')
    expect(host.querySelector('[data-testid="mc-group-archived"] [data-testid="mc-group-note"]')!.textContent).toBe('Archived on Aug 17, 2026 · tick to add them')
  })
  it('people who said no are not in the list — no box to tick — only counted', async () => {
    installFetch(); await mount()
    await openList()
    expect(person('Eve Doe')).toBeUndefined()
    expect(person('Fay Doe')).toBeUndefined()
    expect(host.textContent).not.toContain('eve@example.com')
    expect(host.querySelector('[data-testid="mc-not-offered"]')!.textContent).toMatch(/^Can’t be added2/)
  })
  it('unticking a group saves it, drops the number, and a reload shows it back', async () => {
    installFetch(); await mount()
    const box = host.querySelector('[data-testid="mc-group-never_other"] input[type=checkbox]')!
    await click(box)
    expect(big()).toBe('1')
    const post = calls.find((c) => c.init?.method === 'POST')!
    expect(post.url).toBe('/api/mailchimp/review')
    expect(JSON.parse(post.init.body)).toEqual({ location_id: LOC, scope: 'group', key: 'never_other', choice: 'out' })
    act(() => root.unmount()); host.remove()
    await mount()
    expect(big()).toBe('1')
    expect((host.querySelector('[data-testid="mc-group-never_other"] input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
  })
  it('ticking one archived person in saves that person and survives a reload', async () => {
    installFetch(); await mount()
    await openList()
    await click(person('Dee Doe')!.querySelector('input[type=checkbox]')!)
    expect(big()).toBe('3')
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init.body)).toMatchObject({ scope: 'person', key: 'dee@example.com', choice: 'in' })
    act(() => root.unmount()); host.remove()
    await mount()
    await openList()
    expect((person('Dee Doe')!.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)
    expect(person('Dee Doe')!.textContent).toContain('Changed')
  })
  it('a phone match is asked once; "same" changes only the count; the person stays listed', async () => {
    installFetch(); await mount()
    const q = host.querySelector('[data-testid="mc-phone-next"]')!
    expect(q.textContent).toContain('cat.old@example.org')
    expect(q.textContent).toContain('cat@example.com')
    const yes = Array.from(q.querySelectorAll('button')).find((b) => b.textContent === 'Yes, same person')!
    await click(yes)
    expect(big()).toBe('1')
    await openList()
    expect(person('Cat Doe')!.textContent).toContain('Matched by phone')
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init.body)).toMatchObject({ scope: 'phone', key: 'm2|cat@example.com', choice: 'same' })
  })
  it('calls nothing but its own route', async () => {
    installFetch(); await mount()
    await click(host.querySelector('[data-testid="mc-group-worked"] input[type=checkbox]')!)
    for (const c of calls) expect(c.url.startsWith('/api/mailchimp/review')).toBe(true)
  })
  it('a refused save puts the tick back and says why', async () => {
    installFetch(); await mount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'said_no', words: 'This person has said no to marketing emails, so they can’t be added to Mailchimp.' }), { status: 409 })))
    await openList()
    await click(person('Bob Doe')!.querySelector('input[type=checkbox]')!)
    expect((person('Bob Doe')!.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)
    expect(host.textContent).toContain('said no to marketing emails')
    expect(big()).toBe('2')
  })
  it('shows 50 at a time', async () => {
    const many = Array.from({ length: 120 }, (_, i) => lead('p' + String(i).padStart(3, '0')))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, choicesReady: true, mailchimpWords: null, location: { id: LOC, name: 'T', audienceName: null, timeZone: 'UTC' }, model: buildReview({ leads: many, contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: 'UTC' }) }), { status: 200 })))
    await mount()
    expect(host.querySelectorAll('[data-testid="mc-person"]').length).toBe(0)   // closed until asked for
    await openList()
    expect(host.querySelectorAll('[data-testid="mc-person"]').length).toBe(50)
    expect(host.textContent).toContain('Showing 50 of 120')
    expect(big()).toBe('120')
  })
it('the Archived group is on screen with nobody in it, and cannot be ticked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, choicesReady: true, mailchimpWords: null, location: { id: LOC, name: 'T', audienceName: null, timeZone: 'UTC' }, model: buildReview({ leads: [lead('ann'), lead('bob')], contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: 'UTC' }) }), { status: 200 })))
    await mount()
    const g = host.querySelector('[data-testid="mc-group-archived"]')!
    expect(g).toBeTruthy()
    expect(g.querySelector('[data-testid="mc-group-count"]')!.textContent).toBe('0')
    expect(g.querySelector('[data-testid="mc-group-note"]')!.textContent).toBe('No one here is archived')
    const box = g.querySelector('input[type=checkbox]') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(box.disabled).toBe(true)
  })
  it('the parts still add up as ticks change: a group unticked is "not ticked", an archived person ticked joins "to add"', async () => {
    installFetch(); await mount()
    const tally = () => host.querySelector('[data-testid="mc-gap"]')!.textContent
    await click(host.querySelector('[data-testid="mc-group-never_other"] input[type=checkbox]')!)
    expect(big()).toBe('1')
    expect(tally()).toBe('1 to add · 1 archived, not ticked · 1 not ticked · 1 already in your Mailchimp — 4 in all')
    await click(host.querySelector('[data-testid="mc-group-archived"] input[type=checkbox]')!)
    expect(big()).toBe('2')
    expect(tally()).toBe('2 to add · 1 not ticked · 1 already in your Mailchimp — 4 in all')
  })
  it('sections come in the design’s order, and Done (with nothing to save it to) only goes back', async () => {
    installFetch()
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    const onClose = vi.fn()
    await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={onClose} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(Array.from(host.querySelectorAll('h4')).map((h) => h.textContent)).toEqual(['Groups', 'Not changing', 'Same person?', 'Exceptions'])
    const posts = () => calls.filter((c) => c.init?.method === 'POST').length
    const save = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Done')!
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Save')).toBe(false)
    await click(save)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(posts()).toBe(0)
  })
  it('slice 6 (2026-11-25): Done calls onDone when given (the Mailchimp screen records the review); Back calls onClose only', async () => {
    installFetch()
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    const onClose = vi.fn(), onDone = vi.fn()
    await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={onClose} onDone={onDone} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await click(Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Done')!)
    expect([onDone.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 0])
    await click(host.querySelector('[data-mcr-back]') as HTMLElement)
    expect([onDone.mock.calls.length, onClose.mock.calls.length]).toEqual([1, 1])
    expect(calls.filter((c) => c.init?.method === 'POST')).toHaveLength(0)
  })
  it('2026-11-26: Done that could not save STAYS on the page and says so plainly — never a silent return', async () => {
    installFetch()
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    const onDone = vi.fn(async () => ({ ok: false, words: 'Your review couldn’t be saved, so step 1 isn’t ticked yet.' }))
    await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={() => {}} onDone={onDone} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(host.querySelector('[data-testid="mc-done-error"]')).toBeNull()
    await click(host.querySelector('[data-testid="mc-done"]')!)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-testid="mc-done-error"]')!.textContent).toBe('Your review couldn’t be saved, so step 1 isn’t ticked yet.')
    expect(host.querySelector('[data-testid="mc-title"]')).toBeTruthy()         // still on the page
    expect((host.querySelector('[data-testid="mc-done"]') as HTMLButtonElement).disabled).toBe(false)  // can press again
  })
  it('…and a Done that throws gets the plain message too', async () => {
    installFetch()
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={() => {}} onDone={async () => { throw new Error('network') }} />) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    await click(host.querySelector('[data-testid="mc-done"]')!)
    expect(host.querySelector('[data-testid="mc-done-error"]')!.textContent).toContain('Please press Done again')
  })
  it('"See this person" opens the group’s people RIGHT UNDER the group, with Hide — no jump to Exceptions', async () => {
    installFetch(); await mount()
    const scrolled = vi.fn()
    ;(Element.prototype as any).scrollIntoView = scrolled
    const g = host.querySelector('[data-testid="mc-group-archived"]')!
    const see = g.querySelector('[data-testid="mc-group-see"]') as HTMLButtonElement
    expect(see.textContent).toBe('See this person')
    await click(see)
    const inline = g.querySelector('[data-testid="mc-group-people"]')!
    expect(inline).toBeTruthy()                                                // inside the group's own card
    expect(Array.from(inline.querySelectorAll('[data-testid="mc-person"]')).map((el) => el.textContent)).toEqual([expect.stringContaining('Dee Doe')])
    expect(host.querySelector('[data-testid="mc-people"]')).toBeNull()          // Exceptions did not open
    expect(scrolled).not.toHaveBeenCalled()                                    // and nothing jumped
    expect(see.textContent).toBe('Hide')
    expect(see.getAttribute('aria-expanded')).toBe('true')
    await click(see)
    expect(g.querySelector('[data-testid="mc-group-people"]')).toBeNull()
    expect(see.textContent).toBe('See this person')
  })
  it('a tick in the opened group overrides the group, exactly as in Exceptions, and is saved the same way', async () => {
    installFetch(); await mount()
    const g = host.querySelector('[data-testid="mc-group-archived"]')!
    await click(g.querySelector('[data-testid="mc-group-see"]')!)
    const dee = g.querySelector('[data-testid="mc-group-people"] [data-testid="mc-person"]')!
    expect((dee.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
    await click(dee.querySelector('input[type=checkbox]')!)
    expect(big()).toBe('3')
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init.body)).toEqual({ location_id: LOC, scope: 'person', key: 'dee@example.com', choice: 'in' })
    expect((host.querySelector('[data-testid="mc-group-archived"] input[type=checkbox]') as HTMLInputElement).checked).toBe(false)  // the group stays unticked
    expect(g.querySelector('[data-testid="mc-group-people"] [data-testid="mc-person"]')!.textContent).toContain('Changed')
    await openList()
    expect((person('Dee Doe')!.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)  // the same tick in Exceptions
  })
  it('the list does not move the big number when only opened', async () => {
    installFetch(); await mount()
    const before = big()
    await openList()
    expect(big()).toBe(before)
  })
  it('before the migration is run, nothing on the screen can be ticked or answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...answer([]), choicesReady: false }), { status: 200 })))
    await mount()
    await openList()
    expect(host.textContent).toContain('Saving choices isn’t switched on yet')
    const boxes = Array.from(host.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[]
    expect(boxes.length).toBeGreaterThan(5)
    for (const b of boxes) expect(b.disabled).toBe(true)
    for (const b of Array.from(host.querySelectorAll('[data-testid="mc-phone-next"] button')) as HTMLButtonElement[]) expect(b.disabled).toBe(true)
  })
  it('the page keeps its heading and says nothing is sent (the pop-up design gets these from its frame)', async () => {
    installFetch(); await mount()
    expect(host.querySelector('[data-testid="mc-title"]')!.textContent).toBe('Who goes to Mailchimp')
    expect(host.querySelector('[data-testid="mc-nothing-sent"]')!.textContent).toContain('Nothing is sent from this screen')
    // above the big number
    const title = host.querySelector('[data-testid="mc-title"]')!
    expect(title.compareDocumentPosition(host.querySelector('[data-testid="mc-big-number"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
  it('names the list from the location; with no name on file it says "your Mailchimp list" (no "audience", Kevin 2026-11-26)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { const a = answer([]); return new Response(JSON.stringify({ ...a, location: { ...a.location, audienceName: null } }), { status: 200 }) }))
    await mount()
    expect(host.querySelector('[data-testid="mc-big-words"]')!.textContent).toBe('people will be added to your Mailchimp list')
    expect(host.querySelector('[data-testid="mc-audience"]')).toBeNull()
  })
  it('when Mailchimp could not be read, the line still names the audience', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { const a = answer([]); return new Response(JSON.stringify({ ...a, mailchimpWords: 'Mailchimp could not be reached.', model: { ...a.model, mailchimpKnown: false } }), { status: 200 }) }))
    await mount()
    expect(host.querySelector('[data-testid="mc-big-words"]')!.textContent).toBe('people are ticked to go to Friends')
  })
})
