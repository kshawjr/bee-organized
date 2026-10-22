// @vitest-environment happy-dom
//
// THE ANSWERED PILL, AND WHERE AN ANSWERED ITEM LIVES ON THE OWNER SCREEN.
//
// 'answered' is the ending a resolved-with-words item wears. The owner must be
// able to read the decision without asking anyone: the pill says "Answered"
// (teal — a happy ending, but never Fixed's claim that something broken was
// repaired), and the item folds away with the other closed things instead of
// haunting the open list.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import OwnerFeedbackScreen, { isDoneItem } from '@/components/feedback/OwnerFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const item = (over: any) => ({
  id: 'x', title: 'A report', description: 'Something.', type: 'question',
  status: 'submitted', user_id: 'u1', submitter_name: 'Lynette Ewy',
  location_id: 'loc-1', created_at: daysAgo(10), updated_at: daysAgo(10),
  admin_response: null, admin_response_at: null, reply_seen_at: null,
  attachments: [], replies: [], ...over,
})

async function mountScreen(items: any[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    if (String(url).startsWith('/api/feedback/seen')) {
      return { ok: true, json: async () => ({ marked: 0, supported: true }) } as any
    }
    return { ok: true, json: async () => ({ items }) } as any
  }))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={{ id: 'u1' } as any}>
        <OwnerFeedbackScreen />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('the owner reads "Answered" without asking anyone', () => {
  it('an answered question wears the Answered pill and is shown when nothing else is open', async () => {
    // Their only item is answered → the closed list starts unfolded (nothing
    // open → show the evidence), where the pill must say Answered — not Fixed,
    // which would claim a repair that never happened.
    const { host, unmount } = await mountScreen([
      item({
        status: 'answered', title: 'Will editing an address mess up Jobber?',
        admin_response: 'Totally safe — Jobber keeps its history.',
        admin_response_at: daysAgo(1), reply_seen_at: daysAgo(0),
      }),
    ])
    expect(host.textContent).toContain('Answered')
    expect(host.textContent).not.toContain('Fixed')
    expect(host.textContent).toContain('Will editing an address mess up Jobber?')
    await unmount()
  })

  it('answered counts as closed, not open — the closed link counts it', async () => {
    expect(isDoneItem({ status: 'answered' })).toBe(true)
    const { host, unmount } = await mountScreen([
      item({ id: 'open1', title: 'Still waiting on this' }),
      item({ id: 'ans1', title: 'The answered one', status: 'answered', admin_response: 'Here you go.', admin_response_at: daysAgo(2), reply_seen_at: daysAgo(1) }),
    ])
    // The open one shows; the answered one is folded away, not in the way.
    expect(host.textContent).toContain('Still waiting on this')
    expect(host.textContent).not.toContain('The answered one')
    // And the closed link counts it.
    const closed = host.querySelector('[data-feedback-closed-toggle]') as HTMLButtonElement
    expect(closed?.textContent).toContain('Show 1 closed')
    await act(async () => { closed.click() })
    expect(host.textContent).toContain('The answered one')
    await unmount()
  })
})
