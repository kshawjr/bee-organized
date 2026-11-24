// @vitest-environment happy-dom
//
// CORPORATE REVIEW of a location's own tags, on Configure › Location tags
// (components/hive/LocationTagsPanel.jsx). Kevin, 2026-11-15: promote (Make
// corporate, already there), merge, delete, or mark "reviewed, keep local".
//
// This file pins what the PANEL shows and sends. What the route then does is
// pinned in tag-create-and-review.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import LocationTagsPanel from '@/components/hive/LocationTagsPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tagRow = (over: any) => ({ id: 't1', label: 'Chamber', icon: null, is_active: true, location_id: LOC, location_name: 'Portland', created_at: '2026-10-01T00:00:00Z', created_by: 'Pat Owner', people: 3, group: 'Professional Services', reviewed: null, ...over })
const GROUPS = [
  { key: 'chamber', label: 'Chamber', locations: 1, people: 3, tags: [tagRow({})] },
  { key: 'snowbird', label: 'Snowbird', locations: 1, people: 0, tags: [tagRow({ id: 't2', label: 'Snowbird', people: 0, group: 'Client Status', reviewed: 'keep_local' })] },
  { key: 'old', label: 'Old One', locations: 1, people: 0, tags: [tagRow({ id: 't3', label: 'Old One', is_active: false, group: null })] },
]
const MAIN_LIST = [{ id: 'c1', label: 'Networking Group', icon: '🤝', location_id: null }, { id: 'c2', label: 'Realtor', icon: '🏠', location_id: null }, { id: 't1', label: 'Chamber', icon: null, location_id: LOC }, { id: 't2', label: 'Snowbird', icon: null, location_id: LOC }]

let host: HTMLElement
let root: Root
let posts: any[] = []
// FL-75 slice 3 (2026-11-23): the panel's limit is 15 (was 10 until 2026-11-23).
let sendLimit = true
const mount = async (review: (body: any) => { status: number; body: any } = (b) => (b.dryRun
  ? { status: 200, body: { dryRun: true, plan: { action: b.action, tag: { id: 't1', label: 'Chamber' }, into: b.into ? { id: b.into, label: 'Networking Group' } : null, clients: 2, network: 1, alreadyHave: { clients: 1, network: 0 } } } }
  : { status: 200, body: { ok: true, action: b.action, receipt: `done: ${b.action}` } })) => {
  posts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const u = String(url)
    const ok = (body: any, status = 200) => ({ ok: status < 300, status, json: async () => body })
    if (u === '/api/tags/review') { const body = JSON.parse(init.body); posts.push(body); const a = review(body); return ok(a.body, a.status) }
    if (u === '/api/tags/locations') return ok({ groups: GROUPS, ...(sendLimit ? { limit: 15 } : {}), limits: [{ location_id: LOC, name: 'Portland', count: 2 }] })
    if (u.startsWith('/api/tags/make-corporate')) return ok({ promotions: [] })
    if (u.startsWith('/api/lookups')) return ok({ lookups: MAIN_LIST, location: { id: LOC, name: 'Portland' } })
    return ok({})
  }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<LocationTagsPanel />) })
  await act(async () => {}); await act(async () => {})
}
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); sendLimit = true })
const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const openGroup = async (key: string) => click(host.querySelector(`[data-tag-group="${key}"] > button`))
const review = (id: string) => host.querySelector(`[data-review-tag="${id}"]`)
const button = (within: Element | null, text: string) => Array.from(within?.querySelectorAll('button') || []).find((b) => b.textContent === text)
const pick = async (el: HTMLSelectElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) })

describe('what the panel shows', () => {
  it('each location tag says which group it landed in', async () => {
    await mount(); await openGroup('chamber')
    const line = host.querySelector('[data-tag-group="chamber"]')!.textContent!
    expect(line).toContain('“Chamber” · Portland · 3 people · made ')
    expect(line).toContain(' by Pat Owner · in Professional Services')
  })
  it('a tag that is switched on can be kept local, merged or deleted', async () => {
    await mount(); await openGroup('chamber')
    expect(Array.from(review('t1')!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Reviewed, keep local', 'Merge into…', 'Delete…'])
  })
  it('a tag already reviewed says so, and is not asked about again', async () => {
    await mount(); await openGroup('snowbird')
    expect(review('t2')!.querySelector('[data-reviewed]')!.textContent).toBe('Reviewed · kept local')
    expect(Array.from(review('t2')!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Merge into…', 'Delete…'])
  })
  it('a tag the location already removed has no review buttons', async () => {
    await mount(); await openGroup('old')
    expect(review('t3')).toBeNull()
  })
  it('says how many own tags each location has, against the limit', async () => {
    await mount()
    expect(host.querySelector('[data-tag-limits]')!.textContent).toBe('Own tags in use, of 15 allowed: Portland 2')
  })
  it('with no limit in the answer, the panel still says 15 (the shared limit, never a typed 10)', async () => {
    sendLimit = false
    await mount()
    expect(host.querySelector('[data-tag-limits]')!.textContent).toBe('Own tags in use, of 15 allowed: Portland 2')
  })
})

describe('reviewed, keep local', () => {
  it('one press, sent as that, and the panel says what happened', async () => {
    await mount(); await openGroup('chamber')
    await click(button(review('t1'), 'Reviewed, keep local'))
    expect(posts).toEqual([{ id: 't1', action: 'keep_local' }])
    expect(host.querySelector('[data-review-receipt]')!.textContent).toBe('done: keep_local')
  })
})

describe('delete takes two presses', () => {
  it('the first only asks how many people would lose it, and shows the answer', async () => {
    await mount(); await openGroup('chamber')
    await click(button(review('t1'), 'Delete…'))
    expect(posts).toEqual([{ id: 't1', action: 'delete', dryRun: true }])
    expect(host.querySelector('[data-review-plan]')!.textContent).toContain('“Chamber” will be taken off 2 clients and 1 Network person, then deleted. There is no undo button for this.')
  })
  it('only the second press deletes', async () => {
    await mount(); await openGroup('chamber')
    await click(button(review('t1'), 'Delete…'))
    await click(button(review('t1'), 'Delete tag'))
    expect(posts).toEqual([{ id: 't1', action: 'delete', dryRun: true }, { id: 't1', action: 'delete' }])
    expect(host.querySelector('[data-review-receipt]')!.textContent).toBe('done: delete')
  })
  it('Back sends nothing more', async () => {
    await mount(); await openGroup('chamber')
    await click(button(review('t1'), 'Delete…')); await click(button(review('t1'), 'Back'))
    expect(posts).toEqual([{ id: 't1', action: 'delete', dryRun: true }])
    expect(button(review('t1'), 'Delete…')).toBeTruthy()
  })
})

describe('merge takes a tag to merge into, then two presses', () => {
  it('offers the main list and the same location\'s own tags, never the tag itself', async () => {
    await mount(); await openGroup('chamber')
    await click(button(review('t1'), 'Merge into…'))
    const options = Array.from(review('t1')!.querySelectorAll('option')).map((o) => o.textContent)
    expect(options).toEqual(['Merge into which tag?', '🤝 Networking Group', '🏠 Realtor', 'Snowbird (their own)'])
  })
  it('Preview is off until a tag is picked; the preview says who moves; the second press merges', async () => {
    await mount(); await openGroup('chamber')
    await click(button(review('t1'), 'Merge into…'))
    expect((button(review('t1'), 'Preview') as HTMLButtonElement).disabled).toBe(true)
    await pick(review('t1')!.querySelector('select') as HTMLSelectElement, 'c1')
    await click(button(review('t1'), 'Preview'))
    expect(posts).toEqual([{ id: 't1', action: 'merge', into: 'c1', dryRun: true }])
    expect(host.querySelector('[data-review-plan]')!.textContent).toContain('2 clients and 1 Network person carrying “Chamber” will carry “Networking Group” instead (1 already do). Then “Chamber” is deleted.')
    await click(button(review('t1'), 'Merge'))
    expect(posts.at(-1)).toEqual({ id: 't1', action: 'merge', into: 'c1' })
  })
  it('a refusal is shown and nothing is claimed', async () => {
    await mount((b) => (b.dryRun ? { status: 400, body: { error: 'into_wrong_location' } } : { status: 200, body: {} }))
    await openGroup('chamber')
    await click(button(review('t1'), 'Merge into…'))
    await pick(review('t1')!.querySelector('select') as HTMLSelectElement, 'c1'); await click(button(review('t1'), 'Preview'))
    expect(review('t1')!.querySelector('[role="alert"]')!.textContent).toBe('into_wrong_location')
    expect(host.querySelector('[data-review-receipt]')).toBeNull()
  })
})
