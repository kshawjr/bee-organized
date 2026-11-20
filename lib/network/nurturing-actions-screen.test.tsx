// @vitest-environment happy-dom
//
// Slice 8 on screen: selecting Nurturing people (a page, or all 18,825), the
// bulk bar, the ONE confirmation that names the number, a cancel, the run, a
// failure, and one person's tags, follow-up and client-record link. The fake
// server keeps a real lead_tags store so "nothing changed" is a fingerprint.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NurturingScreen from '@/components/network/NurturingScreen'
import { fixedDateLabel } from '@/lib/reminders'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAG = '11111111-1111-4111-8111-111111111111'
const NOW = Date.parse('2026-11-20T15:00:00Z')
const NO_MKT = new Set(['p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p30'])
const row = (i: number) => ({
  id: `p${i}`, name: `Person ${String(i).padStart(5, '0')}`, email: `p${i}@x.com`, phone: null, city: 'Media', zip: '19063',
  createdAt: '2025-01-01T00:00:00Z', needsContactInfo: false, lastActivity: null, noMarketing: NO_MKT.has(`p${i}`),
})

let people: any[] = []
let store: Set<string> // lead ids holding TAG: the server's state
let calls: { url: string; method: string; body: any }[] = []
let bulkMode: 'ok' | 'hold' | 'fail_nothing' | 'fail_partly' | 'changed' = 'ok'
let release: (() => void) | null = null
const fp = () => createHash('sha256').update(Array.from(store).sort().join(',')).digest('hex')
const reply = (status: number, body: any) => ({ ok: status < 300, status, json: async () => body })
const plan = (ids: string[], action: string) => {
  const noMarketing = ids.filter((id) => NO_MKT.has(id))
  const rest = ids.filter((id) => !NO_MKT.has(id))
  const already = rest.filter((id) => (action === 'tag_add' ? store.has(id) : !store.has(id)))
  const change = rest.filter((id) => !already.includes(id))
  const n = (k: number) => k.toLocaleString('en-US')
  return {
    selected: ids.length, noMarketing: noMarketing.length, already: already.length, change: change.length, changeIds: change,
    question: action === 'tag_add' ? `Add “Garage” to ${n(change.length)} ${change.length === 1 ? 'person' : 'people'}?` : `Take “Garage” off ${n(change.length)} ${change.length === 1 ? 'person' : 'people'}?`,
    leftOut: [noMarketing.length ? `${noMarketing.length} people who said no to marketing are left out. Nobody can change that from here.` : null].filter(Boolean),
    names: change.slice(0, 5).map((id) => people.find((p) => p.id === id)?.name), tag: { id: TAG, label: 'Garage' },
  }
}
const server = vi.fn(async (url: string, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : null
  calls.push({ url, method: init?.method || 'GET', body })
  const u = new URL(url, 'http://x')
  if (u.pathname === '/api/network/nurturing' && (init?.method || 'GET') === 'GET') {
    const size = Number(u.searchParams.get('size'))
    const q = (u.searchParams.get('q') || '').toLowerCase()
    const rows = q ? people.filter((r) => r.name.toLowerCase().includes(q)) : people
    const page = Math.min(Number(u.searchParams.get('page')), Math.max(0, Math.ceil(rows.length / size) - 1))
    return reply(200, { location: { id: LOC, name: 'Philadelphia Suburbs' }, quietDays: 90, excluded: false,
      counts: { nurturing: people.length, needsContactInfo: 0, hadQuoteOrAssessment: 0 }, total: rows.length, page, size, sort: 'az',
      rows: rows.slice(page * size, (page + 1) * size), tags: [{ id: TAG, label: 'Garage', icon: null, own: false }] })
  }
  if (u.pathname === '/api/network/nurturing/bulk') {
    const ids = body.selection.all ? people.map((p) => p.id) : body.selection.ids
    const pl = plan(ids, body.action)
    if (body.dry_run) return reply(200, { dry_run: true, ...pl })
    if (bulkMode === 'changed') { bulkMode = 'ok'; return reply(409, { error: 'count_changed', ...pl, change: pl.change - 3, question: 'Add “Garage” to 18,812 people?' }) }
    if (body.expected !== pl.change) return reply(409, { error: 'count_changed', ...pl })
    if (bulkMode === 'hold') await new Promise<void>((r) => { release = r })
    if (bulkMode === 'fail_nothing') return reply(500, { ok: false, state: 'nothing_changed', wrote: 9000, undone: 9000, leftChanged: [], words: 'That didn’t finish, so nothing was changed: the 9,000 already done were put back. Check the connection and try again.' })
    if (bulkMode === 'fail_partly') { pl.changeIds.slice(0, 500).forEach((id) => store.add(id)); return reply(500, { ok: false, state: 'partly_changed', wrote: 9000, undone: 8500, leftChanged: pl.changeIds.slice(0, 500), words: 'That didn’t finish, and 500 people could not be put back: they still have “Garage”. Run the same action again to finish it for everyone.' }) }
    pl.changeIds.forEach((id) => (body.action === 'tag_add' ? store.add(id) : store.delete(id)))
    return reply(200, { ok: true, changed: pl.change, ...pl })
  }
  if (/\/api\/network\/nurturing\/[^/]+\/follow-up$/.test(u.pathname)) {
    const id = u.pathname.split('/')[4]
    if (NO_MKT.has(id)) return reply(403, { error: 'said_no_to_marketing' })
    return reply(201, { reminder: { id: 'r1', lead_id: id, due_on: body.due_on, note: body.note } })
  }
  if (u.pathname.startsWith('/api/network/nurturing/')) {
    const id = u.pathname.split('/').pop()!
    const p = people.find((r) => r.id === id)!
    return reply(200, {
      person: { id, name: p.name, company: null, email: p.email, phone: null, address: null, cityLine: 'Media, PA 19063', source: null, projectType: null, requestDetails: null, notes: null, createdAt: p.createdAt, locationName: 'Philadelphia Suburbs', locationId: LOC, preferredContact: null, marketing: { state: p.noMarketing ? 'opted_out' : 'ok', at: null }, needsContactInfo: false, noMarketing: p.noMarketing },
      verdict: { nurturing: true, why: null, needsContactInfo: false, lastActivity: null }, quietDays: 90,
      assessments: [], quotes: [], jobs: [], requests: [], engagements: [], touchpoints: [],
      tags: store.has(id) ? [{ id: TAG, label: 'Garage', icon: null }] : [], followUps: [],
    })
  }
  return reply(404, {})
})

let host: HTMLElement
let root: ReturnType<typeof createRoot>
let opened: string[] = []
beforeEach(() => {
  calls = []; bulkMode = 'ok'; release = null; opened = []; server.mockClear()
  people = Array.from({ length: 18825 }, (_, i) => row(i))
  store = new Set(['p0', 'p1'])
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const settle = async (k = 6) => { for (let i = 0; i < k; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const wait = async (ms: number) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }); await settle() }
const mount = async () => { await act(async () => { root.render(React.createElement(NurturingScreen as any, { locationId: LOC, locationName: 'Philadelphia Suburbs', fetchImpl: server, nowMs: NOW, onOpenClient: (id: string) => opened.push(id) })) }); await settle() }
const $ = (s: string) => document.body.querySelector(s) as HTMLElement | null
const text = (s: string) => $(s)?.textContent?.replace(/\s+/g, ' ').trim()
const click = async (el: Element | null) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const choose = async (el: Element | null, value: string) => {
  const s = el as HTMLSelectElement
  await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(s, value); s.dispatchEvent(new Event('change', { bubbles: true })) })
  await settle()
}
const type = async (el: Element | null, value: string) => {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value); el!.dispatchEvent(new Event('input', { bubbles: true })) })
  await settle()
}
const key = async (k: string) => { await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) }); await settle() }
const writes = () => calls.filter((c) => c.method !== 'GET' && !c.body?.dry_run)

async function selectAllAndAsk() {
  await mount()
  await click($('[data-select-page]'))
  expect(text('[data-picked-count]')).toBe('25 selected')
  await click($('[data-select-all]'))
  expect(text('[data-picked-count]')).toBe('18,825 selected (everyone here)')
  expect(text('[data-bulk-count]')).toBe('18,825 selected')
  await choose($('[data-bulk-tag]'), TAG)
  await click($('[data-bulk-go]'))
}

describe('18,825 selected', () => {
  it('one confirmation, and it names the exact number before anything runs', async () => {
    await selectAllAndAsk()
    expect(text('[data-bulk-question]')).toBe('Add “Garage” to 18,815 people?')
    expect(text('[data-bulk-yes]')).toBe('Yes, add to 18,815 people')
    expect(text('[data-bulk-more]')).toBe('and 18,810 more')
    expect(text('[data-bulk-left-out]')).toBe('8 people who said no to marketing are left out. Nobody can change that from here.')
    expect(document.querySelectorAll('[data-nurture-bulk]')).toHaveLength(1)
    // the request asked about everyone here, not 25 ids
    const asked = calls.find((c) => c.body?.dry_run)!
    expect(asked.body.selection).toEqual({ all: true, q: '', needs_contact: false })
    expect(writes()).toHaveLength(0)
  })
  it('Cancel changes nothing, by fingerprint, and sends nothing more', async () => {
    const before = fp()
    await selectAllAndAsk()
    const sent = calls.length
    await click($('[data-bulk-cancel]'))
    expect($('[data-nurture-bulk]')).toBeNull()
    expect(fp()).toBe(before)
    expect(calls.length).toBe(sent)
    expect(writes()).toHaveLength(0)
    expect(text('[data-bulk-count]')).toBe('18,825 selected') // the selection is still there
  })
  it('a click outside the confirmation never closes it; Escape is Cancel', async () => {
    await selectAllAndAsk()
    await click($('[data-nurture-bulk]'))
    await click(document.body)
    expect($('[data-bulk-question]')).toBeTruthy()
    await key('Escape')
    expect($('[data-nurture-bulk]')).toBeNull()
    expect(writes()).toHaveLength(0)
  })
  it('the yes runs it once for the whole selection; mid-run it says so and cannot be closed', async () => {
    bulkMode = 'hold'
    await selectAllAndAsk()
    await click($('[data-bulk-yes]'))
    expect(text('[data-bulk-running]')).toBe('Adding “Garage” to 18,815 people…')
    expect($('[data-bulk-cancel]')).toBeNull()
    await key('Escape')
    expect($('[data-bulk-running]')).toBeTruthy()
    expect(writes()).toHaveLength(1)
    expect(writes()[0].body).toMatchObject({ confirmed: true, expected: 18815, selection: { all: true } })
    await act(async () => { release!() }); await settle()
    expect(text('[data-bulk-done]')).toBe('Added “Garage” to 18,815 people.')
    await click($('[data-bulk-close]'))
    expect($('[data-bulk-bar]')).toBeNull() // done: the selection is cleared
    expect(store.size).toBe(18817)
  })
  it('a failure that put everything back says nothing changed', async () => {
    bulkMode = 'fail_nothing'
    const before = fp()
    await selectAllAndAsk()
    await click($('[data-bulk-yes]'))
    expect($('[data-bulk-failed]')!.getAttribute('data-state')).toBe('nothing_changed')
    expect(text('[data-bulk-failed-title]')).toBe('Nothing was changed')
    expect(text('[data-bulk-failed]')).toContain('nothing was changed')
    expect(fp()).toBe(before)
  })
  it('a failure that could not all be put back names how many are left changed, and Try again finishes it', async () => {
    bulkMode = 'fail_partly'
    await selectAllAndAsk()
    await click($('[data-bulk-yes]'))
    expect($('[data-bulk-failed]')!.getAttribute('data-state')).toBe('partly_changed')
    expect(text('[data-bulk-failed-title]')).toBe('Only partly done')
    expect(text('[data-bulk-failed]')).toBe('That didn’t finish, and 500 people could not be put back: they still have “Garage”. Run the same action again to finish it for everyone.')
    bulkMode = 'ok'
    await click($('[data-bulk-again]'))
    expect(text('[data-bulk-question]')).toBe('Add “Garage” to 18,315 people?')
    await click($('[data-bulk-yes]'))
    expect(store.size).toBe(18817)
  })
  it('if the list changed while deciding, nothing is written and the new number is asked', async () => {
    bulkMode = 'changed'
    await selectAllAndAsk()
    await click($('[data-bulk-yes]'))
    expect(text('[data-bulk-changed]')).toContain('nothing was changed')
    expect(text('[data-bulk-question]')).toBe('Add “Garage” to 18,812 people?')
  })
  it('a different search clears the selection: it would no longer mean the same people', async () => {
    await mount()
    await click($('[data-select-page]'))
    await type($('[data-search]'), 'Person 0001')
    await wait(350)
    expect($('[data-bulk-bar]')).toBeNull()
  })
})

describe('one person', () => {
  it('adds a tag through the same route, one person selected, and says so', async () => {
    await mount()
    await click($('[data-row="p5"]'))
    await choose($('[data-tag-pick]'), TAG)
    await click($('[data-tag-add]'))
    const mine = calls.filter((c) => c.url === '/api/network/nurturing/bulk')
    expect(mine.map((c) => [c.body.dry_run ?? false, c.body.expected ?? null, c.body.selection])).toEqual([[true, null, { ids: ['p5'] }], [false, 1, { ids: ['p5'] }]])
    expect(text('[data-tag-msg]')).toBe('Added “Garage”.')
    expect(store.has('p5')).toBe(true)
    await click($('[data-tag-remove="' + TAG + '"]'))
    expect(store.has('p5')).toBe(false)
  })
  it('sets a follow-up: a reminder, on the Reminders page', async () => {
    await mount()
    await click($('[data-row="p5"]'))
    await click($('[data-due="week"]'))
    await type($('[data-follow-up-note]'), 'Ask about the garage')
    await key('Escape') // typed note: Escape does not throw it away
    expect($('[data-nurture-person]')).toBeTruthy()
    await click($('[data-follow-up-save]'))
    const c = calls.find((x) => x.url === '/api/network/nurturing/p5/follow-up')!
    expect(c.body).toEqual({ due_on: '2026-11-27', note: 'Ask about the garage' })
    expect(text('[data-follow-up-msg]')).toBe(`Follow-up set for ${fixedDateLabel('2026-11-27')}. It’s on your Reminders page.`)
  })
  it('opens the full client record for exactly this person', async () => {
    await mount()
    await click($('[data-row="p7"]'))
    await click($('[data-open-client="p7"]'))
    expect(opened).toEqual(['p7'])
    expect($('[data-nurture-person]')).toBeNull()
  })
  it('someone who said no to marketing: no tag or follow-up controls, one plain line, the record link stays', async () => {
    await mount()
    expect($('[data-row="p10"]')!.querySelector('[data-flag="no-marketing"]')!.textContent).toBe('Said no to marketing')
    await click($('[data-row="p10"]'))
    expect(text('[data-pill="opted-out"]')).toBe('Said no to marketing') // the same words in the list and the person view
    expect($('[data-tag-pick]')).toBeNull()
    expect($('[data-follow-up-form]')).toBeNull()
    expect(text('[data-no-marketing-line]')).toBe('Person 00010 said no to marketing, so tags and follow-ups can’t be set here. Nobody can change that from Nurturing.')
    expect($('[data-open-client="p10"]')).toBeTruthy()
  })
})

describe('nothing Mailchimp, anywhere', () => {
  it('not in any Nurturing file, and not on screen', async () => {
    for (const f of ['components/network/NurturingScreen.jsx', 'components/network/NurtureSheet.jsx', 'components/network/NurtureBulkConfirm.jsx', 'lib/network/nurturing-actions.ts', 'lib/network/nurturing-read.ts', 'app/api/network/nurturing/bulk/route.ts', 'app/api/network/nurturing/route.ts', 'app/api/network/nurturing/[id]/route.ts']) {
      const code = readFileSync(join(process.cwd(), f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
      expect(code, f).not.toMatch(/mailchimp|crm drip|in a drip/i)
    }
    await mount()
    await click($('[data-row="p5"]'))
    expect(document.body.textContent).not.toMatch(/mailchimp|drip/i)
  })
})
