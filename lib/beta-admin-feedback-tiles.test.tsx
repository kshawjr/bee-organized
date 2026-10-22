// @vitest-environment happy-dom
//
// THE ADMIN FEEDBACK SCREEN, REDESIGNED — the screen half (the route half is
// lib/beta-admin-feedback-routes.test.ts).
//
// The badge said 40 and Leslie read forty things on fire; four were bugs
// nobody had answered. Then Kevin could not read the tiles quickly, so the
// plain-English pass renamed them, split the rows by look, and made Stuck a
// strip. What this file pins:
//   · the badge is unanswered bugs + unanswered questions, nothing else
//   · six tiles in two groups, each the right set, mutually exclusive, summing
//     to the open total — and clicking one filters the list to it
//   · Stuck cannot be picked from the status dropdown
//   · the claim circle claims and releases; "who has it" filters
//   · the looks-built tick saves and flags the row
//   · age is amber past 10 days and red past 21, on the row
//   · closed items are reached through the filters; no bottom link
//   · the modal: analysis above the reply box, Save's consequences before the click
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  adminTileOf, adminBadgeCount, summarizeAdminTiles, ageTone, isBadgeItem, ADMIN_TILES, wouldHandSetStuck,
} from '@/lib/feedback-admin-tiles'
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'

const BEEHUB_SRC = readFileSync('components/BeeHub.jsx', 'utf8')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000 - 3600000).toISOString()
let seq = 0
const item = (over: any) => ({
  id: `i${++seq}`, title: `Item ${seq}`, description: 'Words.', type: 'bug', status: 'submitted',
  user_id: 'owner-1', submitter_name: 'Ankur Patel', submitter_email: 'ankur@pb.com',
  location_id: 'loc-1', location_name: 'Palm Beach', created_at: daysAgo(3), updated_at: daysAgo(3),
  admin_response: null, admin_response_at: null, reply_seen_at: null, attachments: [], replies: [],
  is_internal: false, assigned_to: null, assigned_to_name: null, looks_shipped: false,
  ...over,
})
const replied = { admin_response: 'We hear you.', admin_response_at: daysAgo(1) }

// One of every shape the tiles must sort — including the zero-row-in-
// production edges (hazard, decision, in_progress, an unknown type).
const FIX_BUG      = item({ id: 'fix-bug', title: 'Login broken', type: 'bug', created_at: daysAgo(24) })
const FIX_HAZARD   = item({ id: 'fix-hazard', title: 'Token race', type: 'hazard', is_internal: true })
const ANSWER_Q     = item({ id: 'answer-q', title: 'Where are drips', type: 'question', created_at: daysAgo(44) })
const DECIDE_IDEA  = item({ id: 'decide-idea', title: 'Snooze Button', type: 'feature', created_at: daysAgo(79) })
const DECIDE_DEC   = item({ id: 'decide-dec', title: 'Pick a vendor', type: 'decision', is_internal: true })
const DECIDE_UNREPLIED_PLANNED = item({ id: 'decide-planned', title: 'Moved but unanswered idea', type: 'feature', status: 'planned' })
const BUILD_PLANNED = item({ id: 'build-planned', title: 'Bulk edit', type: 'feature', status: 'planned', ...replied, created_at: daysAgo(127) })
const BUILD_PROG    = item({ id: 'build-prog', title: 'Calendar sync', type: 'bug', status: 'in_progress', ...replied })
const DECIDING      = item({ id: 'deciding', title: 'Dark mode', type: 'feature', status: 'under_review', ...replied, created_at: daysAgo(93) })
const STUCK         = item({ id: 'stuck', title: 'Email cut off', type: 'bug', status: 'submitted', ...replied, created_at: daysAgo(36) })
const CLOSED_SHIP   = item({ id: 'closed-ship', title: 'Old fixed', status: 'shipped', ...replied })
const CLOSED_ANS    = item({ id: 'closed-ans', title: 'Old answered', type: 'question', status: 'answered', ...replied })
const CLOSED_DEC    = item({ id: 'closed-dec', title: 'Old declined', type: 'feature', status: 'declined' })

const ALL = [FIX_BUG, FIX_HAZARD, ANSWER_Q, DECIDE_IDEA, DECIDE_DEC, DECIDE_UNREPLIED_PLANNED, BUILD_PLANNED, BUILD_PROG, DECIDING, STUCK, CLOSED_SHIP, CLOSED_ANS, CLOSED_DEC]
const EXPECTED: Record<string, string[]> = {
  fix: ['fix-bug', 'fix-hazard'],
  answer: ['answer-q'],
  decide: ['decide-idea', 'decide-dec', 'decide-planned'],
  build: ['build-planned', 'build-prog'],
  deciding: ['deciding'],
  stuck: ['stuck'],
}

function server(initial: any[]) {
  const store = initial.map(i => ({ ...i }))
  const calls: { url: string, init?: any }[] = []
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    calls.push({ url: u, init })
    const ok = (body: any, status = 200) => ({ ok: true, status, json: async () => body }) as any
    const m = u.match(/^\/api\/admin\/feedback\/([^/?]+)$/)
    if (m && init?.method === 'PATCH') {
      const row = store.find(r => r.id === m[1])!
      const body = JSON.parse(init.body)
      Object.assign(row, body)
      if ('assigned_to' in body) row.assigned_to_name = body.assigned_to ? 'Kevin Brown' : null
      return ok({ ...row })
    }
    if (u.startsWith('/api/admin/feedback/analysis')) return ok({ analyses: [], clusters: [], drafts: [] })
    if (u.startsWith('/api/admin/feedback')) return ok({ items: store.map(r => ({ ...r })) })
    return ok({})
  })
  vi.stubGlobal('fetch', f)
  return { f, store, calls, patches: () => calls.filter(c => c.init?.method === 'PATCH').map(c => ({ url: c.url, body: JSON.parse(c.init.body) })) }
}

async function mount(items: any[], props: any = {}, me = 'admin-1') {
  const srv = server(items)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={{ id: me, email: 'kevin@bmave.com' } as any}>
        <AdminFeedbackScreen {...props} />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return { host, srv, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = async (el: Element | null | undefined) => {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}
const choose = async (sel: HTMLSelectElement, value: string) => {
  await act(async () => {
    sel.value = value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const select = (host: Element, label: string) => host.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement
const rowIds = (host: Element) => [...host.querySelectorAll('[data-row]')].map(r => r.getAttribute('data-row'))
const tileCount = (host: Element, key: string) => Number(host.querySelector(`[data-tile="${key}"] [data-tile-count]`)?.textContent)

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

// ─── 1. the badge ──────────────────────────────────────────────────

describe('the badge counts people waiting on a real answer', () => {
  it('unanswered bugs plus unanswered questions — and nothing else', () => {
    // fix-bug + answer-q. Not the hazard (internal), not ideas, not anything
    // we have replied to, not anything closed.
    expect(ALL.filter(isBadgeItem).map(i => i.id).sort()).toEqual(['answer-q', 'fix-bug'])
    expect(adminBadgeCount(ALL)).toBe(2)
  })

  it('the screen reports that number up to the nav, not the open count', async () => {
    const onBadge = vi.fn()
    const { unmount } = await mount(ALL, { onBadgeCountChange: onBadge })
    expect(onBadge).toHaveBeenLastCalledWith(2)
    await unmount()
  })

  it('both nav badges in BeeHub prime from the badge count; the dashboard card keeps the open count', () => {
    expect(BEEHUB_SRC).toMatch(/async function fetchFeedbackBadgeCount\(\)[\s\S]{0,400}return adminBadgeCount\(data\.items\)/)
    expect(BEEHUB_SRC.match(/fetchFeedbackBadgeCount\(\)\.then\(n => \{ if \(!cancelled && n != null\) setFeedbackPending\(n\) \}\)/g)).toHaveLength(2)
    expect(BEEHUB_SRC.match(/<AdminFeedbackScreen onBadgeCountChange=\{handleFeedbackPending\} \/>/g)).toHaveLength(2)
    expect(BEEHUB_SRC).not.toContain('onOpenCountChange')
    expect(BEEHUB_SRC).toMatch(/fetchFeedbackOpenCount\(\)\s*\n\s*\.then\(n => \{ if \(!cancelled\) setActionCounts/)
  })
})

// ─── 2. six tiles ──────────────────────────────────────────────────

describe('the six tiles', () => {
  it('each counts exactly its own set', () => {
    for (const t of ADMIN_TILES) {
      expect(ALL.filter(i => adminTileOf(i) === t.key).map(i => i.id).sort(), t.key).toEqual([...EXPECTED[t.key]].sort())
    }
  })

  it('are mutually exclusive and sum to the open total', () => {
    const open = ALL.filter(i => !['answered', 'shipped', 'declined'].includes(i.status))
    const seen = new Map<string, string>()
    for (const i of open) {
      const t = adminTileOf(i)
      expect(t, i.id).not.toBeNull()
      expect(seen.has(i.id)).toBe(false)
      seen.set(i.id, t!)
    }
    const s = summarizeAdminTiles(ALL)
    const sum = ADMIN_TILES.reduce((n, t) => n + s.tiles[t.key].count, 0)
    expect(sum).toBe(open.length)
    expect(s.open).toBe(open.length)
    expect(s.groups.unreplied.count + s.groups.replied.count).toBe(open.length)
    // closed items have no tile
    for (const c of [CLOSED_SHIP, CLOSED_ANS, CLOSED_DEC]) expect(adminTileOf(c)).toBeNull()
  })

  it('the screen shows the same counts, in two groups headed in sentence case, five tiles and no Stuck tile', async () => {
    const { host, unmount } = await mount(ALL)
    for (const t of ADMIN_TILES.filter(t => t.key !== 'stuck')) expect(tileCount(host, t.key), t.key).toBe(EXPECTED[t.key].length)
    expect(host.querySelector('[data-tile="stuck"]')).toBeNull()
    expect(host.querySelectorAll('[data-tile]').length).toBe(5)
    expect(host.querySelector('[data-group-count="unreplied"]')?.textContent).toBe('6')
    expect(host.querySelector('[data-group-count="replied"]')?.textContent).toBe('4')
    const labels = [...host.querySelectorAll('[data-group-label]')].map(e => e.textContent)
    expect(labels).toEqual(['Waiting to hear from us', 'Heard from us, still waiting'])
    for (const l of [...host.querySelectorAll('[data-group-label]')] as HTMLElement[]) {
      expect((l.parentElement as HTMLElement).style.textTransform).not.toBe('uppercase')
    }
    const fix = host.querySelector('[data-tile="fix"]')!
    const parts = [...fix.children].map(c => [...c.attributes].map(a => a.name).find(n => n.startsWith('data-tile-')))
    expect(parts).toEqual(['data-tile-count', 'data-tile-name', 'data-tile-what', 'data-tile-oldest'])
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    await unmount()
  })

  it('each tile renders its plain-noun label and its full-sentence description', async () => {
    const { host, unmount } = await mount(ALL)
    const want: Record<string, [string, string]> = {
      fix:      ['Bugs',          'Something is broken and they are stuck with it.'],
      answer:   ['Questions',     'They asked us something. A reply finishes it.'],
      decide:   ['Ideas',         'They want something new. Yes, no, or not now.'],
      build:    ['We said yes',   'Promised and not built yet.'],
      deciding: ['We said maybe', 'We said we would look, and never came back.'],
    }
    for (const [key, [name, what]] of Object.entries(want)) {
      expect(host.querySelector(`[data-tile="${key}"] [data-tile-name]`)?.textContent, key).toBe(name)
      expect(host.querySelector(`[data-tile="${key}"] [data-tile-what]`)?.textContent, key).toBe(what)
    }
    for (const verb of ['Fix', 'Answer', 'Decide', 'Build', 'Still deciding']) {
      expect([...host.querySelectorAll('[data-tile-name], [data-section-title]')].map(e => e.textContent), verb).not.toContain(verb)
    }
    expect(host.querySelector('[data-tile="answer"] [data-tile-oldest]')?.textContent).toBe('Oldest: 44 days')
    await unmount()
  })

  it('the two rows look different: raised top row with its own hue and a shadow, recessed flat bottom row', async () => {
    const { host, unmount } = await mount(ALL)
    const top = ['fix', 'answer', 'decide'].map(k => host.querySelector(`[data-tile="${k}"]`) as HTMLElement)
    const bottom = ['build', 'deciding'].map(k => host.querySelector(`[data-tile="${k}"]`) as HTMLElement)
    // Each top tile its own hue: three different backgrounds, none the bottom row's.
    const topBgs = top.map(t => t.style.background)
    expect(new Set(topBgs).size).toBe(3)
    for (const t of top) expect(t.getAttribute('data-tile-row')).toBe('raised')
    // The bottom row shares ONE fill, and it is not any top tile's fill.
    expect(bottom[0].style.background).toBe(bottom[1].style.background)
    for (const bg of topBgs) expect(bg).not.toBe(bottom[0].style.background)
    // Only the top row has a shadow.
    for (const t of top) expect(t.style.boxShadow, t.getAttribute('data-tile')!).not.toMatch(/^(none|)$/)
    for (const t of bottom) expect(['none', ''], t.getAttribute('data-tile')!).toContain(t.style.boxShadow)
    await unmount()
  })

  it('clicking a tile filters the list to it; clicking it again clears the filter', async () => {
    const { host, unmount } = await mount(ALL)
    await click(host.querySelector('[data-tile="decide"]'))
    expect(host.querySelector('[data-tile="decide"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(rowIds(host).sort()).toEqual([...EXPECTED.decide].sort())
    await click(host.querySelector('[data-tile="build"]'))
    expect(rowIds(host).sort()).toEqual([...EXPECTED.build].sort())
    await click(host.querySelector('[data-tile="build"]'))
    expect(rowIds(host).length).toBe(10)
    await unmount()
  })

  it('a section heading is the name and the count — never the description', async () => {
    const { host, unmount } = await mount(ALL)
    for (const t of ADMIN_TILES.filter(t => t.key !== 'stuck')) {
      const sec = host.querySelector(`[data-section="${t.key}"]`)!
      const h3 = sec.querySelector('h3') as HTMLElement
      expect(sec.querySelector('[data-section-title]')?.textContent).toBe(t.name)
      expect(sec.querySelector('[data-section-count]')?.textContent).toBe(String(EXPECTED[t.key].length))
      expect(h3.textContent).toBe(`${t.name}${EXPECTED[t.key].length}`)
      expect(h3.textContent).not.toContain(t.what)
      expect(sec.querySelector('[data-section-line]')).toBeNull()
    }
    // The top row's sections wear their tile's ink.
    const tileName = host.querySelector('[data-tile="fix"] [data-tile-name]') as HTMLElement
    expect((host.querySelector('[data-section="fix"] h3') as HTMLElement).style.color).toBe(tileName.style.color)
    await unmount()
  })

  it('status chips only in the replied group', async () => {
    const { host, unmount } = await mount(ALL)
    for (const k of ['fix', 'answer', 'decide']) expect(host.querySelector(`[data-section="${k}"] [data-status-chip]`), k).toBeNull()
    expect(host.querySelector('[data-section="build"] [data-status-chip]')?.textContent).toBe(FEEDBACK_STATUS_PLAIN.planned)
    expect(host.querySelector('[data-section="stuck"] [data-status-chip]')?.textContent).toBe(FEEDBACK_STATUS_PLAIN.submitted)
    await unmount()
  })
})

// ─── 5. Stuck is a strip, not a tile ───────────────────────────────

describe('Stuck is not a tile', () => {
  it('zero Stuck renders no strip and no tile', async () => {
    const { host, unmount } = await mount(ALL.filter(i => i.id !== 'stuck'))
    expect(host.querySelector('[data-stuck-strip]')).toBeNull()
    expect(host.querySelector('[data-tile="stuck"]')).toBeNull()
    expect(host.textContent).not.toContain('nobody has answered')
    // the bottom row is two tiles
    expect(host.querySelectorAll('[data-tile-group="replied"] [data-tile]').length).toBe(2)
    await unmount()
  })

  it('non-zero Stuck renders one red strip above both groups, and Show them filters to them', async () => {
    const STUCK2 = item({ ...STUCK, id: 'stuck-2', title: 'Second stuck', created_at: daysAgo(5) })
    const { host, unmount } = await mount([...ALL, STUCK2])
    const strip = host.querySelector('[data-stuck-strip]') as HTMLElement
    expect(strip).toBeTruthy()
    expect(strip.textContent).toContain('2 have a reply but still say nobody has answered.')
    expect(strip.textContent).toContain('Someone wrote back and the status never moved.')
    expect(strip.style.background).toBe((host.querySelector('[data-tile="fix"]') as HTMLElement).style.background) // the red tint
    const firstGroup = host.querySelector('[data-tile-group="unreplied"]')!
    expect(strip.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(host.querySelector('[data-tile="stuck"]')).toBeNull()
    await click(strip.querySelector('[data-stuck-show]'))
    expect(rowIds(host).sort()).toEqual(['stuck', 'stuck-2'])
    await unmount()
  })

  it('one Stuck item reads in the singular', async () => {
    const { host, unmount } = await mount(ALL)
    expect(host.querySelector('[data-stuck-strip]')!.textContent).toContain('1 has a reply but still says nobody has answered.')
    await unmount()
  })
})

// ─── 3. Stuck ──────────────────────────────────────────────────────

describe('Stuck is never picked by hand', () => {
  it('the rule: only a move INTO submitted on a replied item', () => {
    expect(wouldHandSetStuck({ fromStatus: 'planned', toStatus: 'submitted', replyAfter: 'x' })).toBe(true)
    expect(wouldHandSetStuck({ fromStatus: 'planned', toStatus: 'submitted', replyAfter: '' })).toBe(false)
    expect(wouldHandSetStuck({ fromStatus: 'submitted', toStatus: 'submitted', replyAfter: 'x' })).toBe(false)
    expect(wouldHandSetStuck({ fromStatus: 'planned', toStatus: 'under_review', replyAfter: 'x' })).toBe(false)
  })

  it('the status dropdown disables With the team on a replied item, and only there', async () => {
    const { host, unmount } = await mount(ALL)
    await click([...host.querySelectorAll('[data-row="build-planned"] button')].pop())
    const opt = [...(select(host, 'Status').options)].find(o => o.value === 'submitted')!
    expect(opt.disabled).toBe(true)
    expect([...(select(host, 'Status').options)].filter(o => o.disabled).map(o => o.value)).toEqual(['submitted'])
    await unmount()

    const second = await mount(ALL)
    await click([...second.host.querySelectorAll('[data-row="decide-planned"] button')].pop())
    expect([...(select(second.host, 'Status').options)].find(o => o.value === 'submitted')!.disabled).toBe(false)
    await second.unmount()
  })
})

// ─── 5. assignment ─────────────────────────────────────────────────

describe('who has it', () => {
  it('an unclaimed row shows a dashed plus; clicking claims it as me, with assigned_to', async () => {
    const { host, srv, unmount } = await mount(ALL)
    const circle = host.querySelector('[data-claim="fix-bug"]')!
    expect(circle.getAttribute('data-claimed')).toBe('no')
    await click(circle)
    expect(srv.patches()).toEqual([{ url: '/api/admin/feedback/fix-bug', body: { assigned_to: 'admin-1' } }])
    const after = host.querySelector('[data-claim="fix-bug"]')!
    expect(after.getAttribute('data-claimed')).toBe('yes')
    expect(after.textContent).toBe('KB')
    await unmount()
  })

  it('clicking a claimed row releases it with assigned_to: null', async () => {
    const { host, srv, unmount } = await mount([item({ ...FIX_BUG, assigned_to: 'admin-2', assigned_to_name: 'Leslie Mullins' })])
    expect(host.querySelector('[data-claim="fix-bug"]')!.textContent).toBe('LM')
    await click(host.querySelector('[data-claim="fix-bug"]'))
    expect(srv.patches()).toEqual([{ url: '/api/admin/feedback/fix-bug', body: { assigned_to: null } }])
    expect(host.querySelector('[data-claim="fix-bug"]')!.getAttribute('data-claimed')).toBe('no')
    await unmount()
  })

  it('the filter: Mine, Nobody yet, and a named person', async () => {
    const rows = [
      item({ ...FIX_BUG, assigned_to: 'admin-1', assigned_to_name: 'Kevin Brown' }),
      item({ ...ANSWER_Q, assigned_to: 'admin-2', assigned_to_name: 'Leslie Mullins' }),
      item({ ...DECIDE_IDEA }),
    ]
    const { host, unmount } = await mount(rows)
    const who = select(host, 'Who has it')
    await choose(who, 'mine')
    expect(rowIds(host)).toEqual(['fix-bug'])
    await choose(who, 'nobody')
    expect(rowIds(host)).toEqual(['decide-idea'])
    await choose(who, 'admin-2')
    expect(rowIds(host)).toEqual(['answer-q'])
    expect([...who.options].map(o => o.textContent)).toContain('Leslie Mullins')
    await unmount()
  })

  it('the modal says who has it, and can claim it', async () => {
    const { host, srv, unmount } = await mount([item({ ...ANSWER_Q, assigned_to: 'admin-2', assigned_to_name: 'Leslie Mullins' })])
    await click([...host.querySelectorAll('[data-row="answer-q"] button')].pop())
    expect(host.querySelector('[data-modal-assignee]')?.textContent).toBe('Leslie Mullins has this')
    await click(host.querySelector('[role="dialog"] [data-claim="answer-q"]'))
    expect(srv.patches()[0].body).toEqual({ assigned_to: null })
    expect(host.querySelector('[data-modal-assignee]')?.textContent).toBe('Nobody has this yet')
    await unmount()
  })
})

// ─── 6. looks already built ────────────────────────────────────────

describe('the looks-built tick', () => {
  it('ticking it in the modal PATCHes looks_shipped and the row grows a flag', async () => {
    const { host, srv, unmount } = await mount([DECIDE_IDEA])
    expect(host.querySelector('[data-row="decide-idea"] [data-looks-shipped-flag]')).toBeNull()
    await click([...host.querySelectorAll('[data-row="decide-idea"] button')].pop())
    await click(host.querySelector('[data-looks-shipped-box]'))
    expect(srv.patches()).toEqual([{ url: '/api/admin/feedback/decide-idea', body: { looks_shipped: true } }])
    expect(srv.store[0].looks_shipped).toBe(true)
    expect(host.querySelector('[data-row="decide-idea"] [data-looks-shipped-flag]')?.textContent).toContain('Looks built')
    await unmount()
  })

  it('it is never computed: a tick-less item never shows the flag, whatever its status', async () => {
    const { host, unmount } = await mount(ALL)
    await choose(select(host, 'Open or closed'), 'all')
    expect(host.querySelector('[data-looks-shipped-flag]')).toBeNull()
    await unmount()
  })
})

// ─── 4. age ────────────────────────────────────────────────────────

describe('age carries the urgency', () => {
  it('plain under 30, amber 30 to 59, red at 60 or more', () => {
    expect(ageTone(0)).toBe('plain')
    expect(ageTone(29)).toBe('plain')
    expect(ageTone(30)).toBe('amber')
    expect(ageTone(59)).toBe('amber')
    expect(ageTone(60)).toBe('red')
    expect(ageTone(null)).toBe('plain')
  })

  it('on the row, at the boundaries', async () => {
    const rows = [29, 30, 59, 60].map(d => item({ id: `age-${d}`, created_at: daysAgo(d) }))
    const { host, unmount } = await mount(rows)
    const tone = (id: string) => host.querySelector(`[data-row="${id}"] [data-age-tone]`)?.getAttribute('data-age-tone')
    expect(tone('age-29')).toBe('plain')
    expect(tone('age-30')).toBe('amber')
    expect(tone('age-59')).toBe('amber')
    expect(tone('age-60')).toBe('red')
    expect(host.querySelector('[data-row="age-60"] [data-age-tone]')?.textContent).toBe('60 days old')
    await unmount()
  })

  it('on the tile, at the boundaries — "Oldest: N days"', async () => {
    for (const [d, want] of [[29, 'plain'], [30, 'amber'], [59, 'amber'], [60, 'red']] as const) {
      const { host, unmount } = await mount([item({ id: `t-${d}`, created_at: daysAgo(d) })])
      const el = host.querySelector('[data-tile="fix"] [data-age-tone]')!
      expect(el.getAttribute('data-age-tone'), String(d)).toBe(want)
      expect(el.textContent).toBe(`Oldest: ${d} days`)
      await unmount()
    }
  })

  it('an age under 30 days is not red — on a row or a tile', async () => {
    const { host, unmount } = await mount([item({ id: 'young', created_at: daysAgo(24) })])
    for (const el of [...host.querySelectorAll('[data-age-tone]')] as HTMLElement[]) {
      expect(el.getAttribute('data-age-tone')).toBe('plain')
      expect(el.style.color).not.toBe('rgb(180, 35, 24)')
      expect(el.style.color).not.toBe('#b42318')
    }
    await unmount()
  })

  it('no red dot', async () => {
    const { host, unmount } = await mount(ALL)
    expect(host.querySelector('[data-testid="needs-dot"]')).toBeNull()
    await unmount()
  })
})

// ─── 8. closed items ───────────────────────────────────────────────

describe('closed items are reached through the filters', () => {
  it('no bottom "Show closed" link; the Open/Closed/Everything filter names the counts', async () => {
    const { host, unmount } = await mount(ALL)
    expect([...host.querySelectorAll('button')].some(b => /(show|hide)\s+\d+\s+closed/i.test(b.textContent || ''))).toBe(false)
    const scope = select(host, 'Open or closed')
    expect([...scope.options].map(o => o.textContent)).toEqual(['Open (10)', 'Closed (3)', 'Everything (13)'])
    expect(rowIds(host)).not.toContain('closed-ship')
    await choose(scope, 'closed')
    expect(rowIds(host).sort()).toEqual(['closed-ans', 'closed-dec', 'closed-ship'])
    // grouped by the shared closed words, with chips
    expect(host.querySelector('[data-section="closed-shipped"] [data-section-title]')?.textContent).toBe(FEEDBACK_STATUS_PLAIN.shipped)
    expect(host.querySelector('[data-row="closed-dec"] [data-status-chip]')?.textContent).toBe(FEEDBACK_STATUS_PLAIN.declined)
    await choose(scope, 'all')
    expect(rowIds(host).length).toBe(13)
    await unmount()
  })
})

// ─── 7. the modal ──────────────────────────────────────────────────

describe('the detail modal', () => {
  it('the team-only analysis block sits ABOVE the reply box', async () => {
    const { host, unmount } = await mount([ANSWER_Q])
    await click([...host.querySelectorAll('[data-row="answer-q"] button')].pop())
    const block = host.querySelector('[data-testid="corporate-block"]')!
    const reply = host.querySelector('#fb-reply')!
    expect(block.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await unmount()
  })

  it('Save’s consequences are listed before the click, and the email is the loud one', async () => {
    const { host, unmount } = await mount([ANSWER_Q])
    await click([...host.querySelectorAll('[data-row="answer-q"] button')].pop())
    expect(host.querySelector('[data-save-consequences]')).toBeNull()
    const box = host.querySelector('#fb-reply') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Open Drips, then Sent.')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await choose(select(host, 'Type'), 'bug')
    const list = host.querySelector('[data-save-consequences]')!
    const keys = [...list.querySelectorAll('[data-consequence]')].map(li => li.getAttribute('data-consequence'))
    expect(keys).toEqual(['type', 'status', 'reply', 'email'])
    expect(list.querySelector('[data-consequence="email"]')?.textContent).toBe('Email ankur@pb.com')
    expect((list.querySelector('[data-consequence="email"]') as HTMLElement).style.fontWeight).toBe('700')
    expect(list.querySelector('[data-consequence="status"]')?.textContent).toBe(`Move it from ${FEEDBACK_STATUS_PLAIN.submitted} to ${FEEDBACK_STATUS_PLAIN.answered}`)
    // …and the box sits in the pinned footer, right above the button that does it.
    const save = [...host.querySelectorAll('button')].find(b => b.textContent === 'Save and email Ankur')!
    expect(save).toBeTruthy()
    expect(list.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await unmount()
  })
})
