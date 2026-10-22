// @vitest-environment happy-dom
//
// THE OWNER'S HELP DESK, REDESIGNED.
//
// 13 of the 19 owners who have ever filed anything have five items or fewer.
// The old Help › My requests gave them four tabs whose counts overlapped, a
// reply hidden behind a header that only unclamped two lines, and every reply
// marked read the moment the page loaded (10 of Angie Ahlstedt's 10 replies
// are unread — she has never opened the page at all). Lite users and the corp
// tier got a second card design with no unread marker; the composer's My
// Items tab a third.
//
// What this file pins, one describe per promise:
//   · one list, no tabs, closed items folded behind a link that counts them
//   · the reply on the card, in full, with no interaction
//   · an unanswered item says so
//   · nothing is stamped seen on load; acting on an item stamps that item only
//   · the banner links to the item and survives a reload until it is stamped
//   · "Remove this" is not the main action, and still confirms
//   · one card for every role
//   · nothing overflows at 390px
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import OwnerFeedbackScreen from '@/components/feedback/OwnerFeedbackScreen'
import HelpScreen from '@/components/help/HelpScreen'
import FeedbackModal from '@/components/feedback/FeedbackModal'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const item = (over: any) => ({
  id: 'x', title: 'A report', description: 'Something happened.', type: 'bug',
  status: 'submitted', user_id: 'u1', submitter_name: 'Angie Ahlstedt', location_id: 'loc-1',
  created_at: daysAgo(10), updated_at: daysAgo(10),
  admin_response: null, admin_response_at: null, reply_seen_at: null, attachments: [], replies: [],
  ...over,
})
const teamReply = (id: string, body: string, at: string) => ({ id, author_id: 'admin-1', author_role: 'team', body, created_at: at })

// A miniature of a real owner: two open (one answered and unread, one waiting
// on us), three closed (one of each closed word).
const ANSWERED = item({
  id: 'a1', title: 'Alerts stopped', status: 'planned', created_at: daysAgo(6),
  admin_response: 'Found it — a fix is queued for Thursday.', admin_response_at: daysAgo(1), reply_seen_at: null,
  replies: [teamReply('r1', 'Found it — a fix is queued for Thursday.', daysAgo(1))],
})
const WAITING = item({ id: 'w1', title: 'Calendar sync is slow', status: 'submitted', created_at: daysAgo(2) })
const FIXED = item({
  id: 'c1', title: 'Old fixed thing', status: 'shipped', created_at: daysAgo(40),
  admin_response: 'Sorted, thanks.', admin_response_at: daysAgo(30), reply_seen_at: null,
  replies: [teamReply('r2', 'Sorted, thanks.', daysAgo(30))],
})
const ANSWERED_CLOSED = item({
  id: 'c2', title: 'How do tags work', type: 'question', status: 'answered', created_at: daysAgo(50),
  admin_response: 'Tags live under Settings.', admin_response_at: daysAgo(49), reply_seen_at: daysAgo(48),
})
const DECLINED = item({ id: 'c3', title: 'Make it purple', type: 'feature', status: 'declined', created_at: daysAgo(60) })
const MIX = [FIXED, WAITING, DECLINED, ANSWERED, ANSWERED_CLOSED]

// A tiny stateful server: GET returns the store, POST /seen stamps it, the
// replies route appends and stamps (as the real route does). So a "reload" is
// just a remount against whatever the server now holds.
function server(initial: any[]) {
  const store = initial.map(i => ({ ...i, replies: [...(i.replies || [])] }))
  const calls: { url: string, init?: any }[] = []
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    calls.push({ url: u, init })
    const ok = (body: any, status = 200) => ({ ok: true, status, json: async () => body }) as any
    if (u.startsWith('/api/feedback/seen')) {
      const ids: string[] = JSON.parse(init.body).ids
      for (const r of store) if (ids.includes(r.id)) r.reply_seen_at = new Date().toISOString()
      return ok({ marked: ids.length, supported: true })
    }
    const replyMatch = u.match(/^\/api\/feedback\/([^/]+)\/replies$/)
    if (replyMatch && init?.method === 'POST') {
      const r = store.find(x => x.id === replyMatch[1])!
      const row = { id: `own-${r.replies.length}`, author_id: 'u1', author_role: 'owner', body: JSON.parse(init.body).body, created_at: new Date().toISOString() }
      r.replies.push(row)
      r.reply_seen_at = new Date().toISOString()
      return ok(row, 201)
    }
    if (u.startsWith('/api/help/entries')) return ok({ sections: [], deleted: [], canEdit: false })
    if (u.startsWith('/api/admin/feedback') || u.startsWith('/api/feedback')) {
      return ok({ items: store.map(r => ({ ...r, replies: [...r.replies] })) })
    }
    return ok({})
  })
  ;(globalThis as any).fetch = f
  return { f, store, calls, seenCalls: () => calls.filter(c => c.url.startsWith('/api/feedback/seen')).map(c => JSON.parse(c.init.body).ids) }
}

const asUser = (id: string, el: React.ReactNode) => (
  <CurrentUserContext.Provider value={{ id, email: 'angie@example.com' } as any}>{el}</CurrentUserContext.Provider>
)

async function mount(el: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const ownerScreen = () => mount(asUser('u1', <OwnerFeedbackScreen onAsk={() => {}} title={null} />))

const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const card = (host: HTMLElement, id: string) => host.querySelector(`[data-feedback-card="${id}"]`) as HTMLElement | null
const buttons = (host: Element) => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as any).__BEE_TEST_WIDTH__
})

// ─── 1. one list ───────────────────────────────────────────────────

describe('one list, no tabs', () => {
  it('renders no tab controls of any kind', async () => {
    server(MIX)
    const { host, unmount } = await ownerScreen()
    expect(host.querySelector('[role="tab"], [role="tablist"], [aria-pressed]')).toBeNull()
    const labels = buttons(host).map(b => (b.textContent || '').trim())
    for (const old of ['Open', 'Answered', 'Waiting', 'Done']) {
      expect(labels.some(l => l === old || l.startsWith(`${old} ·`))).toBe(false)
    }
    await unmount()
  })

  it('says how many have been sent and how many are still with the team — once, not overlapping', async () => {
    server(MIX)
    const { host, unmount } = await ownerScreen()
    expect(host.querySelector('[data-feedback-subtitle]')?.textContent).toBe('5 sent · 2 still with the team')
    await unmount()
  })

  it('open items come newest first', async () => {
    server(MIX)
    const { host, unmount } = await ownerScreen()
    const order = Array.from(host.querySelectorAll('[data-feedback-open-list] [data-feedback-card]')).map(c => c.getAttribute('data-feedback-card'))
    expect(order).toEqual(['w1', 'a1'])
    await unmount()
  })
})

describe('closed items fold away behind one link', () => {
  it('are collapsed, and the link names how many and the closed words from the shared map', async () => {
    server(MIX)
    const { host, unmount } = await ownerScreen()
    for (const id of ['c1', 'c2', 'c3']) expect(card(host, id)).toBeNull()
    const toggle = host.querySelector('[data-feedback-closed-toggle]') as HTMLButtonElement
    expect(toggle.textContent).toContain('Show 3 closed')
    for (const s of ['shipped', 'answered', 'declined']) expect(toggle.textContent).toContain(FEEDBACK_STATUS_PLAIN[s as keyof typeof FEEDBACK_STATUS_PLAIN])
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click(toggle)
    for (const id of ['c1', 'c2', 'c3']) expect(card(host, id)).toBeTruthy()
    await unmount()
  })

  it('an owner with nothing open lands on their closed items, not on a bare link', async () => {
    server([FIXED, DECLINED])
    const { host, unmount } = await ownerScreen()
    expect(card(host, 'c1')).toBeTruthy()
    expect(host.textContent).toContain('Nothing open')
    await unmount()
  })
})

// ─── 2. the reply is on the card ───────────────────────────────────

describe('the reply is on the card', () => {
  it('shows the full reply text, who and when, with no interaction', async () => {
    const long = 'Found it. '.repeat(40).trim()
    server([item({ ...ANSWERED, admin_response: long, replies: [teamReply('r1', long, daysAgo(1))] })])
    const { host, unmount } = await ownerScreen()
    const c = card(host, 'a1')!
    expect(c.textContent).toContain(long)
    expect(c.querySelector('[data-feedback-entry="team"]')?.textContent).toContain('The team replied, 1 day ago')
    // Nothing on the card expands or clamps.
    expect(c.querySelector('[aria-expanded]')).toBeNull()
    expect(c.innerHTML).not.toMatch(/line-clamp/i)
    await unmount()
  })
})

// ─── 3. an item with no reply says so ──────────────────────────────

describe('an item with no reply says so', () => {
  it('shows the waiting line on the unanswered open item and not on the answered one', async () => {
    server(MIX)
    const { host, unmount } = await ownerScreen()
    expect(card(host, 'w1')!.querySelector('[data-feedback-waiting]')?.textContent).toContain('Nobody has written back yet.')
    expect(card(host, 'a1')!.querySelector('[data-feedback-waiting]')).toBeNull()
    await unmount()
  })

  it('"It’s holding me up" opens the write-back box on that item', async () => {
    const s = server([WAITING])
    const { host, unmount } = await ownerScreen()
    await click(card(host, 'w1')!.querySelector('[data-feedback-holding]'))
    const box = card(host, 'w1')!.querySelector('textarea') as HTMLTextAreaElement
    expect(box).toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box, 'Can’t send quotes until this works.')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttons(card(host, 'w1')!).find(b => b.textContent === 'Send'))
    await act(async () => { await Promise.resolve() })
    expect(s.calls.some(c => c.url === '/api/feedback/w1/replies' && c.init?.method === 'POST')).toBe(true)
    expect(card(host, 'w1')!.textContent).toContain('Can’t send quotes until this works.')
    await unmount()
  })
})

// ─── 5. unread stops being a lie ───────────────────────────────────

describe('seen is stamped by acting on an item, never by loading', () => {
  it('loading the screen does NOT call the seen endpoint, even with unread replies on it', async () => {
    const s = server(MIX)
    const { host, unmount } = await ownerScreen()
    expect(host.querySelector('[data-feedback-banner]')).toBeTruthy()
    expect(s.seenCalls()).toEqual([])
    await unmount()
  })

  it('clicking a card stamps that item and only that item', async () => {
    const s = server(MIX)
    const { host, unmount } = await ownerScreen()
    await click(host.querySelector('[data-feedback-closed-toggle]'))
    await click(card(host, 'a1')!.querySelector('p'))
    expect(s.seenCalls()).toEqual([['a1']])
    // c1 is still unread and still marked.
    expect(card(host, 'c1')!.querySelector('[data-feedback-new]')).toBeTruthy()
    expect(card(host, 'a1')!.querySelector('[data-feedback-new]')).toBeNull()
    await unmount()
  })

  it('"Got it" on the New marker stamps that item once', async () => {
    const s = server(MIX)
    const { host, unmount } = await ownerScreen()
    await click(card(host, 'a1')!.querySelector('[data-feedback-got-it]'))
    expect(s.seenCalls()).toEqual([['a1']])
    await unmount()
  })

  it('writing back clears the marker on that item without stamping any other', async () => {
    const s = server(MIX)
    const { host, unmount } = await ownerScreen()
    const c = () => card(host, 'a1')!
    await click(c().querySelector('[data-feedback-primary="write-back"]'))
    const box = c().querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Thanks!')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttons(c()).find(b => b.textContent === 'Send'))
    await act(async () => { await Promise.resolve() })
    expect(c().querySelector('[data-feedback-new]')).toBeNull()
    expect(s.store.find(r => r.id === 'c1')!.reply_seen_at).toBeNull()
    expect(s.seenCalls().flat()).not.toContain('c1')
    await unmount()
  })

  it('a colleague’s reply is never marked new for me and has no Got it', async () => {
    server([item({ ...ANSWERED, user_id: 'someone-else' })])
    const { host, unmount } = await ownerScreen()
    expect(host.querySelector('[data-feedback-new], [data-feedback-got-it], [data-feedback-banner]')).toBeNull()
    await unmount()
  })
})

describe('the banner', () => {
  it('links to the item and scrolls to it — unfolding the closed list when it has to', async () => {
    server(MIX)
    const scrolled: string[] = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) { scrolled.push(this.id) })
    const { host, unmount } = await ownerScreen()
    const links = Array.from(host.querySelectorAll('[data-feedback-banner] a')) as HTMLAnchorElement[]
    expect(links.map(a => a.getAttribute('href'))).toEqual(['#feedback-a1', '#feedback-c1'])
    await click(links[1])
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(card(host, 'c1')).toBeTruthy()
    expect(scrolled).toContain('feedback-c1')
    await unmount()
  })

  it('survives a reload until the item is stamped, then goes', async () => {
    server(MIX)
    let screen = await ownerScreen()
    expect(screen.host.querySelector('[data-feedback-banner]')?.textContent).toContain('Two new replies')
    await screen.unmount()

    // Reload without acting: still there.
    screen = await ownerScreen()
    expect(screen.host.querySelector('[data-feedback-banner]')?.textContent).toContain('Two new replies')
    await click(card(screen.host, 'a1')!.querySelector('[data-feedback-got-it]'))
    expect(screen.host.querySelector('[data-feedback-banner]')?.textContent).toContain('One new reply')
    await screen.unmount()

    // Reload after stamping one: only the other is left.
    screen = await ownerScreen()
    const banner = screen.host.querySelector('[data-feedback-banner]')!
    expect(banner.textContent).toContain('One new reply')
    expect(banner.textContent).toContain('Old fixed thing')
    expect(banner.textContent).not.toContain('Alerts stopped')
    await screen.unmount()
  })
})

// ─── 6. delete gets demoted ────────────────────────────────────────

describe('Remove this is not the main action', () => {
  it('the primary action is Write back on an answered item and Change what I wrote on an unanswered one', async () => {
    server(MIX)
    const { host, unmount } = await ownerScreen()
    expect(card(host, 'a1')!.querySelector('[data-feedback-primary]')?.textContent).toBe('Write back')
    expect(card(host, 'w1')!.querySelector('[data-feedback-primary]')?.textContent).toBe('Change what I wrote')
    await unmount()
  })

  it('Remove this is small, grey, underlined, away from the primary — and it still confirms', async () => {
    const s = server(MIX)
    const { host, unmount } = await ownerScreen()
    const c = card(host, 'a1')!
    const primary = c.querySelector('[data-feedback-primary]') as HTMLButtonElement
    const remove = c.querySelector('[data-feedback-remove]') as HTMLButtonElement
    expect(remove.textContent).toBe('Remove this')
    expect(remove.hasAttribute('data-feedback-primary')).toBe(false)
    expect(remove.style.textDecoration).toContain('underline')
    expect(parseFloat(remove.style.fontSize)).toBeLessThan(parseFloat(primary.style.fontSize))
    // Not a filled button: the primary has a fill colour, Remove this has none.
    expect(primary.style.backgroundColor).not.toBe('')
    expect(['', 'initial', 'transparent', 'none']).toContain(remove.style.backgroundColor)
    expect(remove.style.marginLeft).toBe('auto')

    await click(remove)
    expect(c.querySelector('[data-feedback-delete-confirm]')?.textContent).toContain('we can’t get it back')
    expect(s.calls.some(x => x.init?.method === 'DELETE')).toBe(false)
    await click(buttons(c).find(b => b.textContent === 'Keep it'))
    expect(card(host, 'a1')).toBeTruthy()
    expect(s.calls.some(x => x.init?.method === 'DELETE')).toBe(false)
    await unmount()
  })
})

// ─── 7. one card ───────────────────────────────────────────────────

describe('one card design for every role', () => {
  const surfaces: [string, () => React.ReactNode][] = [
    ['owner', () => asUser('u1', <HelpScreen role="franchise" franchiseRole="owner" initialTab="requests" onAsk={() => {}} />)],
    ['manager', () => asUser('u1', <HelpScreen role="franchise" franchiseRole="manager" initialTab="requests" onAsk={() => {}} />)],
    ['lite', () => asUser('u1', <HelpScreen role="franchise" franchiseRole="lite" initialTab="requests" onAsk={() => {}} />)],
    ['corporate', () => asUser('u1', <HelpScreen role="corporate" initialTab="requests" onAsk={() => {}} />)],
    ['composer My Items', () => asUser('u1', <FeedbackModal onClose={() => {}} initialTab="mine" />)],
  ]
  for (const [name, el] of surfaces) {
    it(`${name}: the shared card, with its unread marker and the reply in full`, async () => {
      server([ANSWERED, WAITING])
      const { host, unmount } = await mount(el())
      await act(async () => { await Promise.resolve() })
      expect(card(host, 'a1'), `${name} renders FeedbackCard`).toBeTruthy()
      expect(card(host, 'w1')).toBeTruthy()
      expect(card(host, 'a1')!.querySelector('[data-feedback-new]')).toBeTruthy()
      expect(card(host, 'a1')!.textContent).toContain('Found it — a fix is queued for Thursday.')
      expect(card(host, 'w1')!.querySelector('[data-feedback-waiting]')).toBeTruthy()
      // None of the old card's words.
      expect(host.textContent).not.toContain('Response from team')
      expect(host.textContent).not.toContain('Show more')
      await unmount()
    })
  }

  it('view-as hides the actions, not the design', async () => {
    server([ANSWERED, WAITING])
    const { host, unmount } = await mount(asUser('u1', <HelpScreen role="franchise" franchiseRole="lite" initialTab="requests" viewAsUserId="u1" />))
    await act(async () => { await Promise.resolve() })
    expect(card(host, 'a1')).toBeTruthy()
    expect(host.querySelector('[data-feedback-actions], [data-feedback-got-it], [data-feedback-holding]')).toBeNull()
    await unmount()
  })

  it('the old card is gone from the source, and nothing imports it', () => {
    expect(read('components/feedback/feedbackShared.jsx')).not.toMatch(/function FeedbackItemCard/)
    for (const f of ['components/help/HelpScreen.jsx', 'components/feedback/FeedbackModal.jsx', 'components/feedback/OwnerFeedbackScreen.jsx']) {
      const src = read(f)
      expect(src, f).not.toContain('FeedbackItemCard')
      expect(src, f).toMatch(/from '@\/components\/feedback\/FeedbackCard'/)
    }
  })
})

// ─── 4. the doors ──────────────────────────────────────────────────

describe('the three doors open the screen', () => {
  it('sit above the list on My requests and pass the door straight through', async () => {
    server(MIX)
    const onAsk = vi.fn()
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen onAsk={onAsk} title={null} />))
    const strip = host.querySelector('[data-help-ask-strip="requests"]')!
    const list = host.querySelector('[data-feedback-open-list]')!
    expect(strip.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(Array.from(strip.querySelectorAll('[data-help-door]')).map(b => b.getAttribute('data-help-door'))).toEqual(['bug', 'question', 'feature'])
    await click(strip.querySelector('[data-help-door="question"]'))
    expect(onAsk).toHaveBeenLastCalledWith({ type: 'question', about: 'My requests', context: { origin: 'help_ask_strip', screen: 'Help' } })
    await unmount()
  })
})

// ─── 8. phone width ────────────────────────────────────────────────

describe('at 390px wide', () => {
  beforeEach(() => {
    ;(globalThis as any).__BEE_TEST_WIDTH__ = 390
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true, writable: true })
  })

  const px = (v: string) => (v && v.endsWith('px') ? parseFloat(v) : NaN)

  it('nothing is wider than the phone, long words wrap, the doors stack, and every tap target is at least 44px', async () => {
    const unbroken = 'https://beehive.beeorganized.com/clients/' + 'x'.repeat(120)
    server([
      item({ ...ANSWERED, title: `Alerts stopped ${unbroken}`, description: unbroken, replies: [teamReply('r1', unbroken, daysAgo(1))], admin_response: unbroken }),
      WAITING, FIXED,
    ])
    const { host, unmount } = await ownerScreen()
    await click(host.querySelector('[data-feedback-closed-toggle]'))
    const screen = host.querySelector('[data-owner-feedback]') as HTMLElement

    // Nothing has a fixed width (or min-width) wider than the phone.
    for (const el of Array.from(screen.querySelectorAll('*')) as HTMLElement[]) {
      for (const prop of ['width', 'minWidth'] as const) {
        const w = px(el.style[prop])
        if (!Number.isNaN(w)) expect(w, `${el.tagName} ${prop}`).toBeLessThanOrEqual(390)
      }
    }
    // The page gutter is 16px.
    expect(screen.style.padding).toContain('16px')

    // Every element holding the long unbroken string may break it.
    const holders = (Array.from(screen.querySelectorAll('h3, p, a')) as HTMLElement[])
      .filter(el => (el.textContent || '').includes('xxxxxxxxxx') && Array.from(el.childNodes).some(n => n.nodeType === 3 && (n.textContent || '').includes('xxxxxxxxxx')))
    expect(holders.length).toBeGreaterThanOrEqual(3)
    for (const el of holders) expect(el.style.overflowWrap, el.tagName).toBe('anywhere')
    // …and nothing long is forbidden from wrapping.
    for (const el of Array.from(screen.querySelectorAll('*')) as HTMLElement[]) {
      if (el.style.whiteSpace === 'nowrap') expect((el.textContent || '').length, el.outerHTML.slice(0, 80)).toBeLessThan(30)
    }

    // The doors stack, full width.
    const doors = screen.querySelector('[data-help-doors]') as HTMLElement
    expect(doors.style.flexDirection).toBe('column')
    for (const d of Array.from(doors.querySelectorAll('button')) as HTMLElement[]) expect(d.style.width).toBe('100%')

    // Tap targets.
    for (const b of buttons(screen)) {
      expect(px(b.style.minHeight), `"${(b.textContent || '').trim()}" min-height`).toBeGreaterThanOrEqual(44)
    }

    // The reply is still there in full.
    expect(card(host, 'a1')!.querySelector('[data-feedback-entry="team"]')!.textContent).toContain(unbroken)
    await unmount()
  })

  it('the source has no fixed 760px column any more without a phone gutter', () => {
    const src = read('components/feedback/OwnerFeedbackScreen.jsx')
    expect(src).toMatch(/maxWidth: '760px'/)
    expect(src).not.toMatch(/[^x]width: '760px'/)
    expect(src).toMatch(/isMobile \? '18px 16px 70px'/)
  })
})
