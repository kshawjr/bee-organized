// @vitest-environment happy-dom
//
// THE HELP NAV BADGE (ClickUp 868mm1h81): replies to your own reports that you
// have not opened. One meaning, pinned here:
//
//   · only this user's items count — not their location's
//   · an item with no reply text (or only whitespace) is not counted
//   · an item whose reply has been read is not counted
//   · an internal item is never counted
//   · reading a reply ("Got it" on the card) stamps reply_seen_at and the
//     badge drops — through the REAL seen route and the REAL count route,
//     over an in-memory feedback_items table
//   · zero unread draws no badge at all, not a "0"
//   · and on the owner's list: Show and Order work, and a banner link to an
//     item the current Show hides brings it back
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── an in-memory feedback_items table behind both supabase clients ──────
const db = vi.hoisted(() => {
  const state = {
    rows: [] as any[],
    caller: { id: 'me', role: 'owner', location_id: 'loc-1' } as any,
    eqCalls: [] as [string, unknown][],
  }
  const builder = (table: string) => {
    const preds: ((r: any) => boolean)[] = []
    let patch: any = null
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.eq = (c: string, v: unknown) => { if (table === 'feedback_items') state.eqCalls.push([c, v]); preds.push(r => r[c] === v); return b }
    b.in = (c: string, vs: unknown[]) => { preds.push(r => vs.includes(r[c])); return b }
    b.not = (c: string, op: string, v: unknown) => { if (op === 'is' && v === null) preds.push(r => r[c] != null); return b }
    b.update = (p: any) => { patch = p; return b }
    const run = () => {
      if (table === 'hub_users') return { data: state.caller, error: null }
      const hit = state.rows.filter(r => preds.every(p => p(r)))
      if (patch) hit.forEach(r => Object.assign(r, patch))
      return { data: hit.map(r => ({ ...r })), error: null }
    }
    b.single = () => Promise.resolve(run())
    b.maybeSingle = () => Promise.resolve(run())
    b.then = (res: any, rej: any) => Promise.resolve(run()).then(res, rej)
    return b
  }
  return { state, client: { from: (t: string) => builder(t) } }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: db.client }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: db.state.caller.id } } })) },
    from: (t: string) => db.client.from(t),
  })),
}))

import { countUnreadReplies, isCountedUnread } from '@/lib/feedback-unread'
import { GET as unreadGET } from '@/app/api/feedback/unread/route'
import { POST as seenPOST } from '@/app/api/feedback/seen/route'
import { useUnreadReplyCount, NavCountBadge } from '@/components/feedback/UnreadRepliesBadge'
import OwnerFeedbackScreen, { matchesListFilter, sortForList } from '@/components/feedback/OwnerFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const row = (over: any) => ({
  id: 'x', user_id: 'me', location_id: 'loc-1', is_internal: false,
  title: 'A report', description: 'Something happened.', type: 'bug', status: 'planned',
  created_at: daysAgo(10), updated_at: daysAgo(10),
  admin_response: 'We wrote back.', admin_response_at: daysAgo(2), reply_seen_at: null,
  attachments: [], replies: [],
  ...over,
})

// ─── the rule ────────────────────────────────────────────────────────

describe('what counts', () => {
  it('only this user’s items — a colleague’s unread reply at the same location is not mine', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', user_id: 'colleague' })]
    expect(countUnreadReplies(rows, 'me')).toBe(1)
    expect(isCountedUnread(rows[1], 'me')).toBe(false)
  })

  it.each([['null', null], ['empty', ''], ['whitespace', '   \n ']])('no reply text (%s) is not counted', (_l, text) => {
    expect(isCountedUnread(row({ admin_response: text }), 'me')).toBe(false)
  })

  it('a reply already read is not counted', () => {
    expect(isCountedUnread(row({ admin_response_at: daysAgo(3), reply_seen_at: daysAgo(1) }), 'me')).toBe(false)
  })

  it('a SECOND reply written after the first was read is unread again (the card says New too)', () => {
    expect(isCountedUnread(row({ reply_seen_at: daysAgo(5), admin_response_at: daysAgo(1) }), 'me')).toBe(true)
  })

  it('an internal item is never counted', () => {
    expect(isCountedUnread(row({ is_internal: true }), 'me')).toBe(false)
  })
})

// ─── the route ───────────────────────────────────────────────────────

describe('GET /api/feedback/unread', () => {
  beforeEach(() => {
    db.state.caller = { id: 'me', role: 'owner', location_id: 'loc-1' }
    db.state.eqCalls = []
    db.state.rows = [
      row({ id: 'mine-1' }),
      row({ id: 'mine-2' }),
      row({ id: 'colleague', user_id: 'colleague' }),
      row({ id: 'internal', is_internal: true }),
      row({ id: 'blank', admin_response: '  ' }),
      row({ id: 'read', reply_seen_at: daysAgo(1) }),
      row({ id: 'elsewhere', location_id: 'loc-2' }),
    ]
  })
  const count = async () => (await (await unreadGET()).json()).count

  it('counts the caller’s own unread replies and nothing else', async () => {
    expect(await count()).toBe(2)
  })

  it('asks the database for the caller’s own rows, not the location’s', async () => {
    await count()
    expect(db.state.eqCalls).toContainEqual(['user_id', 'me'])
  })

  it('an owner’s own item filed from another location is not on their My requests, so not counted', async () => {
    await count()
    expect(db.state.eqCalls).toContainEqual(['location_id', 'loc-1'])
  })

  it('asks the database to leave internal items out', async () => {
    await count()
    expect(db.state.eqCalls).toContainEqual(['is_internal', false])
  })
})

// ─── the badge ───────────────────────────────────────────────────────

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const mount = async (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(el) })
}
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
afterEach(async () => { await act(async () => { root?.unmount() }); host?.remove(); vi.unstubAllGlobals() })

describe('NavCountBadge', () => {
  it('zero draws nothing at all — no pill, no "0"', async () => {
    await mount(<div data-row><NavCountBadge count={0} /></div>)
    expect(host.querySelector('[data-nav-unread-badge]')).toBeNull()
    expect(host.textContent).toBe('')
  })

  it('a count draws the number, with words for a screen reader', async () => {
    await mount(<NavCountBadge count={9} />)
    const b = host.querySelector('[data-nav-unread-badge]')!
    expect(b.textContent).toBe('9')
    expect(b.getAttribute('aria-label')).toBe('9 unread replies')
  })
})

// The owner's whole loop, through real code: My requests on screen, the Help
// badge beside it, fetch routed to the REAL count and seen routes.
function wireFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.startsWith('/api/feedback/unread')) return unreadGET()
    if (u === '/api/feedback/seen') return seenPOST({ json: async () => JSON.parse(init.body) } as any)
    if (u.startsWith('/api/admin/feedback')) {
      return { ok: true, json: async () => ({ items: db.state.rows.filter(r => r.location_id === 'loc-1' && !r.is_internal).map(r => ({ ...r })) }) } as any
    }
    throw new Error(`unexpected fetch ${u}`)
  }))
}
function Shell() {
  const n = useUnreadReplyCount(true)
  return (
    <CurrentUserContext.Provider value={{ id: 'me' } as any}>
      <nav data-help-nav><span>Help</span><NavCountBadge count={n} /></nav>
      <OwnerFeedbackScreen title={null as any} />
    </CurrentUserContext.Provider>
  )
}
const badge = () => host.querySelector('[data-help-nav] [data-nav-unread-badge]')

describe('reading a reply clears it and the badge drops', () => {
  beforeEach(() => {
    db.state.caller = { id: 'me', role: 'owner', location_id: 'loc-1' }
    db.state.rows = [
      row({ id: 'r1', title: 'Alerts stopped', admin_response: 'Fixed on Thursday.' }),
      row({ id: 'r2', title: 'Tags question', admin_response: 'Settings › Tags.' }),
    ]
  })

  it('Got it → reply_seen_at stamped on that row → badge 2 → 1 → gone', async () => {
    wireFetch()
    await mount(<Shell />)
    await flush()
    expect(badge()?.textContent).toBe('2')

    const gotIt = host.querySelector('[data-feedback-card="r1"] [data-feedback-got-it]') as HTMLButtonElement
    expect(gotIt).toBeTruthy()
    await act(async () => { gotIt.click() })
    await flush()
    expect(db.state.rows.find(r => r.id === 'r1')!.reply_seen_at).toBeTruthy()
    expect(db.state.rows.find(r => r.id === 'r2')!.reply_seen_at).toBeNull()
    expect(badge()?.textContent).toBe('1')

    // Clicking anywhere on the other card is reading it too.
    await act(async () => { (host.querySelector('[data-feedback-card="r2"]') as HTMLElement).click() })
    await flush()
    expect(badge()).toBeNull()
    expect(host.querySelector('[data-help-nav]')!.textContent).toBe('Help')
  })

  it('a reload after reading still shows the lower count — it is the server, not the screen', async () => {
    wireFetch()
    await mount(<Shell />)
    await flush()
    await act(async () => { (host.querySelector('[data-feedback-card="r1"] [data-feedback-got-it]') as HTMLButtonElement).click() })
    await flush()
    await act(async () => { root.unmount() })
    await mount(<Shell />)
    await flush()
    expect(badge()?.textContent).toBe('1')
  })
})

// ─── the shell wiring (source checks — BeeHub is too large to mount) ──

describe('BeeHub carries the badge on Help', () => {
  const src = read('components/BeeHub.jsx')
  it('the Help nav item carries the count, off under view-as', () => {
    expect(src).toContain("{ key:'help',     icon:'❓', label:'Help', badge: helpUnread }")
    expect(src).toContain('const helpUnread = useUnreadReplyCount(!viewAsUser)')
  })
  it('both nav renderers draw it — the phone drawer and the desktop sidebar', () => {
    expect(src.match(/<NavCountBadge count=\{item\.badge\} \/>/g) || []).toHaveLength(2)
  })
  it('tapping Help with replies waiting lands on My requests', () => {
    expect(src).toMatch(/function nav\(key\) \{\s*\n\s*\/\/[^\n]*\n\s*if \(key === 'help' && helpUnread > 0\) setHelpIntent\('requests'\)/)
  })
})

// ─── sort and filter on My requests ──────────────────────────────────

describe('the owner can sort and filter their list', () => {
  const ITEMS = [
    row({ id: 'waiting', title: 'Waiting one', status: 'submitted', admin_response: null, admin_response_at: null, created_at: daysAgo(3) }),
    row({ id: 'replied', title: 'Replied one', status: 'planned', created_at: daysAgo(9), reply_seen_at: daysAgo(1) }),
    row({ id: 'closed', title: 'Closed one', status: 'shipped', created_at: daysAgo(20), reply_seen_at: daysAgo(1) }),
  ]

  it('the four Show choices split the list without overlap', () => {
    for (const it of ITEMS) {
      const hits = ['waiting', 'replied', 'closed'].filter(f => matchesListFilter(it, f))
      expect(hits).toEqual([it.id])
      expect(matchesListFilter(it, 'all')).toBe(true)
    }
  })

  it('Order flips newest-first to oldest-first', () => {
    expect(sortForList(ITEMS, 'newest').map(i => i.id)).toEqual(['waiting', 'replied', 'closed'])
    expect(sortForList(ITEMS, 'oldest').map(i => i.id)).toEqual(['closed', 'replied', 'waiting'])
  })

  const cardsShown = () => Array.from(host.querySelectorAll('[data-feedback-card]')).map(c => c.getAttribute('data-feedback-card'))
  const choose = async (sel: string, value: string) => {
    const el = host.querySelector(sel) as HTMLSelectElement
    await act(async () => {
      el.value = value
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('choosing Show and Order changes the cards on screen', async () => {
    db.state.rows = ITEMS.map(i => ({ ...i }))
    wireFetch()
    await mount(<Shell />)
    await flush()
    await choose('[data-feedback-filter]', 'replied')
    expect(cardsShown()).toEqual(['replied'])
    await choose('[data-feedback-filter]', 'all')
    await choose('[data-feedback-order]', 'oldest')
    // Everything: open first (oldest first), closed folded below.
    expect(cardsShown()).toEqual(['replied', 'waiting'])
  })

  it('a banner link to an item the current Show hides switches back to everything', async () => {
    db.state.rows = [
      ...ITEMS.map(i => ({ ...i })),
      row({ id: 'unread', title: 'Unread one', status: 'planned', created_at: daysAgo(4) }),
    ]
    wireFetch()
    await mount(<Shell />)
    await flush()
    await choose('[data-feedback-filter]', 'closed')
    expect(cardsShown()).toEqual(['closed'])
    const link = host.querySelector('[data-feedback-banner-link="unread"]') as HTMLAnchorElement
    await act(async () => { link.click() })
    expect((host.querySelector('[data-feedback-filter]') as HTMLSelectElement).value).toBe('all')
    expect(cardsShown()).toContain('unread')
  })

  it('one item shows no controls at all', async () => {
    db.state.rows = [ITEMS[0]].map(i => ({ ...i }))
    wireFetch()
    await mount(<Shell />)
    await flush()
    expect(host.querySelector('[data-feedback-list-controls]')).toBeNull()
  })
})
