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
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals(); saved = [] })

describe('the screen', () => {
  it('shows the big number first, with already-there vs new', async () => {
    installFetch(); await mount()
    // new: bob (worked), cat (no history), dee (archived, unticked) → 2 ticked
    expect(big()).toBe('2')
    expect(host.textContent).toContain('People who will be added to your Mailchimp audience “Friends”')
    expect(host.querySelector('[data-testid="mc-gap"]')!.textContent).toBe('1 already in your Mailchimp · 3 new to Mailchimp')
    const first = host.querySelector('section')!
    expect(first.contains(host.querySelector('[data-testid="mc-big-number"]'))).toBe(true)
  })
  it('archived people are in the list with no filter, unticked, with their archive day', async () => {
    installFetch(); await mount()
    const dee = person('Dee Doe')!
    expect(dee).toBeTruthy()
    expect((dee.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
    expect(dee.textContent).toContain('Archived on Aug 17, 2026')
    expect((host.querySelector('select[aria-label="Show group"]') as HTMLSelectElement).value).toBe('')
  })
  it('people who said no are not in the list — no box to tick — only counted', async () => {
    installFetch(); await mount()
    expect(person('Eve Doe')).toBeUndefined()
    expect(person('Fay Doe')).toBeUndefined()
    expect(host.textContent).not.toContain('eve@example.com')
    expect(host.querySelector('[data-testid="mc-not-offered"]')!.textContent).toMatch(/Can’t be added2/)
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
    await click(person('Dee Doe')!.querySelector('input[type=checkbox]')!)
    expect(big()).toBe('3')
    expect(JSON.parse(calls.find((c) => c.init?.method === 'POST')!.init.body)).toMatchObject({ scope: 'person', key: 'dee@example.com', choice: 'in' })
    act(() => root.unmount()); host.remove()
    await mount()
    expect((person('Dee Doe')!.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)
    expect(person('Dee Doe')!.textContent).toContain('changed by you')
  })
  it('a phone match is asked once; "same" changes only the count; the person stays listed', async () => {
    installFetch(); await mount()
    const q = host.querySelector('[data-testid="mc-phone-next"]')!
    expect(q.textContent).toContain('cat.old@example.org')
    expect(q.textContent).toContain('cat@example.com')
    const yes = Array.from(q.querySelectorAll('button')).find((b) => b.textContent === 'Yes, same person')!
    await click(yes)
    expect(big()).toBe('1')
    expect(person('Cat Doe')!.textContent).toContain('matched by phone')
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
    await click(person('Bob Doe')!.querySelector('input[type=checkbox]')!)
    expect((person('Bob Doe')!.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)
    expect(host.textContent).toContain('said no to marketing emails')
    expect(big()).toBe('2')
  })
  it('shows 50 at a time', async () => {
    const many = Array.from({ length: 120 }, (_, i) => lead('p' + String(i).padStart(3, '0')))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, choicesReady: true, mailchimpWords: null, location: { id: LOC, name: 'T', audienceName: null, timeZone: 'UTC' }, model: buildReview({ leads: many, contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: 'UTC' }) }), { status: 200 })))
    await mount()
    expect(host.querySelectorAll('[data-testid="mc-person"]').length).toBe(50)
    expect(big()).toBe('120')
  })
})
