// @vitest-environment happy-dom
//
// FL-75 slice 6 (2026-11-25) — what the Mailchimp card shows after Sync now
// (components/settings/MailchimpSyncAnswer.jsx), mounted for real:
//   • live sign-up flows: each one named, how to pause it, no way to send
//   • the confirmation: exact count + audience, the paused flows, and each
//     held tag as its own unticked box — Yes sends only the ticked ones
//   • a run that stopped partway is never worded as done
import { describe, it, expect, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SyncConfirm, SyncResult, syncResultWords } from '@/components/settings/MailchimpSyncAnswer'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLElement, root: Root
const mount = async (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  await act(async () => { root.render(el) })
}
afterEach(() => { act(() => root?.unmount()); host?.remove() })
const btn = (t: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === t)

const LIVE = {
  ran: false, reason: 'signup_flows_live', pushed: 0, already: 0, skipped: 0, failed: 0, remaining: 0, tags_held: [],
  must_pause: [{ name: 'Welcome New Contacts', status: 'sending', start: 'Contact signs up to Bee Organized Friends' }, { name: 'Profile Quiz - Welcome Flow', status: 'sending', start: '…' }],
  how_to_pause: 'In Mailchimp, go to Automations, open the flow by its name, and choose Pause. Then come back and press Check again.',
}
const ASK = {
  count: 143, list_id: 'list1', list_name: 'Bee Organized Friends', flows: 'fp1',
  paused_flows: [{ name: 'Welcome New Contacts', status: 'paused', start: '' }, { name: 'Profile Quiz - Welcome Flow', status: 'paused', start: '' }],
  held_tags: [{ tag: 'CLOSEDJOB', flows: ['Closed Job Journey'], people: 4 }, { tag: 'VIP', flows: ['VIP Thanks'], people: 1 }],
}

describe('refused because sign-up flows are on', () => {
  it('names each live flow, says how to pause it, and offers no way to send', async () => {
    await mount(<SyncResult result={LIVE} listName="Bee Organized Friends" />)
    expect(host.textContent).toContain('Nothing was sent. These Mailchimp flows send an email the moment someone is added to Bee Organized Friends, and they are on.')
    const names = Array.from(host.querySelectorAll('[data-testid="mc-live-flows"] li')).map((li) => li.textContent)
    expect(names).toEqual(['Welcome New Contacts (on)', 'Profile Quiz - Welcome Flow (on)'])
    expect(host.textContent).toContain('choose Pause')
    expect(host.querySelectorAll('button')).toHaveLength(0)
  })
  it('every other refusal says nothing was sent', () => {
    expect(syncResultWords({ ran: false, reason: 'mailchimp_unreadable', words: 'Bee Hub could not check your Mailchimp flows, so nothing was sent.' }, 'X')).toMatch(/nothing was sent/)
    expect(syncResultWords({ ran: false, reason: 'sync_not_enabled' }, 'X')).toMatch(/^Nothing was sent/)
    expect(syncResultWords({ ran: false, reason: 'no_list_unreadable' }, 'X')).toMatch(/Nothing was sent/)
  })
})

describe('the first-sync confirmation', () => {
  it('shows the exact count and audience, and the paused flows by name', async () => {
    await mount(<SyncConfirm confirm={ASK} syncing={false} onYes={() => {}} onCancel={() => {}} />)
    expect(host.textContent).toContain('This will subscribe 143 people to Bee Organized Friends.')
    expect(Array.from(host.querySelectorAll('[data-testid="mc-paused-flows"] li')).map((li) => li.textContent)).toEqual(['Welcome New Contacts (paused)', 'Profile Quiz - Welcome Flow (paused)'])
    expect(btn('Yes, subscribe 143')).toBeTruthy()
  })
  it('held tags start unticked; Yes sends none of them', async () => {
    const onYes = vi.fn()
    await mount(<SyncConfirm confirm={ASK} syncing={false} onYes={onYes} onCancel={() => {}} />)
    const boxes = Array.from(host.querySelectorAll('[data-testid="mc-held-tags"] input[type=checkbox]')) as HTMLInputElement[]
    expect(boxes).toHaveLength(2)
    for (const b of boxes) expect(b.checked).toBe(false)
    expect(host.textContent).toContain('CLOSEDJOB — starts “Closed Job Journey” · 4 people')
    await act(async () => { btn('Yes, subscribe 143')!.click() })
    expect(onYes).toHaveBeenCalledWith([])
  })
  it('ticking one tag sends that tag only', async () => {
    const onYes = vi.fn()
    await mount(<SyncConfirm confirm={ASK} syncing={false} onYes={onYes} onCancel={() => {}} />)
    await act(async () => { (host.querySelector('input[aria-label="Carry the tag CLOSEDJOB"]') as HTMLInputElement).click() })
    await act(async () => { btn('Yes, subscribe 143')!.click() })
    expect(onYes).toHaveBeenCalledWith(['CLOSEDJOB'])
  })
  it('no sign-up flows at all is said plainly', async () => {
    await mount(<SyncConfirm confirm={{ ...ASK, paused_flows: [], held_tags: [] }} syncing={false} onYes={() => {}} onCancel={() => {}} />)
    expect(host.textContent).toContain('No Mailchimp flow starts when someone is added to this audience.')
    expect(host.querySelector('[data-testid="mc-held-tags"]')).toBeNull()
  })
})

describe('results', () => {
  it('a run that stopped partway is never worded as done', () => {
    const w = syncResultWords({ ran: true, complete: false, stopped: 'batch_failed: http 429', pushed: 500, already: 0, failed: 0, remaining: 700 }, 'Bee Organized Friends')
    expect(w).toBe('Stopped partway: added 500 people to Bee Organized Friends, 700 still to go. Nobody is added twice — press Sync now to carry on.')
    expect(w).not.toMatch(/^Done/)
  })
  it('a flow changing mid-run is named as the reason', () => {
    expect(syncResultWords({ ran: true, complete: false, stopped: 'flows_changed', pushed: 0, remaining: 3 }, 'X')).toContain('A Mailchimp flow changed while sending, so Bee Hub stopped.')
  })
  it('done: added, already there, refused', () => {
    expect(syncResultWords({ ran: true, complete: true, pushed: 141, already: 1, failed: 1, remaining: 0 }, 'Bee Organized Friends'))
      .toBe('Done: added 141 people to Bee Organized Friends. 1 person was already there and left exactly as they were · 1 person couldn’t be added.')
  })
  it('held tags are listed after a run', async () => {
    await mount(<SyncResult result={{ ran: true, complete: true, pushed: 3, already: 0, failed: 0, remaining: 0, tags_held: ['CLOSEDJOB'] }} listName="X" />)
    expect(host.textContent).toContain('Left off because they start a Mailchimp flow: CLOSEDJOB.')
  })
})
