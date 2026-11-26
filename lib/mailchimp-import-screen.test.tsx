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
  location: { name: 'Test Location', audienceId: 'aud1' }, read: 9,
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

async function mount(post: (body: any) => { status: number; json: any }) {
  const calls: Array<{ url: string; init: any }> = []
  const fetchImpl = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, init })
    if (init.method === 'POST') { const r = post(JSON.parse(init.body)); return { ok: r.status < 300, status: r.status, json: async () => r.json } }
    return { ok: true, status: 200, json: async () => ({ ok: true, model: MODEL }) }
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
    expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(0)
    await click(q('mci-continue'))
    expect(q('mci-confirm-count')!.textContent).toBe('Bring 1 person into Test Location?')
    expect(q('mci-confirm-unsub')!.textContent).toMatch(/No marketing emails/)
    expect(calls.filter((c) => c.init.method === 'POST')).toHaveLength(0)
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
  it('nobody ticked → nothing to confirm', async () => {
    await mount(() => ({ status: 200, json: {} }))
    await click(q('mci-group-create')!.querySelector('input[type=checkbox]'))
    expect((q('mci-continue') as HTMLButtonElement).disabled).toBe(true)
  })
})
