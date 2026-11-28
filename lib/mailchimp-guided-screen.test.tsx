// @vitest-environment happy-dom
//
// FL-75 (2026-11-26) — the guided Mailchimp set-up
// (components/settings/MailchimpGuidedSetup.jsx + lib/mailchimp-guided.ts),
// built to Kevin's approved Lovable design. Kevin's pins:
//   • The live-flow warning appears on the overview, before any work is done
//   • The overview still says the real check happens again at the end
//   • No headline number ever counts someone who will not be sent
//   • One step on screen at a time, and leaving and returning keeps the place
//   • Everything already proven in slices 6 and 7 still holds (the sending and
//     bringing-in code is unchanged; its own tests stay; here: refused while a
//     flow is live or Mailchimp can't be read, the exact confirmed number)
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('./supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('tests pass deps.db') } } }))
import React from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import MailchimpConnectionScreen from '@/components/settings/MailchimpConnectionScreen'
import MailchimpGuidedSetup, { HONEST_LINE, PAUSE_HOW } from '@/components/settings/MailchimpGuidedSetup'
import MailchimpFlowDiagram, { flowWords } from '@/components/settings/MailchimpFlowDiagram'
import MailchimpReviewScreen from '@/components/settings/MailchimpReviewScreen'
import { buildReview, markHeld, reviewTally, matchedByPhone, countAdding, type ReviewLead } from './mailchimp-review'
import { readPlace, nextPlace, backPlace, goTo, canGoTo, placeKey, START, emailCheck, incomingNumbers, outgoingNumbers, tickedToBringIn, leftOutLine, finishLabel, finishLines, sendFinished, flowActive, flowFinish, tagWords } from './mailchimp-guided'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = '33333333-3333-4333-8333-333333333333'

// ─── sample answers ────────────────────────────────────────────────────────
const OK_PAUSED = { ok: true, mustPause: [], paused: [{ name: 'Welcome New Contacts', status: 'paused', subjects: [] }] }
const LIVE = { ok: true, mustPause: [{ name: 'Welcome New Contacts', status: 'sending', subjects: [] }, { name: 'New Subscriber Hello', status: 'sending', subjects: [] }], paused: [] }
const NEVER = { live: true, synced: false, reviewed: false, audience_count: 20, last_synced_at: null, refused_count: 0, flows: OK_PAUSED, how_to_pause: '' }

const IMPORT_MODEL = {
  location: { name: 'Test Location', audienceId: 'list1' }, read: 9, choicesReady: true, group: null,
  create: [
    { k: 'm1', e: 'one@example.org', n: 'Ana Ruiz', s: 'subscribed', j: '2024-07-01T10:00:00+00:00' },
    { k: 'm2', e: 'two@example.org', n: null, s: 'unsubscribed', j: '2024-07-02T10:00:00+00:00' },
    { k: 'm4', e: 'four@example.org', n: 'Out Byhand', s: 'subscribed', j: '2024-07-02T10:00:00+00:00', c: 'out' },
  ],
  held: [{ k: 'm3', e: 'three@example.org', n: null, s: 'subscribed', j: null, reason: 'phone_match', match: { n: 'Pat Lee', e: 'pat@x.com' } }],
  skipped: { total: 2, byReason: { staff: 1, cleaned: 1 } },
  already: 3,
}
const lead = (id: string, over: Partial<ReviewLead> = {}): ReviewLead => ({ id, email: `${id}@example.com`, first_name: id, last_name: 'Doe', created_at: '2026-05-01T15:00:00Z', ...over })
// Five new to Mailchimp; two of them Mailchimp turned down before (held),
// one archived in Mailchimp; one more archived in Bee Hub (unticked).
function reviewAnswer(o: { held?: string[]; mcArchived?: string[] } = {}) {
  const leads = [lead('ann'), lead('bob'), lead('cat'), lead('dee'), lead('eve'), lead('fay', { archived_at: '2026-08-17T15:00:00Z' })]
  const base = buildReview({ leads, contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: 'UTC' })
  const model = markHeld(base, new Set((o.held ?? ['bob@example.com', 'cat@example.com'])), new Set(o.mcArchived ?? ['dee@example.com']))
  return { ok: true, choicesReady: true, mailchimpWords: null, heldKnown: true, location: { id: LOC, name: 'Test', audienceName: 'Bee Organized Friends', timeZone: 'UTC' }, model }
}
const ASK = { count: 2, list_id: 'list1', list_name: 'Bee Organized Friends', flows: 'fp1', paused_flows: [], held_tags: [] as any[], left_out: { archived: 1, refused: 2 } }

type Reply = { status?: number; json: any }
function api(o: { overview?: any; overviewNow?: any; available?: boolean; importModel?: any; review?: any; sync?: Reply[]; importPost?: Reply[]; reviewedOk?: boolean; audiences?: any[] } = {}) {
  const calls: Array<{ url: string; method: string; body: any }> = []
  const sync = [...(o.sync || [])]
  const importPost = [...(o.importPost || [])]
  let overviewReads = 0
  const res = (r: Reply) => ({ ok: (r.status || 200) < 300, status: r.status || 200, json: async () => r.json })
  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    const method = init.method || 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null })
    if (url.startsWith('/api/mailchimp/overview')) {
      if (method === 'POST') return res(o.reviewedOk === false ? { status: 500, json: { error: 'not_saved', words: 'Your review couldn’t be saved.' } } : { json: { ok: true } })
      overviewReads++
      const ov = overviewReads > 1 && o.overviewNow !== undefined ? o.overviewNow : ('overview' in o ? o.overview : NEVER)
      return ov === null ? res({ status: 500, json: { error: 'x' } }) : res({ json: ov })
    }
    if (url.startsWith('/api/mailchimp/import?available=1')) return res({ json: { available: o.available !== false } })
    if (url.startsWith('/api/mailchimp/import/choice')) return res({ json: { ok: true } })
    if (url.startsWith('/api/mailchimp/import')) {
      if (method === 'POST') return res(importPost.shift() || { json: { ok: true, created: 0, createdUnsubscribed: 0, alreadyThere: 0, failed: [] } })
      return res({ json: { ok: true, model: o.importModel || IMPORT_MODEL } })
    }
    if (url.startsWith('/api/mailchimp/review')) return method === 'POST' ? res({ json: { ok: true } }) : res({ json: o.review || reviewAnswer() })
    if (url === '/api/mailchimp/sync') return res(sync.shift() || { json: { ran: false, reason: 'needs_confirmation', confirm: ASK } })
    if (url.startsWith('/api/mailchimp/audiences')) return method === 'POST' ? res({ json: { list_id: 'list2', list_name: 'Second List' } }) : res({ json: { audiences: o.audiences || [{ id: 'list1', name: 'Bee Organized Friends' }] } })
    throw new Error('unexpected ' + method + ' ' + url)
  })
  const of = (path: string, m = 'POST') => calls.filter((c) => c.url.startsWith(path) && c.method === m)
  return { fetchImpl, calls, of }
}
function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, map: m }
}

let host: HTMLElement, root: Root
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.unstubAllGlobals() })
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() }) }
async function mount(a: ReturnType<typeof api>, store = memStore(), extra: any = {}) {
  vi.stubGlobal('fetch', a.fetchImpl)          // the outgoing review screen uses the global fetch
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<MailchimpConnectionScreen locationId={LOC} accountName="Kevin’s Mailchimp" listName="Bee Organized Friends" onReview={() => {}} onDisconnect={() => {}} fetchImpl={a.fetchImpl} storage={store} {...extra} />) })
  await flush()
  return store
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null
const click = async (el: Element | null) => { expect(el, 'present').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }); await flush() }
const STEPS = ['mcg-overview', 'mcg-step-1', 'mcg-step-2', 'mcg-step-3', 'mcg-step-4', 'mcg-finish-page']
const onScreen = () => STEPS.filter((s) => q(s))
async function walkTo(step: number) {
  if (step >= 1) await click(q('mcg-begin'))
  if (step >= 2) await click(q('mcg-next'))
  if (step >= 3) await click(q('mci-next'))
  if (step >= 4) await click(q('mc-done'))
}

// ═══ 1. The live-flow warning, on the overview, before any work ═════════
describe('the overview: the email check comes first', () => {
  it('a live flow is named on the overview, with how to pause it; nothing can begin and nothing is written', async () => {
    const a = api({ overview: { ...NEVER, flows: LIVE } })
    await mount(a)
    expect(onScreen()).toEqual(['mcg-overview'])
    expect(q('mcg-check')!.getAttribute('data-kind')).toBe('live')
    expect(q('mcg-check-title')!.textContent).toBe('Can’t add people yet')
    expect(Array.from(host.querySelectorAll('[data-testid="mcg-live-flows"] [data-flow-name]')).map((e) => e.textContent)).toEqual(['Welcome New Contacts', 'New Subscriber Hello'])
    expect(host.querySelector('[data-testid="mcg-live-flows"]')!.textContent!.split(PAUSE_HOW).length - 1).toBe(2)
    expect(q('mcg-begin')!.disabled).toBe(true)
    expect(a.calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(a.of('/api/mailchimp/sync')).toEqual([])
  })
  it('Mailchimp couldn’t be read, or the overview didn’t load: “couldn’t check”, never “clear”, and nothing can begin', async () => {
    for (const ov of [{ ...NEVER, flows: { ok: false } }]) {
      const a = api({ overview: ov })
      await mount(a)
      expect(q('mcg-check')!.getAttribute('data-kind')).toBe('unreadable')
      expect(q('mcg-check-title')!.textContent).toBe('Couldn’t check Mailchimp')
      expect(q('mcg-begin')!.disabled).toBe(true)
      act(() => root.unmount()); host.remove()
    }
    expect(emailCheck(null).kind).toBe('unreadable')
    expect(emailCheck({}).kind).toBe('unreadable')
    expect(emailCheck({ flows: { ok: true } }).kind).toBe('unreadable')
  })
  it('Check again reads the overview again and says when they are still on', async () => {
    const a = api({ overview: { ...NEVER, flows: LIVE } })
    await mount(a)
    expect(q('mcg-check-status')).toBeNull()
    await click(q('mcg-check-again'))
    expect(a.of('/api/mailchimp/overview', 'GET').length).toBe(2)
    expect(q('mcg-check-status')!.textContent).toBe('Checked again. These emails are still on.')
    expect(a.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })
  it('once paused, Check again clears it and Let’s begin comes on', async () => {
    const a = api({ overview: { ...NEVER, flows: LIVE }, overviewNow: NEVER })
    await mount(a)
    await click(q('mcg-check-again'))
    expect(q('mcg-check')!.getAttribute('data-kind')).toBe('clear')
    expect(q('mcg-begin')!.disabled).toBe(false)
  })
})

describe('the overview: honest, not a guarantee', () => {
  it('says the real check happens again at the end — when clear, when live and when unreadable', async () => {
    for (const flows of [OK_PAUSED, LIVE, { ok: false }]) {
      const a = api({ overview: { ...NEVER, flows } })
      await mount(a)
      expect(q('mcg-honest')!.textContent).toBe(HONEST_LINE)
      act(() => root.unmount()); host.remove()
    }
    expect(HONEST_LINE).toMatch(/checks again just before anyone is sent/)
    expect(HONEST_LINE).toMatch(/switched back on/)
    expect(HONEST_LINE).not.toMatch(/guarantee|won’t ever|never will/i)
  })
  it('the clear line says only what the check found', async () => {
    const a = api()
    await mount(a)
    expect(q('mcg-check')!.textContent).toBe('Mailchimp won’t email anyone just because they’re added.')
  })
  it('the quiz flow (Kevin’s known condition) is named as on, only for its tag', async () => {
    const a = api({ overview: { ...NEVER, flows: { ok: true, mustPause: [], paused: [], conditional: [{ name: 'Profile Quiz - Welcome Flow', tag: 'Profile Quiz' }] } } })
    await mount(a)
    expect(q('mcg-conditional')!.textContent).toBe('“Profile Quiz - Welcome Flow” is on, but it only emails people tagged “Profile Quiz”. Bee Hub won’t send that tag.')
  })
  it('the switch off is said on the overview', async () => {
    const a = api({ overview: { ...NEVER, live: false } })
    await mount(a)
    expect(q('mcg-not-live')!.textContent).toContain('Sending to Mailchimp isn’t switched on for your location yet.')
  })
})

// ═══ 2. No headline number counts someone who will not be sent ═══════════
describe('the number rule', () => {
  it('outgoing: held back (refused before, or archived in Mailchimp) are never in the big number', () => {
    const r = reviewAnswer()
    const t = reviewTally(r.model.people, r.model.groups, matchedByPhone(r.model.phone), r.model)
    expect(t).toMatchObject({ adding: 2, heldBack: 3, archivedUnticked: 1 })
    expect(r.model.adding).toBe(2)
    expect(t.total).toBe(t.adding + t.archivedUnticked + t.otherUnticked + t.heldBack + t.already)
    expect(outgoingNumbers(r.model)).toEqual({ sending: 2, leftOut: 4 })
  })
  it('Test Location tonight: six held test addresses and nobody else → the big number is 0, the six are in the quiet line', () => {
    const leads = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => lead('held' + x))
    const base = buildReview({ leads, contacted: new Set(), suppressed: new Set(), members: [], choices: [], timeZone: 'UTC' })
    expect(base.adding).toBe(6)                    // the old number
    const m = markHeld(base, new Set(leads.map((l) => l.email!)), new Set())
    expect(m.adding).toBe(0)
    expect(countAdding(m.people, m.groups)).toBe(0)
    expect(outgoingNumbers(m)).toEqual({ sending: 0, leftOut: 6 })
  })
  it('the review screen: big number without them; why, in one quiet line and on each person', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => reviewAnswer() })))
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={() => {}} />) })
    await flush()
    expect(q('mc-big-number')!.textContent).toBe('2')
    expect(q('mc-tally-held')!.textContent).toBe('2 Mailchimp turned down before')
    expect(q('mc-tally-mc-archived')!.textContent).toBe('1 archived in your Mailchimp')
    await click(q('mc-open-list'))
    const lines = Array.from(host.querySelectorAll('[data-testid="mc-held-line"]')).map((e) => e.textContent)
    expect(lines.sort()).toEqual(['Archived in your Mailchimp, so it won’t be sent.', 'Mailchimp turned this address down before, so it won’t be sent.', 'Mailchimp turned this address down before, so it won’t be sent.'])
  })
  it('the review screen says when who is held back couldn’t be checked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ...reviewAnswer(), heldKnown: false }) })))
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root.render(<MailchimpReviewScreen locationId={LOC} onClose={() => {}} />) })
    await flush()
    expect(q('mc-held-unknown')!.textContent).toContain('may include a few people who won’t be sent')
  })
  it('incoming: only the ticked people who will be created; unticked, held and skipped are left out', () => {
    expect(tickedToBringIn(IMPORT_MODEL as any)).toEqual(['m1', 'm2'])
    expect(incomingNumbers(IMPORT_MODEL as any)).toEqual({ bringing: 2, leftOut: 4 })
    expect(incomingNumbers({ ...IMPORT_MODEL, group: 'out' } as any)).toEqual({ bringing: 0, leftOut: 6 })
  })
  it('incoming: a "same person?" answered "Different people" comes in; "Same person" or no answer stays in the quiet line', () => {
    const withAnswer = (c: any) => ({ ...IMPORT_MODEL, held: [{ ...IMPORT_MODEL.held[0], c }] }) as any
    expect(tickedToBringIn(withAnswer('in'))).toEqual(['m1', 'm2', 'm3'])
    expect(incomingNumbers(withAnswer('in'))).toEqual({ bringing: 3, leftOut: 3 })
    expect(incomingNumbers(withAnswer('out'))).toEqual({ bringing: 2, leftOut: 4 })
    // the group's tick never reaches them
    expect(tickedToBringIn({ ...withAnswer(undefined), group: 'in' })).toEqual(['m1', 'm2'])
  })
  it('the overview’s rough numbers follow the same rule, both ways, with one quiet line', async () => {
    const a = api()
    await mount(a)
    expect(q('mcg-rough-in')!.textContent).toBe('About 2 people in your Mailchimp aren’t in Bee Hub yet.')
    expect(q('mcg-rough-out')!.textContent).toBe('About 2 people in Bee Hub aren’t in your Mailchimp yet.')
    expect(q('mcg-rough-left-out')!.textContent).toBe('Another 4 coming in and 4 going out can’t be added or are left out. You’ll see who and why as you go.')
    expect(leftOutLine(0, 0)).toBeNull()
  })
  it('the last step’s count is the sending code’s own count, and the quiet line holds the rest', async () => {
    const a = api({ overview: { ...NEVER, reviewed: true } })
    await mount(a)
    await walkTo(4)
    expect(q('mcg-in-count')!.textContent).toBe('Bring 2 people into Bee Hub.')
    expect(q('mcg-out-count')!.textContent).toBe('Send 2 people over to Bee Organized Friends.')
    expect(q('mcg-left-out')!.textContent).toBe('4 left out coming in. 4 left out going over.')
    // asking for the count sent nothing: no confirm
    expect(a.of('/api/mailchimp/sync').map((c) => c.body)).toEqual([{ location_id: LOC }])
  })
})

// ═══ 3. One step at a time; the place is kept ════════════════════════════
describe('one step at a time', () => {
  it('only one step is ever on screen, with a plain marker and a tick on finished steps', async () => {
    const a = api()
    await mount(a)
    expect(onScreen()).toEqual(['mcg-overview'])
    expect(q('mcg-marker')).toBeNull()
    await click(q('mcg-begin'))
    expect(onScreen()).toEqual(['mcg-step-1'])
    expect(q('mcg-marker')!.textContent).toBe('Step 1 of 4')
    await click(q('mcg-next'))
    expect(onScreen()).toEqual(['mcg-step-2'])
    expect(q('mcg-marker')!.textContent).toBe('Step 2 of 4')
    expect(q('mcg-dot-1')!.getAttribute('aria-label')).toBe('Your Mailchimp, finished')
    expect(q('mcg-dot-1')!.querySelector('svg')).toBeTruthy()
    expect(q('mcg-dot-3')!.disabled).toBe(true)              // not reached yet
    await click(q('mci-next'))
    expect(onScreen()).toEqual(['mcg-step-3'])
    await click(q('mc-done'))
    expect(onScreen()).toEqual(['mcg-step-4'])
    expect(q('mcg-marker')!.textContent).toBe('Step 4 of 4')
    await click(q('mcg-back'))
    expect(onScreen()).toEqual(['mcg-step-3'])
    await click(q('mcg-dot-1'))
    expect(onScreen()).toEqual(['mcg-step-1'])
  })
  it('leaving and coming back keeps the place', async () => {
    const a = api()
    const store = await mount(a)
    await walkTo(3)
    expect(JSON.parse(store.getItem(placeKey(LOC))!)).toEqual({ v: 1, step: 3, done: [1, 2] })
    act(() => root.unmount()); host.remove()
    await mount(api(), store)
    expect(onScreen()).toEqual(['mcg-step-3'])
    expect(q('mcg-dot-2')!.getAttribute('aria-label')).toBe('Into Bee Hub, finished')
    expect(q('mcg-saved')!.textContent).toContain('Your place is saved on this device')
  })
  it('a saved place is never trusted: anything odd starts at the overview', () => {
    expect(readPlace(null)).toEqual(START)
    expect(readPlace('nope')).toEqual(START)
    expect(readPlace(JSON.stringify({ v: 1, step: 3, done: [1] }))).toEqual(START)       // step 2 not finished
    expect(readPlace(JSON.stringify({ v: 1, step: 9, done: [1, 2, 3] }))).toEqual(START)
    expect(readPlace(JSON.stringify({ v: 2, step: 1, done: [] }))).toEqual(START)
    expect(readPlace(JSON.stringify({ v: 1, step: 2, done: [1, 'x'] }))).toEqual(START)
    expect(readPlace(JSON.stringify({ v: 1, step: 4, done: [3, 1, 2, 2] }))).toEqual({ v: 1, step: 4, done: [1, 2, 3] })
    const p = nextPlace(nextPlace(START))
    expect(p).toEqual({ v: 1, step: 2, done: [1] })
    expect(backPlace(p)).toEqual({ v: 1, step: 1, done: [1] })
    expect(canGoTo(p, 3)).toBe(false)
    expect(goTo(p, 4)).toEqual(p)
  })
  it('the place is per location', () => {
    expect(placeKey('a')).not.toBe(placeKey('b'))
  })
  it('a browser that can’t save says so, and the path still works', async () => {
    const bad = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
    const a = api()
    await mount(a, bad as any)
    await click(q('mcg-begin'))
    expect(q('mcg-saved')!.textContent).toBe('Your browser couldn’t save your place. Keep this page open to finish.')
  })
  it('step 3’s Next saves the review first, and stays put (saying why) if it didn’t save', async () => {
    const a = api({ reviewedOk: false })
    await mount(a)
    await walkTo(3)
    await click(q('mc-done'))
    expect(a.of('/api/mailchimp/overview').map((c) => c.body)).toEqual([{ location_id: LOC, reviewed: true }])
    expect(onScreen()).toEqual(['mcg-step-3'])
    expect(q('mc-done-error')!.textContent).toBe('Your review couldn’t be saved.')
  })
  it('the two review screens sit inside the path: no second title, no "Back to Mailchimp"', async () => {
    const a = api()
    await mount(a)
    await walkTo(2)
    expect(host.querySelector('[data-testid="mci-review"]')!.getAttribute('data-embedded')).toBe('1')
    expect(q('mci-title')).toBeNull()
    await click(q('mci-next'))
    expect(q('mc-title')).toBeNull()
    expect(host.textContent).not.toContain('Back to Mailchimp')
    expect(host.querySelectorAll('[data-testid="mcg-title"]').length).toBe(1)
  })
  it('bringing people in not switched on here: step 2 says so, and the rest still works', async () => {
    const a = api({ available: false })
    await mount(a)
    expect(q('mcg-rough-in')!.textContent).toBe('Bringing people in from Mailchimp isn’t switched on for your location yet.')
    await walkTo(1); await click(q('mcg-next'))
    expect(q('mcg-import-off')).toBeTruthy()
    expect(a.calls.some((c) => c.url.startsWith('/api/mailchimp/import?location_id'))).toBe(false)
  })
  it('a different list starts the later steps again', async () => {
    const onListChanged = vi.fn()
    const a = api({ audiences: [{ id: 'list1', name: 'Bee Organized Friends' }, { id: 'list2', name: 'Second List' }] })
    const store = await mount(a, memStore(), { onListChanged })
    await click(q('mcg-begin'))
    const sel = q('mcg-list') as unknown as HTMLSelectElement
    expect(sel.value).toBe('list1')
    await act(async () => { sel.value = 'list2'; sel.dispatchEvent(new Event('change', { bubbles: true })) }); await flush()
    expect(a.of('/api/mailchimp/audiences').map((c) => c.body)).toEqual([{ location_id: LOC, list_id: 'list2' }])
    expect(onListChanged).toHaveBeenCalledWith('list2', 'Second List')
    expect(JSON.parse(store.getItem(placeKey(LOC))!)).toEqual({ v: 1, step: 1, done: [] })
  })
})

// ═══ 4. The last step and the finish ═════════════════════════════════════
describe('the last step: what slices 6 and 7 proved still holds', () => {
  it('one button that says what it does, then the server’s own answers', async () => {
    const a = api({
      sync: [{ json: { ran: false, reason: 'needs_confirmation', confirm: ASK } }, { json: { ran: true, complete: true, pushed: 2, already: 0, failed: 0, held_back: 2, remaining: 0, tags_held: [] } }],
      importPost: [{ json: { ok: true, created: 2, createdUnsubscribed: 1, alreadyThere: 0, failed: [] } }],
      overviewNow: { ...NEVER, synced: true },     // the server records the first send
    })
    const store = await mount(a)
    await walkTo(4)
    expect(q('mcg-finish')!.textContent).toBe('Bring them in & send them over')
    await click(q('mcg-finish'))
    expect(a.of('/api/mailchimp/import').map((c) => c.body)).toEqual([{ location_id: LOC, member_ids: ['m1', 'm2'], count: 2 }])
    expect(a.of('/api/mailchimp/sync').map((c) => c.body)).toEqual([{ location_id: LOC }, { location_id: LOC, confirm: { count: 2, list_id: 'list1', flows: 'fp1', tags_ok: [] } }])
    expect(onScreen()).toEqual(['mcg-finish-page'])
    expect(q('mcg-finish-in')!.textContent).toContain('2 people brought into Bee Hub')
    expect(q('mcg-finish-in')!.textContent).toContain('1 person came in marked “No marketing emails”')
    expect(q('mcg-finish-out')!.textContent).toContain('2 people sent over to Bee Organized Friends')
    expect(q('mcg-finish-out')!.textContent).toContain('2 people Mailchimp turned down before weren’t sent.')
    expect(host.textContent).toContain('You’re all set.')
    await click(q('mcg-done'))
    expect(store.getItem(placeKey(LOC))).toBeNull()
  })
  it('a flow switched on after the overview: refused at the end — nothing brought in, nothing sent', async () => {
    const a = api({ overviewNow: { ...NEVER, flows: LIVE } })
    await mount(a)
    await walkTo(4)
    expect(q('mcg-check')!.getAttribute('data-kind')).toBe('live')
    expect(q('mcg-finish')!.disabled).toBe(true)
    expect(a.of('/api/mailchimp/sync')).toEqual([])
    expect(a.of('/api/mailchimp/import')).toEqual([])
  })
  it('the sending code refuses (a flow is live) when asked for its count: the button is off', async () => {
    const a = api({ sync: [{ json: { ran: false, reason: 'signup_flows_live', must_pause: LIVE.mustPause } }] })
    await mount(a)
    await walkTo(4)
    expect(q('mcg-check')!.getAttribute('data-kind')).toBe('live')
    expect(q('mcg-out-count')!.textContent).toBe('Nobody can be sent over yet.')
    expect(q('mcg-finish')!.disabled).toBe(true)
    expect(a.of('/api/mailchimp/sync').every((c) => c.body.confirm === undefined)).toBe(true)
  })
  it('Mailchimp can’t be read at the end: refused, the button is off', async () => {
    const a = api({ sync: [{ json: { ran: false, reason: 'mailchimp_unreadable' } }] })
    await mount(a)
    await walkTo(4)
    expect(q('mcg-check')!.getAttribute('data-kind')).toBe('unreadable')
    expect(q('mcg-finish')!.disabled).toBe(true)
  })
  it('a flow switched on between the look and the press: the answer is the refusal, said plainly, and the place is kept', async () => {
    const a = api({ available: false, sync: [{ json: { ran: false, reason: 'needs_confirmation', confirm: ASK } }, { json: { ran: false, reason: 'signup_flows_live', must_pause: [{ name: 'Welcome New Contacts' }] } }] })
    const store = await mount(a)
    await walkTo(1); await click(q('mcg-next')); await click(q('mcg-next')); await click(q('mc-done'))
    expect(q('mcg-finish')!.textContent).toBe('Send them over')
    await click(q('mcg-finish'))
    expect(q('mcg-finish-out')!.textContent).toBe('Nobody was sent over. A Mailchimp welcome email was switched back on: Welcome New Contacts. Pause it, then come back to the last step.')
    expect(host.textContent).toContain('Here’s what happened.')
    await click(q('mcg-done'))
    expect(JSON.parse(store.getItem(placeKey(LOC))!).step).toBe(4)
  })
  it('something changed while bringing in: nothing is sent, the new numbers are shown', async () => {
    const a = api({ importPost: [{ status: 409, json: { error: 'changed', model: IMPORT_MODEL } }] })
    await mount(a)
    await walkTo(4)
    await click(q('mcg-finish'))
    expect(q('mcg-changed')).toBeTruthy()
    expect(a.of('/api/mailchimp/sync').every((c) => c.body.confirm === undefined)).toBe(true)
    expect(onScreen()).toEqual(['mcg-step-4'])
  })
  it('bringing in failed: nothing is sent over, and the finish says so', async () => {
    const a = api({ importPost: [{ status: 500, json: { error: 'x', words: 'Nobody was brought in.' } }] })
    await mount(a)
    await walkTo(4)
    await click(q('mcg-finish'))
    expect(a.of('/api/mailchimp/sync').every((c) => c.body.confirm === undefined)).toBe(true)
    expect(q('mcg-finish-amber')!.textContent).toBe('Nobody was brought in.')
  })
  it('a tag that starts a live flow: its own box, unticked; ticking one carries that one only', async () => {
    const held = { ...ASK, held_tags: [{ tag: 'CLOSEDJOB', flows: ['Closed Job Journey'], people: 4 }, { tag: 'VIP', flows: ['VIP Thanks'], people: 1 }] }
    const a = api({ sync: [{ json: { ran: false, reason: 'needs_confirmation', confirm: held } }, { json: { ran: true, complete: true, pushed: 2, remaining: 0, tags_held: ['VIP'] } }] })
    await mount(a)
    await walkTo(4)
    const boxes = Array.from(host.querySelectorAll('[data-testid="mcg-held-tags"] input[type=checkbox]')) as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([false, false])
    await click(host.querySelector('input[aria-label="Send the tag CLOSEDJOB"]'))
    await click(q('mcg-finish'))
    expect(a.of('/api/mailchimp/sync')[1].body.confirm.tags_ok).toEqual(['CLOSEDJOB'])
  })
  it('nobody to send: the sending code is never asked (asking would itself count as the first send)', async () => {
    const r = reviewAnswer({ held: ['ann@example.com', 'bob@example.com', 'cat@example.com', 'eve@example.com'], mcArchived: ['dee@example.com'] })
    const a = api({ review: r })
    await mount(a)
    await walkTo(4)
    expect(q('mcg-out-count')!.textContent).toBe('Nobody to send over.')
    expect(a.of('/api/mailchimp/sync')).toEqual([])
    expect(q('mcg-finish')!.textContent).toBe('Bring them in')
  })
  it('the switch off: nothing is sent and it says why', async () => {
    const a = api({ overview: { ...NEVER, live: false }, available: false })
    await mount(a)
    await walkTo(1); await click(q('mcg-next')); await click(q('mcg-next')); await click(q('mc-done'))
    expect(q('mcg-out-count')!.textContent).toContain('sending to Mailchimp isn’t switched on')
    expect(q('mcg-finish')!.disabled).toBe(true)
    expect(a.of('/api/mailchimp/sync')).toEqual([])
  })
  it('finish words: a stopped-partway send, Mailchimp turning people down, and the end only when it really ran to the end', () => {
    const f = finishLines(null, { ran: true, complete: false, pushed: 10, already: 1, failed: 2, held_back: 0, remaining: 5, tags_held: [] }, 'Friends')
    expect(f.allWell).toBe(false)
    expect(f.outgoing.map((l) => l.text)).toEqual(['10 people sent over to Friends', 'No email was sent from Bee Hub.', '1 person turned out to be in your Mailchimp already.', 'Mailchimp turned down 2 people. You’ll see who on your Mailchimp page.', 'Bee Hub stopped partway, with 5 people still to go. The rest go over the next time you send.'])
    expect(sendFinished({ ran: true, complete: false })).toBe(false)
    expect(sendFinished({ ran: true, complete: true, remaining: 0 })).toBe(true)
    expect(sendFinished({ ran: false })).toBe(false)
    expect(finishLabel(0, 0)).toBeNull()
    expect(finishLabel(1, 0)).toBe('Bring them in')
    expect(finishLabel(0, 1)).toBe('Send them over')
  })
})

// ═══ 5. The never-sent-yet page is the guided path; after it, as before ══
describe('where the guided path shows', () => {
  it('never sent yet → the guided path; sent before → the numbers and Send now page, unchanged', async () => {
    const a = api()
    await mount(a)
    expect(q('mcg')).toBeTruthy()
    expect(host.textContent).not.toContain('Start the first sync')
    act(() => root.unmount()); host.remove()
    const b = api({ overview: { ...NEVER, synced: true } })
    await mount(b)
    expect(q('mcg')).toBeNull()
    expect(host.querySelector('[data-testid="mc-connection"]')!.getAttribute('data-state')).toBe('running')
  })
  it('the overview didn’t load → the on-hold page, never the guided path saying “clear”', async () => {
    const a = api({ overview: null })
    await mount(a)
    expect(q('mcg')).toBeNull()
    expect(host.querySelector('[data-testid="mc-connection"]')!.getAttribute('data-state')).toBe('blocked')
  })
})

// ═══ 6. The words ════════════════════════════════════════════════════════
describe('the words: plain, amber, each fact once', () => {
  const JARGON = /\b(sync|syncs|syncing|synced|audience|audiences|integration|records?|API)\b/i
  it('no jargon on any step of the guided path', async () => {
    const a = api({ sync: [{ json: { ran: false, reason: 'needs_confirmation', confirm: ASK } }, { json: { ran: true, complete: true, pushed: 2, already: 0, failed: 0, held_back: 0, remaining: 0, tags_held: [] } }] })
    await mount(a)
    const seen: string[] = []
    const look = () => {
      const c = host.cloneNode(true) as HTMLElement
      c.querySelectorAll('style').forEach((e) => e.remove())
      const t = c.textContent || ''; seen.push(t); expect(t, t).not.toMatch(JARGON)
    }
    look(); await click(q('mcg-begin')); look(); await click(q('mcg-next')); look()
    await click(q('mci-next')); look(); await click(q('mc-done')); look(); await click(q('mcg-finish')); look()
    expect(seen).toHaveLength(6)
  })
  it('problems are amber, never red', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpGuidedSetup.jsx'), 'utf8')
    expect(src).not.toMatch(/destructive|danger/)
  })
  it('the last step says the list name once', async () => {
    const a = api()
    await mount(a)
    await walkTo(4)
    expect(host.querySelector('[data-testid="mcg-step-4"]')!.textContent!.split('Bee Organized Friends').length - 1).toBe(1)
  })
  it('no typed-name field and no "I understand" tick anywhere on the path', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpGuidedSetup.jsx'), 'utf8')
    expect(src).not.toMatch(/I understand|type your|full name/i)
    expect(src).not.toMatch(/type="(text|email)"/)
  })
})

// ═══ 7. It decides nothing, and calls only what it should ═════════════════
describe('it decides nothing', () => {
  it('the only writes are the existing routes; a confirm is only ever sent by the button', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpGuidedSetup.jsx'), 'utf8')
    const urls = Array.from(new Set(Array.from(src.matchAll(/'(\/api\/[a-z/]+)/g)).map((m) => m[1]))).sort()
    expect(urls).toEqual(['/api/mailchimp/audiences', '/api/mailchimp/import', '/api/mailchimp/overview', '/api/mailchimp/review', '/api/mailchimp/sync'])
    expect(src.match(/confirm: \{ count/g)).toHaveLength(1)
    expect(src).not.toMatch(new RegExp(['mailchimp', 'sync'].join('-') + '|supabase'))
  })
})

describe('each fact once: inside the path, the quiet line does not repeat the big number', () => {
  it('step 2 and step 3', async () => {
    const a = api()
    await mount(a)
    await walkTo(2)
    expect(q('mci-tally')!.textContent).toBe('1 not ticked · 1 left out for now · 2 skipped · 3 already in Bee Hub — 9 in your Mailchimp')
    await click(q('mci-next'))
    expect(q('mc-tally-adding')).toBeNull()
    expect(q('mc-gap')!.textContent).toBe('1 archived, not ticked · 2 Mailchimp turned down before · 1 archived in your Mailchimp · 0 already in your Mailchimp — 6 in all')
  })
})


// ═══ The direction picture (Kevin, 2026-11-27) ════════════════════════════
describe('the direction picture: the lit arrow matches the step', () => {
  const flowOf = () => {
    const f = host.querySelector('[data-testid="mcg-flow"]') as HTMLElement
    const arrow = (d: string) => f.querySelector(`[data-testid="mcg-flow-${d}"]`) as HTMLElement
    const count = (d: string) => f.querySelector(`[data-testid="mcg-flow-${d}-count"]`)?.textContent ?? null
    return { active: f.getAttribute('data-flow'), inLit: arrow('in').getAttribute('data-lit'), outLit: arrow('out').getAttribute('data-lit'), inN: count('in'), outN: count('out'), all: host.querySelectorAll('[data-testid="mcg-flow"]').length }
  }
  it('one picture, in the same place, on every step — above the step', async () => {
    const a = api({ sync: [{ json: { ran: false, reason: 'needs_confirmation', confirm: ASK } }, { json: { ran: true, complete: true, pushed: 2, already: 0, failed: 0, held_back: 0, remaining: 0, tags_held: [] } }],
      importPost: [{ json: { ok: true, created: 2, createdUnsubscribed: 0, alreadyThere: 0, failed: [] } }] })
    await mount(a)
    const seen: any[] = []
    const look = (stepId: string) => {
      const f = host.querySelector('[data-testid="mcg-flow"]')!
      const content = host.querySelector(`[data-testid="${stepId}"]`)!
      expect(f.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()   // picture first, then the step
      seen.push({ step: stepId, ...flowOf() })
    }
    look('mcg-overview'); await click(q('mcg-begin')); look('mcg-step-1'); await click(q('mcg-next')); look('mcg-step-2')
    await click(q('mci-next')); look('mcg-step-3'); await click(q('mc-done')); look('mcg-step-4'); await click(q('mcg-finish')); look('mcg-finish-page')
    expect(seen.map((x) => [x.step, x.active, x.inLit + x.outLit, x.inN, x.outN, x.all])).toEqual([
      ['mcg-overview', 'both', '11', '2', '2', 1],
      ['mcg-step-1', 'both', '11', '2', '2', 1],
      ['mcg-step-2', 'in', '10', '2', null, 1],      // Mailchimp → Bee Hub lit; the other faint, no number
      ['mcg-step-3', 'out', '01', null, '2', 1],     // Bee Hub → Mailchimp lit
      ['mcg-step-4', 'both', '11', '2', '2', 1],     // the server's own numbers
      ['mcg-finish-page', 'both', '11', '2', '2', 1], // what actually happened
    ])
  })
  it('the arrow number is the step’s own headline number, and follows the ticks', async () => {
    const a = api()
    await mount(a)
    await walkTo(2)
    expect(flowOf().inN).toBe(q('mci-big-number')!.textContent)
    await click(q('mci-see'))
    await click(host.querySelector('[data-testid="mci-person"] input[type=checkbox]'))
    expect(q('mci-big-number')!.textContent).toBe('1')
    expect(flowOf().inN).toBe('1')
    await click(q('mci-held-in')!.querySelector('input'))   // "Different people" → comes in
    expect(flowOf().inN).toBe('2')
    await click(q('mci-next'))
    expect(flowOf().outN).toBe(host.querySelector('[data-testid="mc-big-number"]')?.textContent ?? '2')
  })
  it('no arrow number counts anyone who will not be sent: held, refused, unticked and archived are not in it', async () => {
    // Six held refusals and nothing else (Test Location's own shape): the arrow says 0.
    const a = api({ review: reviewAnswer({ held: ['ann@example.com', 'bob@example.com', 'cat@example.com', 'dee@example.com', 'eve@example.com'], mcArchived: [] }) })
    await mount(a)
    expect(flowOf().outN).toBe('0')
    await walkTo(3)
    expect(flowOf().outN).toBe('0')
  })
  it('the last step: held while a flow is live → nothing goes over, the arrow says 0', async () => {
    const a = api({ overviewNow: { ...NEVER, flows: LIVE } })
    await mount(a)
    await walkTo(4)
    expect(flowOf().outN).toBe('0')
  })
  it('the finish: the real numbers, not the planned ones', () => {
    expect(flowFinish({ created: 3 }, { ran: true, pushed: 5 })).toEqual({ incoming: 3, outgoing: 5 })
    expect(flowFinish({ error: true }, { ran: false, reason: 'signup_flows_live' })).toEqual({ incoming: 0, outgoing: 0 })
    expect(flowFinish(null, null)).toEqual({ incoming: 0, outgoing: 0 })
    expect([0, 1, 2, 3, 4, 5].map(flowActive)).toEqual(['both', 'both', 'in', 'out', 'both', 'both'])
  })
  it('direction reads without a word: Bee Hub on the left (top on a phone), Mailchimp on the right (bottom); "in" points at Bee Hub', async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    await act(async () => { root.render(<MailchimpFlowDiagram flow={{ active: 'in', incoming: 4, outgoing: 9 }} />) })
    const boxes = Array.from(host.querySelectorAll('[data-mcf-box]')).map((b) => b.getAttribute('data-side'))
    expect(boxes).toEqual(['bee', 'mailchimp'])
    const heads = (d: string) => Array.from(host.querySelectorAll(`[data-testid="mcg-flow-${d}"] path`)).map((p) => p.getAttribute('d'))
    expect(heads('in')).toEqual(['M26 8 14 20l12 12', 'M8 26 20 14l12 12'])   // points left, and up
    expect(heads('out')).toEqual(['M14 8l12 12-12 12', 'M8 14l12 12 12-12'])  // points right, and down
    expect(host.querySelector('[data-testid="mcg-flow-out-count"]')).toBeNull()  // faint arrow, no number
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe(flowWords({ active: 'in', incoming: 4, outgoing: 9 }))
    expect(flowWords({ active: 'in', incoming: 4, outgoing: 9 })).toBe('4 people coming from Mailchimp into Bee Hub. Nobody goes to Mailchimp in this step.')
  })
  it('small and calm: no looping animation; at phone width the boxes stack and the arrows run up and down', () => {
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpFlowDiagram.jsx'), 'utf8')
    const code = src.replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/@keyframes|animation|infinite/)
    expect(src).toMatch(/@media \(max-width:639\.98px\)\{\n\[data-mcf-body\]\{display:flex;flex-direction:column/)
    expect(src).toMatch(/\[data-mcf-h\]\{display:none\}\n\[data-mcf-v\]\{display:block\}/)
  })
})

describe('the finish says what happened to their tags', () => {
  it('one quiet line for tags; a failed tag write is amber and the person still came in', () => {
    const f = finishLines({ created: 3, createdUnsubscribed: 0, alreadyThere: 0, failed: [], taggedPeople: 2, notedPeople: 1, tagsFailed: 0 }, null, 'List')
    expect(f.incoming.map((l) => l.text)).toContain(tagWords(2, 1))
    expect(tagWords(2, 1)).toBe('2 people got the Bee Hub tags that match their Mailchimp tags. 1 person had Mailchimp tags Bee Hub doesn’t have, so those are kept in a note on them.')
    const quiz = finishLines({ created: 40, failed: [], taggedPeople: 0, notedPeople: 0, quizPeople: 40, tagsFailed: 0 }, null, 'List')
    expect(quiz.incoming.map((l) => l.text)).toContain('40 people joined your mailing list by taking the quiz on your website, and a note on them says so.')
    const bad = finishLines({ created: 1, failed: [], taggedPeople: 0, notedPeople: 0, tagsFailed: 1 }, null, 'List')
    expect(bad.incoming.find((l) => l.tone === 'amber')!.text).toMatch(/came in, but their Mailchimp tags/)
    expect(bad.allWell).toBe(false)
  })
})

describe('an empty "same person?" says so warmly, both ways', () => {
  it('step 3 too', async () => {
    const a = api()
    await mount(a)
    await walkTo(3)
    expect(q('mc-phone-none')!.textContent).toBe('Nobody to checkNo one here shares a phone number with someone in your Mailchimp under a different email. You’re ready to move on.')
  })
})
