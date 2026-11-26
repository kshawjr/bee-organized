// @vitest-environment happy-dom
// FL-75 slice 7: the owner's review screen — "Who comes in from Mailchimp".
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import MailchimpImportScreen, { importTally } from '@/components/settings/MailchimpImportScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
const MODEL = {
  location: { name: 'Test Location', audienceId: 'aud1' }, read: 9, choicesReady: true, group: null,
  create: [
    { k: 'm1', e: 'one@example.org', n: 'Ana Ruiz', s: 'subscribed', j: '2024-07-01T10:00:00+00:00' },
    { k: 'm2', e: 'two@example.org', n: null, s: 'unsubscribed', j: '2024-07-02T10:00:00+00:00' },
  ],
  held: [{ k: 'm3', e: 'three@example.org', n: null, s: 'subscribed', j: null, reason: 'phone_match', match: { n: 'Pat Lee', e: 'pat@x.com' } }],
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
    const t = importTally(MODEL, new Set(['m1']))
    expect(t.bringing + t.unticked + t.held + t.skipped + t.already).toBe(t.total)
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
})
