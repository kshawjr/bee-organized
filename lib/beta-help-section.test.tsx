// @vitest-environment happy-dom
//
// THE HELP SECTION, AS SEEN.
//
//   · an owner sees published items and no plus buttons anywhere
//   · a corporate user and a super admin see the plus buttons (canEdit is
//     what BeeHub passes for those two roles; the routes test pins the
//     server side of the same gate)
//   · a draft item is invisible to an owner (the server never sends it) and
//     visible, marked Draft, to its author
//   · an item renders with a video, and with a screenshot instead
//   · the ask strip carries the topic through to the feedback form — type
//     preselected, breadcrumb in the description, entry id in the context
//   · My requests shows the same items and threads it does today — the
//     owner screen, from the same route, with the same reply text
//   · ?tab=requests lands on My requests
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import HelpScreen from '@/components/help/HelpScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const node = (over: any) => ({
  id: 'x', kind: 'item', parent_id: null, position: 0, title: 'Row', status: 'published', deleted_at: null,
  steps: [], media_kind: null, media_path: null, media_url: null, lead: null, callout: null, icon: null, children: [], ...over,
})
const video = node({ id: 'i1', kind: 'item', parent_id: 't1', title: 'Turn on alerts', lead: 'Get a text the moment a lead lands.', media_kind: 'video', media_path: 'video/a.mp4', media_url: 'https://p.supabase.co/storage/v1/object/public/help-media/video/a.mp4', steps: ['Open Settings', 'Tap Notifications'], callout: 'Only the assignee is told.' })
const shot = node({ id: 'i2', kind: 'item', parent_id: 't1', title: 'Find the inbox', position: 1, media_kind: 'image', media_path: 'image/b.png', media_url: 'https://p.supabase.co/storage/v1/object/public/help-media/image/b.png', steps: ['Tap Clients'] })
const draft = node({ id: 'i3', kind: 'item', parent_id: 't1', title: 'Half written', position: 2, status: 'draft' })
const topic = (children: any[]) => node({ id: 't1', kind: 'topic', parent_id: 's1', title: 'Connect Jobber', children })
const section = (children: any[]) => node({ id: 's1', kind: 'section', title: 'Getting started', icon: '🚀', children })

// What the SERVER sends each role — the owner payload has no draft in it.
const OWNER_TREE = { sections: [section([topic([video, shot])])], deleted: [], canEdit: false }
const EDITOR_TREE = { sections: [section([topic([video, shot, draft])])], deleted: [{ id: 'i9', kind: 'item', title: 'Old one', deleted_at: '2026-09-01T00:00:00Z' }], canEdit: true }

function stubFetch(routes: Record<string, any>) {
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    for (const [prefix, payload] of Object.entries(routes)) {
      if (u.startsWith(prefix)) return { ok: true, status: 200, json: async () => (typeof payload === 'function' ? payload(u, init) : payload) } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  })
  ;(globalThis as any).fetch = f
  return f
}

async function mount(el: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = async (el: Element | null) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }) }
const asUser = (id: string, el: React.ReactNode) => <CurrentUserContext.Provider value={{ id, email: 'x@y.com' } as any}>{el}</CurrentUserContext.Provider>
const plusButtons = (host: HTMLElement) => Array.from(host.querySelectorAll('[data-help-add]')).map(b => b.getAttribute('data-help-add'))

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, '', '/help') })

// ─── who sees the plus buttons ─────────────────────────────────────

describe('an owner', () => {
  it('sees published items and no plus buttons anywhere — section list, section, item', async () => {
    stubFetch({ '/api/help/entries': OWNER_TREE })
    const { host, unmount } = await mount(<HelpScreen canEdit={false} role="franchise" franchiseRole="owner" />)
    expect(host.textContent).toContain('Getting started')
    expect(host.textContent).toContain('2 items')
    expect(plusButtons(host)).toEqual([])
    expect(host.querySelector('[aria-label^="Edit "]')).toBeNull()
    expect(host.querySelector('[aria-label^="Move "]')).toBeNull()

    await click(host.querySelector('[data-help-section="s1"]'))
    expect(host.textContent).toContain('Connect Jobber')
    expect(host.textContent).toContain('Turn on alerts')
    expect(host.textContent).not.toContain('Half written')
    expect(host.textContent).not.toContain('Draft')
    expect(plusButtons(host)).toEqual([])

    await click(host.querySelector('[data-help-item-row="i1"]'))
    expect(host.querySelector('[data-help-item="i1"]')).toBeTruthy()
    expect(plusButtons(host)).toEqual([])
    expect(host.querySelector('[aria-label^="Edit "]')).toBeNull()
    await unmount()
  })
})

describe('a corporate user and a super admin', () => {
  for (const who of ['corporate', 'super_admin']) {
    it(`${who} sees the plus buttons at every level, and the draft marked Draft`, async () => {
      stubFetch({ '/api/help/entries': EDITOR_TREE })
      const { host, unmount } = await mount(<HelpScreen canEdit role={who} franchiseRole="owner" />)
      expect(plusButtons(host)).toEqual(['Add section'])
      expect(host.querySelector('[aria-label="Edit Getting started"]')).toBeTruthy()
      expect(host.querySelector('[aria-label="Move Getting started up"]')).toBeTruthy()
      // the soft-deleted row is offered back
      expect(host.textContent).toContain('Deleted')
      expect(host.textContent).toContain('Old one')
      expect(host.textContent).toContain('Restore')

      await click(host.querySelector('[data-help-section="s1"]'))
      expect(plusButtons(host)).toEqual(['Add item', 'Add topic'])
      expect(host.textContent).toContain('Half written')
      expect(host.textContent).toContain('Draft')
      expect(host.querySelector('[aria-label="Edit Turn on alerts"]')).toBeTruthy()
      await unmount()
    })
  }

  it('the plus button opens the add sheet with the breadcrumb, and Publish / Save as draft', async () => {
    stubFetch({ '/api/help/entries': EDITOR_TREE })
    const { host, unmount } = await mount(<HelpScreen canEdit role="super_admin" />)
    await click(host.querySelector('[data-help-section="s1"]'))
    await click(host.querySelector('[data-help-add="Add item"]'))
    const text = document.body.textContent || ''
    expect(text).toContain('Add item')
    expect(text).toContain('Getting started › Connect Jobber')
    expect(text).toContain('Publish')
    expect(text).toContain('Save as draft')
    expect(text).toContain('Add video')
    expect(text).toContain('Add screenshot')
    // every typed field is 16px — iOS must not zoom
    for (const f of Array.from(document.body.querySelectorAll('input[type="text"], input:not([type]), textarea'))) {
      expect((f as HTMLElement).style.fontSize).toBe('16px')
    }
    await unmount()
  })

  it('a chevron tap posts a move and reloads', async () => {
    const f = stubFetch({ '/api/help/entries': EDITOR_TREE })
    const { host, unmount } = await mount(<HelpScreen canEdit role="super_admin" />)
    await click(host.querySelector('[data-help-section="s1"]'))
    await click(host.querySelector('[aria-label="Move Find the inbox up"]'))
    const move = f.mock.calls.find(c => String(c[0]).endsWith('/api/help/entries/i2/move'))
    expect(move).toBeTruthy()
    expect(JSON.parse(move![1].body)).toEqual({ direction: 'up' })
    await unmount()
  })
})

// ─── the item itself ───────────────────────────────────────────────

describe('an item renders', () => {
  it('with a video — the steps and the callout under it', async () => {
    stubFetch({ '/api/help/entries': OWNER_TREE })
    const { host, unmount } = await mount(<HelpScreen canEdit={false} />)
    await click(host.querySelector('[data-help-section="s1"]'))
    await click(host.querySelector('[data-help-item-row="i1"]'))
    const v = host.querySelector('video[data-help-media="video"]') as HTMLVideoElement
    expect(v).toBeTruthy()
    expect(v.getAttribute('src')).toBe(video.media_url)
    expect(v.hasAttribute('controls')).toBe(true)
    expect(v.hasAttribute('playsinline')).toBe(true)
    expect(host.querySelector('img[data-help-media]')).toBeNull()
    const steps = Array.from(host.querySelectorAll('ol li')).map(li => li.textContent)
    expect(steps).toEqual(['Open Settings', 'Tap Notifications'])
    expect(host.textContent).toContain('Get a text the moment a lead lands.')
    expect(host.textContent).toContain('Only the assignee is told.')
    await unmount()
  })

  it('with a screenshot instead — no video element', async () => {
    stubFetch({ '/api/help/entries': OWNER_TREE })
    const { host, unmount } = await mount(<HelpScreen canEdit={false} />)
    await click(host.querySelector('[data-help-section="s1"]'))
    await click(host.querySelector('[data-help-item-row="i2"]'))
    const img = host.querySelector('img[data-help-media="image"]') as HTMLImageElement
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe(shot.media_url)
    expect(host.querySelector('video')).toBeNull()
    await unmount()
  })
})

// ─── the ask strip ─────────────────────────────────────────────────

describe('the ask strip', () => {
  it('has three doors, and carries the topic through — type, breadcrumb, entry id — at every level', async () => {
    stubFetch({ '/api/help/entries': OWNER_TREE })
    const onAsk = vi.fn()
    const { host, unmount } = await mount(<HelpScreen canEdit={false} onAsk={onAsk} />)
    // section list: nothing chosen yet
    expect(host.querySelectorAll('[data-help-ask-strip]').length).toBe(1)
    expect(Array.from(host.querySelectorAll('[data-help-door]')).map(b => b.getAttribute('data-help-door'))).toEqual(['bug', 'question', 'feature'])
    await click(Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Ask a question')) || null)
    expect(onAsk).toHaveBeenLastCalledWith({ type: 'question', about: 'Help', context: { origin: 'help_ask_strip', screen: 'Help' } })

    await click(host.querySelector('[data-help-section="s1"]'))
    await click(Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Suggest a feature')) || null)
    expect(onAsk).toHaveBeenLastCalledWith({ type: 'feature', about: 'Getting started', context: { origin: 'help_ask_strip', screen: 'Help', help_entry_id: 's1' } })

    await click(host.querySelector('[data-help-item-row="i1"]'))
    expect(host.textContent).toContain('Still stuck on Getting started › Connect Jobber › Turn on alerts')
    await click(Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('Ask a question')) || null)
    expect(onAsk).toHaveBeenLastCalledWith({ type: 'question', about: 'Getting started › Connect Jobber › Turn on alerts', context: { origin: 'help_ask_strip', screen: 'Help', help_entry_id: 'i1' } })
    // the third door
    await click(host.querySelector('[data-help-door="bug"]'))
    expect(onAsk).toHaveBeenLastCalledWith({ type: 'bug', about: 'Getting started › Connect Jobber › Turn on alerts', context: { origin: 'help_ask_strip', screen: 'Help', help_entry_id: 'i1' } })
    await unmount()
  })
})

// ─── My requests ───────────────────────────────────────────────────

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const feedbackItem = {
  id: 'fb1', title: 'Alerts stopped', description: 'No texts since Tuesday.', type: 'bug', status: 'under_review',
  user_id: 'u1', submitter_name: 'Ankur Patel', location_id: 'loc-1', created_at: daysAgo(4), updated_at: daysAgo(4),
  admin_response: 'Found it — a fix is queued.', admin_response_at: daysAgo(1), reply_seen_at: null, attachments: [], is_internal: false,
  replies: [{ id: 'r1', author_id: 'admin-1', author_role: 'team', body: 'Found it — a fix is queued.', created_at: daysAgo(1) }],
}

describe('My requests', () => {
  it('for an owner is the owner screen — same route, same items, same thread, no second heading', async () => {
    const f = stubFetch({ '/api/help/entries': OWNER_TREE, '/api/admin/feedback': { items: [feedbackItem] }, '/api/feedback/seen': { marked: 1, supported: true } })
    const { host, unmount } = await mount(asUser('u1', <HelpScreen canEdit={false} role="franchise" franchiseRole="owner" />))
    await click(Array.from(host.querySelectorAll('[role="tab"]')).find(b => b.textContent === 'My requests') || null)
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).not.toContain('What you’ve told us')
    expect(host.querySelector('h1')?.textContent).toBe('Help')
    expect(host.textContent).toContain('Alerts stopped')
    expect(host.textContent).toContain('The team replied')
    expect(host.textContent).toContain('Found it — a fix is queued.')
    expect(host.textContent).toContain('Reply to the team')
    expect(f.mock.calls.some(c => String(c[0]).startsWith('/api/admin/feedback'))).toBe(true)
    await unmount()
  })

  it('for a corporate user is their own list from /api/feedback, the composer\'s My Items', async () => {
    const f = stubFetch({ '/api/help/entries': EDITOR_TREE, '/api/feedback': { items: [feedbackItem] } })
    const { host, unmount } = await mount(asUser('u1', <HelpScreen canEdit role="corporate" franchiseRole="owner" initialTab="requests" />))
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('Alerts stopped')
    expect(host.textContent).toContain('Found it — a fix is queued.')
    expect(f.mock.calls.some(c => String(c[0]) === '/api/feedback')).toBe(true)
    expect(f.mock.calls.some(c => String(c[0]).startsWith('/api/admin/feedback'))).toBe(false)
    await unmount()
  })

  it('?tab=requests lands on My requests', async () => {
    window.history.replaceState({}, '', '/help?tab=requests')
    stubFetch({ '/api/help/entries': OWNER_TREE, '/api/admin/feedback': { items: [] }, '/api/feedback/seen': { marked: 0, supported: true } })
    const { host, unmount } = await mount(asUser('u1', <HelpScreen canEdit={false} role="franchise" franchiseRole="manager" />))
    await act(async () => { await Promise.resolve() })
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('My requests')
    await unmount()
  })
})
