// @vitest-environment happy-dom
//
// issue 204 — the "Close — not interested" affordance in the Inbox RowMenu.
// Gated exactly like Mark as junk: present on a normal owned row, hidden on
// Jobber-linked rows (Jobber owns their lifecycle), and absent on read-only
// surfaces (the whole ··· cluster is readOnly-gated). Picking it opens the
// CloseLostWizard (title "Close as lost").
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Watts',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3), // < 30d, no outreach → derived New (renders a row)
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [],
  ...over,
})

beforeEach(() => {
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    const method = init?.method
    if (method === 'POST' && /\/api\/engagements$/.test(u)) return { ok: true, json: async () => ({ engagement: { id: 'eng-NEW' } }) } as any
    if (method === 'PATCH' && /\/api\/engagements\//.test(u)) return { ok: true, json: async () => ({ id: 'eng-NEW', stage: 'Closed Lost' }) } as any
    if (method === 'POST' && /close-not-interested$/.test(u)) return { ok: true, json: async () => ({ ok: true }) } as any
    return { ok: true, json: async () => ({}) } as any
  })
  document.body.innerHTML = ''
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return host
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const moreButton = (host: Element) => host.querySelector('button[aria-label="More"]') as HTMLButtonElement | null
const menuTexts = () =>
  [...document.querySelectorAll('[data-bee-row-menu] button')].map(b => (b.textContent || '').trim())

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" closeLostReasons={['Went quiet', 'Other']} setToast={() => {}} {...over} />
)

describe('Close — not interested menu gating (issue 204)', () => {
  it('present on a normal owned row', async () => {
    const host = await mount(inbox([person()]))
    await click(moreButton(host)!)
    expect(menuTexts().some(t => t.includes('Close — not interested'))).toBe(true)
  })

  it('hidden on a Jobber-linked row (junk-parity gate)', async () => {
    const host = await mount(inbox([person({ jobberRef: 'jc-99' })]))
    await click(moreButton(host)!)
    // menu still opens (snooze/dismiss/network) but the close item is gone —
    // just like Mark as junk, which is also hidden here.
    expect(menuTexts().some(t => t.includes('Close — not interested'))).toBe(false)
    expect(menuTexts().some(t => t.includes('Mark as junk'))).toBe(false)
  })

  it('absent on a read-only surface (no ··· cluster at all)', async () => {
    const host = await mount(inbox([person()], { readOnly: true }))
    // read-only rows render no action cluster, so there is no ··· trigger.
    expect(moreButton(host)).toBeNull()
  })

  it('picking it opens the CloseLostWizard', async () => {
    const host = await mount(inbox([person()]))
    await click(moreButton(host)!)
    const item = [...document.querySelectorAll('[data-bee-row-menu] button')]
      .find(b => (b.textContent || '').includes('Close — not interested')) as HTMLButtonElement
    await click(item)
    expect(document.body.textContent).toContain('Close as lost')
  })

  it('completing the close removes the row from the Inbox (optimistic closedLostIds)', async () => {
    const p = person()
    const host = await mount(inbox([p]))
    expect(host.querySelectorAll('.bee-inbox-row').length).toBe(1)
    await click(moreButton(host)!)
    const item = [...document.querySelectorAll('[data-bee-row-menu] button')]
      .find(b => (b.textContent || '').includes('Close — not interested')) as HTMLButtonElement
    await click(item)
    // drive the wizard: reason (default) → Next → Close as lost
    const byText = (t: string) => [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(t)) as HTMLButtonElement
    await click(byText('Next'))
    await click(byText('Close as lost'))
    await act(async () => {})
    // the lead has left the worklist
    expect(host.querySelectorAll('.bee-inbox-row').length).toBe(0)
  })
})
