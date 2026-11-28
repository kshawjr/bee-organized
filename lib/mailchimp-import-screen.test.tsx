// @vitest-environment happy-dom
// FL-75 slice 7: the owner's review screen — "Who comes in from Mailchimp".
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import MailchimpImportScreen, { importTally, HELD_WORDS, HELD_CHOICES, TAG_LINE } from '@/components/settings/MailchimpImportScreen'
import { readFileSync } from 'fs'
import { join } from 'path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
const MODEL = {
  location: { name: 'Test Location', audienceId: 'aud1' }, read: 9, choicesReady: true, group: null,
  create: [
    { k: 'm1', e: 'one@example.org', n: 'Ana Ruiz', s: 'subscribed', j: '2024-07-01T10:00:00+00:00' },
    { k: 'm2', e: 'two@example.org', n: null, s: 'unsubscribed', j: '2024-07-02T10:00:00+00:00' },
  ],
  held: [{ k: 'm3', e: 'three@example.org', n: null, s: 'subscribed', j: null, reason: 'phone_match', p: '4235550100', match: { n: 'Pat Lee', e: 'pat@x.com', p: '423-555-0100' } }],
  skipped: { total: 2, byReason: { staff: 1, cleaned: 1 } },
  already: 4,
}

let root: Root | null = null
let box: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove() })
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() }) }
const q = (id: string) => box.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement).click() }); await flush() }

async function mount(post: (body: any) => { status: number; json: any }, model: any = MODEL, saveStatus = 200) {
  const calls: Array<{ url: string; init: any }> = []
  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init })
    if (init.method === 'POST' && url === '/api/mailchimp/import/choice') return { ok: saveStatus < 300, status: saveStatus, json: async () => (saveStatus < 300 ? { ok: true } : { error: 'failed', words: 'Your choice could not be saved. Please try again.' }) }
    if (init.method === 'POST') { const r = post(JSON.parse(init.body)); return { ok: r.status < 300, status: r.status, json: async () => r.json } }
    return { ok: true, status: 200, json: async () => ({ ok: true, model }) }
  })
  box = document.createElement('div'); document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => { root!.render(<MailchimpImportScreen locationId={LOC} onClose={() => {}} fetchImpl={fetchImpl as any} />) })
  await flush()
  return calls
}

describe('Who comes in from Mailchimp', () => {
  it('parts of the big number add up to everyone in Mailchimp', () => {
    for (const hs of [{}, { m3: 'in' }, { m3: 'out' }]) {
      const t = importTally(MODEL, new Set(['m1']), hs)
      expect(t.bringing + t.unticked + t.heldSame + t.heldOpen + t.skipped + t.already).toBe(t.total)
    }
    expect(importTally(MODEL, new Set(['m1']), { m3: 'in' }).bringing).toBe(2)
    expect(importTally(MODEL, new Set(['m1']), { m3: 'out' }).bringing).toBe(1)
  })
  it('opens with everyone new ticked, held people listed without a tick, skipped counted', async () => {
    await mount(() => ({ status: 200, json: {} }))
    expect(q('mci-title')!.textContent).toBe('Who comes in from Mailchimp')
    expect(q('mci-nothing-yet')!.textContent).toMatch(/Nobody is brought in until you confirm/)
    expect(q('mci-big-number')!.textContent).toBe('2')
    expect(q('mci-big-words')!.textContent).toMatch(/people will be brought into Test Location/)
    const held = q('mci-held')!
    expect(held.textContent).toMatch(/Pat Lee/)
    expect(held.querySelector('input[type=checkbox]')).toBeNull()
    expect(q('mci-held-person')!.getAttribute('data-answer')).toBe('none')
    expect(q('mci-skipped')!.textContent).toMatch(/Bee Organized team address/)
  })
  it('unticking one person lowers the number; confirming sends exactly the ticked people', async () => {
    let sent: any = null
    const calls = await mount((b) => { sent = b; return { status: 200, json: { ok: true, created: 1, createdUnsubscribed: 1, alreadyThere: 0, failed: [] } } })
    await click(q('mci-see'))
    const boxes = box.querySelectorAll('[data-testid="mci-person"] input[type=checkbox]')
    await click(boxes[0])
    expect(q('mci-big-number')!.textContent).toBe('1')
    const imports = () => calls.filter((c) => c.init.method === 'POST' && c.url === '/api/mailchimp/import')
    expect(imports()).toHaveLength(0)
    await click(q('mci-continue'))
    expect(q('mci-confirm-count')!.textContent).toBe('Bring 1 person into Test Location?')
    expect(q('mci-confirm-unsub')!.textContent).toMatch(/No marketing emails/)
    expect(imports()).toHaveLength(0)
    await click(q('mci-yes'))
    expect(sent).toEqual({ location_id: LOC, member_ids: ['m2'], count: 1 })
    expect(q('mci-result')!.textContent).toMatch(/1 person brought into Bee Hub/)
  })
  it('if something changed, nobody is brought in and the fresh review is shown', async () => {
    await mount(() => ({ status: 409, json: { error: 'changed', model: { ...MODEL, create: [MODEL.create[0]] } } }))
    await click(q('mci-continue'))
    await click(q('mci-yes'))
    expect(q('mci-changed')).not.toBeNull()
    expect(q('mci-big-number')!.textContent).toBe('1')
    expect(q('mci-result')).toBeNull()
  })
  it('each tick is saved as it is made, only as a difference from "ticked"', async () => {
    const calls = await mount(() => ({ status: 200, json: {} }))
    await click(q('mci-see'))
    await click(box.querySelectorAll('[data-testid="mci-person"] input[type=checkbox]')[0])   // untick one@
    await click(box.querySelectorAll('[data-testid="mci-person"] input[type=checkbox]')[0])   // tick back: back to default
    await click(q('mci-group-create')!.querySelector('input[type=checkbox]'))                 // untick the group
    const saved = calls.filter((c) => c.url === '/api/mailchimp/import/choice').map((c) => JSON.parse(c.init.body))
    expect(saved).toEqual([
      { location_id: LOC, scope: 'person', key: 'one@example.org', choice: 'out' },
      { location_id: LOC, scope: 'person', key: 'one@example.org', choice: null },
      { location_id: LOC, scope: 'group', key: 'new', choice: 'out' },
    ])
  })
  it('coming back shows the saved ticks', async () => {
    // Saved earlier: the group unticked, two@ ticked back in by hand.
    await mount(() => ({ status: 200, json: {} }), { ...MODEL, group: 'out', create: [MODEL.create[0], { ...MODEL.create[1], c: 'in' }] })
    expect(q('mci-big-number')!.textContent).toBe('1')
    expect((q('mci-group-create')!.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
    expect(q('mci-one-by-one')!.textContent).toMatch(/1 changed one by one/)
    await click(q('mci-see'))
    const b = box.querySelectorAll('[data-testid="mci-person"] input[type=checkbox]') as NodeListOf<HTMLInputElement>
    expect([b[0].checked, b[1].checked]).toEqual([false, true])
  })
  it('a tick that could not be saved goes back, and the owner is told', async () => {
    await mount(() => ({ status: 200, json: {} }), MODEL, 500)
    await click(q('mci-see'))
    await click(box.querySelectorAll('[data-testid="mci-person"] input[type=checkbox]')[0])
    expect(q('mci-big-number')!.textContent).toBe('2')
    expect(q('mci-save-err')!.textContent).toMatch(/could not be saved/)
  })
  it('until saving is switched on, ticks cannot be changed', async () => {
    await mount(() => ({ status: 200, json: {} }), { ...MODEL, choicesReady: false })
    expect(q('mci-not-ready')).not.toBeNull()
    expect((q('mci-group-create')!.querySelector('input[type=checkbox]') as HTMLInputElement).disabled).toBe(true)
  })
  it('nobody ticked → nothing to confirm', async () => {
    await mount(() => ({ status: 200, json: {} }))
    await click(q('mci-group-create')!.querySelector('input[type=checkbox]'))
    expect((q('mci-continue') as HTMLButtonElement).disabled).toBe(true)
  })

  // ── "Same person?" cut to one case (Kevin, 2026-11-27) ──
  it('only phone matches can appear as "same person?"; name and other-location matches have no words at all', () => {
    expect(Object.keys(HELD_WORDS).sort()).toEqual(['duplicate_in_mailchimp', 'phone_match'])
    expect(HELD_WORDS.phone_match).toMatch(/phone/i)
    expect(HELD_WORDS.duplicate_in_mailchimp).toMatch(/phone/i)
    const src = readFileSync(join(process.cwd(), 'components/settings/MailchimpImportScreen.jsx'), 'utf8')
    expect(src).not.toMatch(/name_match|other_location|another location|same name as/i)
  })
  it('each row says why, shows both sides with phones, and says what each answer does', async () => {
    await mount(() => ({ status: 200, json: {} }))
    const row = q('mci-held-person')!
    expect(q('mci-held-why')!.textContent).toBe('Same phone number as someone already in Bee Hub, but a different email.')
    expect(row.textContent).toMatch(/In Mailchimp.*three@example\.org.*Phone 4235550100.*Already in Bee Hub.*Pat Lee.*pat@x\.com.*Phone 423-555-0100/)
    expect(HELD_CHOICES.map((o) => `${o.label}: ${o.does}`)).toEqual(['Same person: Not added again', 'Different people: Added as new', 'Leave out for now: Not added this time'])
    for (const o of HELD_CHOICES) expect(row.textContent).toContain(o.does)
    expect((q('mci-held-later')!.querySelector('input') as HTMLInputElement).checked).toBe(true)
  })
  it('"Different people" saves, raises the number, and the confirm sends them; "Same person" and "Leave out" keep them out', async () => {
    let sent: any = null
    const calls = await mount((b) => { sent = b; return { status: 200, json: { ok: true, created: 3, createdUnsubscribed: 1, alreadyThere: 0, failed: [] } } })
    const saves = () => calls.filter((c) => c.url === '/api/mailchimp/import/choice').map((c) => JSON.parse(c.init.body))
    await click(q('mci-held-in')!.querySelector('input'))
    expect(q('mci-big-number')!.textContent).toBe('3')
    expect(saves().at(-1)).toEqual({ location_id: LOC, scope: 'person', key: 'three@example.org', choice: 'in' })
    await click(q('mci-held-out')!.querySelector('input'))
    expect(q('mci-big-number')!.textContent).toBe('2')
    expect(q('mci-tally')!.textContent).toMatch(/1 the same person/)
    expect(saves().at(-1)).toMatchObject({ key: 'three@example.org', choice: 'out' })
    await click(q('mci-held-later')!.querySelector('input'))
    expect(saves().at(-1)).toMatchObject({ key: 'three@example.org', choice: null })
    expect(q('mci-tally')!.textContent).toMatch(/1 left out for now/)
    await click(q('mci-held-in')!.querySelector('input'))
    await click(q('mci-continue'))
    await click(q('mci-yes'))
    expect(sent).toEqual({ location_id: LOC, member_ids: ['m1', 'm2', 'm3'], count: 3 })
  })
  it('unticking the whole group never touches a held person', async () => {
    await mount(() => ({ status: 200, json: {} }), { ...MODEL, held: [{ ...MODEL.held[0], c: 'in' }] })
    expect(q('mci-big-number')!.textContent).toBe('3')
    await click(box.querySelector('[aria-label="New to Bee Hub"]'))
    expect(q('mci-big-number')!.textContent).toBe('1')
    expect(q('mci-held-person')!.getAttribute('data-answer')).toBe('in')
  })
  it('an empty section says so warmly, not a blank panel', async () => {
    await mount(() => ({ status: 200, json: {} }), { ...MODEL, held: [] })
    expect(q('mci-held-none')!.textContent).toMatch(/^Nobody to check.*You’re ready to move on\.$/)
  })
  it('the tag rule is said once, in plain words', async () => {
    await mount(() => ({ status: 200, json: {} }))
    expect(q('mci-tag-line')!.textContent).toBe(TAG_LINE)
    expect(TAG_LINE).toMatch(/same name/)
    expect(TAG_LINE).toMatch(/note/)
    expect(TAG_LINE).toMatch(/joined by taking the quiz on your website gets a note/)
    expect(TAG_LINE).not.toMatch(/Profile Quiz|CLOSEDJOB/i)
  })
})
