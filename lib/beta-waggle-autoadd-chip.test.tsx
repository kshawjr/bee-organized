// @vitest-environment happy-dom
//
// A line that arrived from the command line is an ORDINARY line — the
// editor sees a quiet "From a deploy" chip on it and the same pencil as
// on any other; an owner sees the line and no chip.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import WhatsNew from '@/components/help/WhatsNew'

const line = (over: any) => ({ id: 'x', release_id: 'r', group: 'fixed', title: 'Line', body: 'Sentence.', edited_at: '2026-09-01T00:00:00Z', unedited: false, ...over })
const auto = line({ id: 'a1', title: 'Finished jobs will actually close now', body: 'Two clicks now.', created_by: null, feedback_item_id: null })
const byKevin = line({ id: 'k1', title: 'Time zone is a dropdown', body: 'Arizona is its own entry.', created_by: 'u-kevin', feedback_item_id: null })
const seeded = line({ id: 's1', title: 'Inbox has a circle 1', body: null, edited_at: null, unedited: true, created_by: 'u-kevin', feedback_item_id: 'fb-1' })
const DRAFT = { id: 'r-draft', week_start: '2026-09-04', publish_on: '2026-09-10', status: 'draft', summary: null, week_label: 'Thu, Sep 10', groups: { new: [], changed: [], fixed: [auto, byKevin, seeded], question: [] }, item_count: 3, unedited_count: 1 }
const PUB = { id: 'r-pub', week_start: '2026-08-28', publish_on: '2026-09-03', status: 'published', summary: null, published_at: 't', week_label: 'Thu, Sep 3', number: 12, groups: { new: [], changed: [], fixed: [line({ id: 'p1', title: 'Closed Lost works', created_by: 'u-kevin', feedback_item_id: null })], question: [] }, item_count: 1, unedited_count: 0 }

function stubFetch(payload: any) {
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
}
async function mount(el: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

describe('the From a deploy chip', () => {
  it('editor: only the line with no author wears it, and it has the same pencil as the others', async () => {
    stubFetch({ releases: [PUB], draft: DRAFT, canEdit: true })
    const { host, unmount } = await mount(<WhatsNew canEdit />)
    const chips = Array.from(host.querySelectorAll('[data-whatsnew-auto]')).map(e => [e.getAttribute('data-whatsnew-auto'), e.textContent])
    expect(chips).toEqual([['a1', 'From a deploy']])
    expect(host.querySelector('[aria-label="Edit Finished jobs will actually close now"]')).toBeTruthy()
    expect(host.querySelector('[data-whatsnew-item="a1"]')!.getAttribute('data-whatsnew-unedited')).toBeNull()
    expect((host.querySelector('[data-whatsnew-item="a1"]') as HTMLElement).style.opacity).toBe('1')
    // the number, for editors only, on the published card
    expect(host.querySelector('[data-whatsnew-number="12"]')!.textContent).toBe('No. 12')
    await unmount()
  })
  it('owner: the line, no chip', async () => {
    const { number: _hidden, ...pubForOwner } = PUB
    const ownerPub = { ...pubForOwner, groups: { new: [], changed: [], fixed: [line({ id: 'p1', title: 'Finished jobs will actually close now' })], question: [] } }
    stubFetch({ releases: [ownerPub], draft: null, canEdit: false })
    const { host, unmount } = await mount(<WhatsNew canEdit={false} />)
    expect(host.textContent).toContain('Finished jobs will actually close now')
    expect(host.querySelector('[data-whatsnew-auto]')).toBeNull()
    expect(host.querySelector('[data-whatsnew-number]')).toBeNull()
    await unmount()
  })
})
