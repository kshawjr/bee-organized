// @vitest-environment happy-dom
//
// The list's bulk bar and the one-stage line (slice 6), mounted for real
// against a stand-in for every address. What this pins:
//   · pick twenty, choose a stage: ONE confirmation box, not twenty
//   · Cancel (or Escape) sends nothing, and every row reads exactly as before
//   · a yes sends ONE request with all twenty ids and confirmed: true
//   · level and stage are offered only when a Referral partner is picked
//   · fifty partners at one stage read as one plain line
//   · on All Locations nothing can be picked
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkListScreenJsx from '@/components/network/NetworkListScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const NetworkListScreen = NetworkListScreenJsx as any
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAG = { id: 't-realtor', label: 'Realtor', category: 'tags', location_id: null, is_active: true, attrs: { group: 'home_property', shows_on: ['network'] } }
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const row = (n: number, o: any = {}) => ({ id: id(n), locationId: LOC, locationName: 'Seattle', name: `Partner ${String(n).padStart(2, '0')}`, company: null, title: null, phone: null, email: null, howWeMet: null, birthday: null, networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'New Contact', isCustomer: false, lastContactedAt: null, tagIds: [], ...o })
const FIFTY = Array.from({ length: 50 }, (_, i) => row(i + 1))

let root: any = null
let host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })
const $ = (s: string) => document.querySelector(s) as HTMLElement | null
const $$ = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[]
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() }) }
const click = async (el: HTMLElement | null) => { if (!el) throw new Error('missing'); await act(async () => { el.click() }); await flush() }
const choose = async (sel: string, value: string) => {
  const el = $(sel) as HTMLSelectElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) })
  await flush()
}
const json = (body: any, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const posts: any[] = []
const fetchFor = (contacts: any[]) => vi.fn((url: string, init?: any) => {
  if (init?.method === 'POST') { const b = JSON.parse(init.body); posts.push({ url, body: b }); return json({ ok: true, action: b.action, changed: b.ids.length, changedIds: b.ids, unchanged: 0, skipped: [] }) }
  if (url.startsWith('/api/network/list')) return json({ contacts, tags: [{ id: 't-realtor', label: 'Realtor' }], followUps: {}, total: contacts.length, truncated: false })
  if (url.startsWith('/api/lookups')) return json({ lookups: [TAG] })
  return json({ referrers: [] })
})
const mount = async (contacts: any[] = FIFTY, props: any = {}) => {
  posts.length = 0
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(<NetworkListScreen locationId={LOC} locationName="Seattle" onOpenContact={() => {}} fetchImpl={fetchFor(contacts)} now={new Date('2026-11-19T12:00:00Z')} {...props} />) })
  await flush()
}
const pickFirst = async (n: number) => { for (const box of $$('[data-select]').slice(0, n)) await click(box) }
const rowsText = () => $$('[data-row]').map((r) => r.textContent).join('\n')

describe('one stage is normal', () => {
  it('fifty Referral partners at New Contact read as one line, not a board', async () => {
    await mount()
    expect($('[data-stage-line]')!.textContent).toBe('Stage: All 50 at New Contact. Level: all Referral Partner.')
  })
  it('a mix lists only the stages someone is at', async () => {
    await mount([row(1), row(2), row(3, { partnerStage: 'Active Partner', partnerLevel: 'power' }), row(4, { partnerLevel: null, partnerStage: null })])
    expect($('[data-stage-line]')!.textContent).toBe('Stage: New Contact 3 · Active Partner 1. Level: Potential 1 · Referral Partner 2 · Power Partner 1.')
  })
})

describe('bulk: asked once, and a cancel changes nothing', () => {
  it('twenty picked, a stage chosen: ONE confirmation, naming the change, not twenty', async () => {
    await mount()
    await click($('[data-select-page="partner"]')) // the first page of 25
    for (const box of $$('[data-select]').slice(20)) await click(box) // untick 5: twenty left
    expect($('[data-bulk-count]')!.textContent).toBe('20 picked')
    await choose('[data-bulk="stage"]', 'Reaching Out')
    expect($$('[data-confirm]')).toHaveLength(1)
    expect($('[data-confirm] h2')!.textContent).toBe('Move to Reaching Out: 20 contacts?')
    expect($$('[data-confirm-names] li').map((l) => l.textContent)).toEqual(['Partner 01', 'Partner 02', 'Partner 03', 'Partner 04', 'Partner 05', 'and 15 more'])
    expect(posts).toEqual([])
  })
  it('Cancel: no request at all, the twenty stay picked, and every row reads exactly as before', async () => {
    await mount()
    const before = rowsText()
    await pickFirst(20)
    await choose('[data-bulk="stage"]', 'Active Partner')
    await click($('[data-confirm-cancel]'))
    expect($('[data-confirm]')).toBeNull()
    expect(posts).toEqual([])
    expect($('[data-bulk-count]')!.textContent).toBe('20 picked')
    expect(rowsText()).toBe(before)
  })
  it('Escape cancels the same way', async () => {
    await mount()
    await pickFirst(20)
    await choose('[data-bulk="level"]', 'power')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await flush()
    expect($('[data-confirm]')).toBeNull()
    expect(posts).toEqual([])
  })
  it('a yes: ONE request, all twenty ids, confirmed, then the picks are cleared and the list read again', async () => {
    const f = fetchFor(FIFTY)
    await mount(FIFTY, { fetchImpl: f })
    await pickFirst(20)
    await choose('[data-bulk="stage"]', 'Reaching Out')
    await act(async () => { ($('[data-confirm]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEqual({ url: '/api/network/contacts/bulk', body: { location_id: LOC, ids: FIFTY.slice(0, 20).map((r) => r.id), action: 'stage', value: 'Reaching Out', confirmed: true } })
    expect($('[data-confirm]')).toBeNull()
    expect($('[data-bulk-bar]')).toBeNull()
    expect(f.mock.calls.filter(([u]: any) => String(u).startsWith('/api/network/list'))).toHaveLength(2)
    expect($('[data-act-note="done"]')!.textContent).toBe('Move to Reaching Out: 20 changed.')
  })
  it('a tag on twenty asks once too', async () => {
    await mount()
    await pickFirst(20)
    await choose('[data-bulk="tag_add"]', 't-realtor')
    expect($$('[data-confirm]')).toHaveLength(1)
    expect($('[data-confirm] h2')!.textContent).toBe('Add the tag Realtor on 20 contacts?')
  })
})

describe('who can be given a level or stage', () => {
  it('only Referral partners: with none picked, level and stage are off; with a mix, the rest are named as left alone', async () => {
    await mount([row(1, { networkTypes: ['vendor'], partnerLevel: null, partnerStage: null }), row(2, { networkTypes: null, partnerLevel: null, partnerStage: null }), row(3)])
    // only the first group (Not sure yet, since 2026-11-19) starts open; open Vendor and Referral partner
    await click($('[data-group="vendor"] .nw-group-heading'))
    await click($('[data-group="partner"] .nw-group-heading'))
    await click($(`[data-select="${id(1)}"]`))
    await click($(`[data-select="${id(2)}"]`))
    expect(($('[data-bulk="level"]') as HTMLSelectElement).disabled).toBe(true)
    expect(($('[data-bulk="stage"]') as HTMLSelectElement).disabled).toBe(true)
    await click($(`[data-select="${id(3)}"]`))
    expect(($('[data-bulk="stage"]') as HTMLSelectElement).disabled).toBe(false)
    await choose('[data-bulk="stage"]', 'Reaching Out')
    expect($('[data-confirm] h2')!.textContent).toBe('Move to Reaching Out: 1 contact?')
    expect($('[data-confirm-warn]')!.textContent).toBe('2 contacts aren’t Referral partners, so they are left as they are.')
  })
  it('on All Locations nothing can be picked', async () => {
    await mount(FIFTY, { locationId: null, onOpenContact: null })
    expect($('[data-select]')).toBeNull()
    expect($('[data-select-page]')).toBeNull()
  })
})
