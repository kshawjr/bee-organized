// @vitest-environment happy-dom
//
// 2026-10-17 — two changes to the Mailchimp card, pinned here:
//
//   1. THE FIRST SYNC IS CONFIRMED. Before any lead at a location has been
//      synced, Sync now sends NOTHING until the owner has seen and confirmed
//      "This will subscribe N people to <audience>". The check is in the
//      ENGINE, so a bare POST to the route cannot get round it, and the
//      confirmed count must match what is about to send — a lead that arrived
//      in between means asking again, not sending N+1.
//
//   2. A CONNECTED OWNER IS TOLD SENDING ISN'T ON YET. One line under the card,
//      from a read-only status route. Nothing here can turn sending on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// ── Chainable Supabase mock (same shape as the 3A suite) ──────
type Resolved = { data?: any; error?: any; count?: number | null }
// 2026-11-25: the engine half retired (see below); the card tests never reach the database.
let dbResolver: (q: any) => Resolved = () => ({ data: [], error: null })
let dbWrites: Array<{ table: string; payload: any; eq: any[] }>

function makeBuilder(table: string) {
  const q: any = { table, calls: [], head: false }
  const b: any = {}
  for (const m of ['select', 'eq', 'neq', 'not', 'is', 'in', 'order', 'range']) {
    b[m] = (...args: any[]) => { q.calls.push([m, ...args]); if (m === 'select' && args[1]?.head) q.head = true; return b }
  }
  b.update = (payload: any) => ({
    eq: (...eqArgs: any[]) => { dbWrites.push({ table, payload, eq: eqArgs }); return Promise.resolve({ data: null, error: null }) },
  })
  b.maybeSingle = () => Promise.resolve(dbResolver(q))
  b.then = (ok: any, err: any) => Promise.resolve(dbResolver(q)).then(ok, err)
  return b
}

vi.mock('./supabase-service', () => ({ supabaseService: { from: (t: string) => makeBuilder(t) } }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => makeBuilder(t) } }))

import { syncWebsiteLeadsToMailchimp } from '@/lib/mailchimp-sync'
import { NOT_LIVE_COPY, firstSyncConfirmCopy } from '@/lib/mailchimp-connection-state'
import { MailchimpCard } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = 'aaaaaaaa-1111-4222-8333-444455556666'

const lead = (id: string, email: string) => ({
  id, email, first_name: 'Pat', last_name: 'Jones', source: 'Website', project_type: 'Moving',
  paid_amount: 0, is_junk: false, created_at: new Date().toISOString(), import_source: 'manual',
})

const isSyncedBeforeCount = (q: any) =>
  q.table === 'leads' && q.head && q.calls.some((c: any[]) => c[0] === 'not' && c[1] === 'mailchimp_synced_at')

// syncedBefore: how many leads at the location already carry mailchimp_synced_at.
// 0 = this is the location's first sync.
function resolver(leads: any[], opts: { syncedBefore?: number | null; syncedErr?: any; location?: any } = {}) {
  return (q: any): Resolved => {
    if (q.table === 'locations') return {
      data: {
        id: LOC, mailchimp_connected: true, mailchimp_access_token: 'tok', mailchimp_server_prefix: 'us7',
        mailchimp_list_id: 'list1', mailchimp_list_name: 'Bee Organized Friends', mailchimp_sync_live: true,
        ...(opts.location || {}),
      }, error: null,
    }
    if (isSyncedBeforeCount(q)) return { data: null, error: opts.syncedErr || null, count: opts.syncedErr ? null : (opts.syncedBefore ?? 0) }
    if (q.table === 'leads' && q.head) return { data: null, error: null, count: leads.length }
    if (q.table === 'leads') return { data: leads, error: null }
    return { data: [], error: null }
  }
}

let fetchMock: any
beforeEach(() => {
  dbWrites = []
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'subscribed' }) }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const TWO = [lead('l1', 'a@example.com'), lead('l2', 'b@example.com')]

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE ENGINE
// ═══════════════════════════════════════════════════════════════════════════
// 2026-11-25, FL-75 slice 6 RETIRED the engine half of this file. It pinned
// the old rule "first = no lead has mailchimp_synced_at" and a confirm of
// { count, list_id }. Slice 6's engine counts a first sync as finished only
// when a whole run completed (sync_log 'mailchimp_push' 'complete'), and the
// confirm also carries the flows fingerprint. The same promises — no confirm,
// a stale count, another audience: nothing sends; a failed "first?" read
// throws; switched off wins; nobody to send is an honest zero — are pinned
// against the new engine in lib/mailchimp-first-push.test.ts.

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE ROUTE RELAYS THE CONFIRM, AND ONLY A WELL-FORMED ONE
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /api/mailchimp/sync passes confirm through to the engine', () => {
  it('a body confirm reaches the engine; a malformed one arrives as null', async () => {
    vi.resetModules()
    const engine = vi.fn(async () => ({
      ran: false, reason: 'needs_confirmation', pushed: 0, skipped: 0, failed: 0, errors: [],
      confirm: { count: 19, listId: 'list1', listName: 'Bee Organized Friends', flows: 'fp1', pausedFlows: [], heldTags: [] },
    }))
    vi.doMock('@/lib/mailchimp-sync', () => ({ syncWebsiteLeadsToMailchimp: engine }))
    vi.doMock('@/lib/supabase-server', () => ({
      createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
    }))
    vi.doMock('@/lib/mailchimp-oauth-guard', () => ({
      resolveMailchimpTarget: async () => ({ ok: true, locationUuid: LOC, role: 'owner' }),
      targetFailureResponse: () => ({ status: 403, error: 'forbidden' }),
    }))
    const { POST } = await import('@/app/api/mailchimp/sync/route')
    const call = (body: any) => POST(new Request('http://x/api/mailchimp/sync', {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }) as any)

    // 2026-11-25 slice 6: the confirm also names the flows the owner was shown.
    const res = await call({ confirm: { count: 19, list_id: 'list1', flows: 'fp1', tags_ok: ['CLOSEDJOB', 7] } })
    expect(engine).toHaveBeenLastCalledWith(LOC, { confirm: { count: 19, listId: 'list1', flows: 'fp1', tagsOk: ['CLOSEDJOB'] } })
    const j = await res.json()
    expect(j.reason).toBe('needs_confirmation')
    expect(j.confirm).toEqual({ count: 19, list_id: 'list1', list_name: 'Bee Organized Friends', flows: 'fp1', paused_flows: [], held_tags: [] })

    await call({ confirm: { count: '19', list_id: 'list1', flows: 'fp1' } })
    expect(engine).toHaveBeenLastCalledWith(LOC, { confirm: null })
    // the old shape, without the flows, is no confirm at all
    await call({ confirm: { count: 19, list_id: 'list1' } })
    expect(engine).toHaveBeenLastCalledWith(LOC, { confirm: null })
    await call({})
    expect(engine).toHaveBeenLastCalledWith(LOC, { confirm: null })

    vi.doUnmock('@/lib/mailchimp-sync'); vi.doUnmock('@/lib/supabase-server'); vi.doUnmock('@/lib/mailchimp-oauth-guard')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE WORDS
// ═══════════════════════════════════════════════════════════════════════════
describe('the copy', () => {
  it('confirmation reads exactly as Kevin wrote it', () => {
    expect(firstSyncConfirmCopy(19, 'Bee Organized Friends'))
      .toBe('This will subscribe 19 people to Bee Organized Friends. They have not been synced before.')
    expect(firstSyncConfirmCopy(1, 'Bee Organized Friends'))
      .toBe('This will subscribe 1 person to Bee Organized Friends. They have not been synced before.')
    expect(firstSyncConfirmCopy(3, '')).toContain('to your Mailchimp audience.')
  })

  it('the not-live line', () => {
    expect(NOT_LIVE_COPY).toBe('Connected. Syncing isn’t switched on for your location yet, we’ll let you know when it is.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE CARD
// ═══════════════════════════════════════════════════════════════════════════
let container: HTMLElement
let root: ReturnType<typeof createRoot>

const READY = {
  locId: 'loc_test', mailchimpConnected: true, mailchimpAccountName: 'Bee Organized Chattanooga',
  mailchimpListId: 'list1', mailchimpListName: 'Bee Organized Friends',
}

const mountCard = async (loc: Record<string, any>) => {
  window.history.replaceState({}, '', '/settings')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<MailchimpCard settings={{ location: loc }} updateLocation={() => {}} />) })
  await act(async () => {})
}
const unmount = () => { act(() => root.unmount()); container.remove() }
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === label)
const click = async (el: Element | undefined) => {
  expect(el, 'button present').toBeTruthy()
  await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

// Routes the card's two endpoints. syncReplies is consumed in order.
function cardFetch(opts: { live?: boolean | 'fail'; syncReplies?: any[] }) {
  const replies = [...(opts.syncReplies || [])]
  return vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/mailchimp/status?')) {
      if (opts.live === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'x' }) }
      return { ok: true, status: 200, json: async () => ({ live: opts.live === true }) }
    }
    if (String(url) === '/api/mailchimp/sync') {
      const next = replies.shift()
      return { ok: true, status: 200, json: async () => next }
    }
    return { ok: true, status: 200, json: async () => ({ audiences: [] }) }
  })
}
const syncCalls = () => fetchMock.mock.calls.filter((c: any[]) => String(c[0]) === '/api/mailchimp/sync')

describe('the "not switched on yet" line', () => {
  it('shows under a connected card when sending is off', async () => {
    fetchMock = cardFetch({ live: false }); vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    expect(container.textContent).toContain(NOT_LIVE_COPY)
    unmount()
  })

  it('shows for connected-but-no-audience too (Southwest Austin today)', async () => {
    fetchMock = cardFetch({ live: false }); vi.stubGlobal('fetch', fetchMock)
    await mountCard({ ...READY, mailchimpListId: '', mailchimpListName: '' })
    expect(container.textContent).toContain(NOT_LIVE_COPY)
    unmount()
  })

  it('does not show once sending is on', async () => {
    fetchMock = cardFetch({ live: true }); vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    expect(container.textContent).not.toContain(NOT_LIVE_COPY)
    unmount()
  })

  it('does not show (and is not asked) before connecting', async () => {
    fetchMock = cardFetch({ live: false }); vi.stubGlobal('fetch', fetchMock)
    await mountCard({ locId: 'loc_test', mailchimpConnected: false })
    expect(container.textContent).not.toContain(NOT_LIVE_COPY)
    expect(fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/status'))).toHaveLength(0)
    unmount()
  })

  it('a failed status read shows nothing rather than guessing', async () => {
    fetchMock = cardFetch({ live: 'fail' }); vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    expect(container.textContent).not.toContain(NOT_LIVE_COPY)
    unmount()
  })
})

describe('the first-sync confirmation on the card', () => {
  const ASK = { ran: false, reason: 'needs_confirmation', pushed: 0, skipped: 0, failed: 0,
    confirm: { count: 19, list_id: 'list1', list_name: 'Bee Organized Friends', flows: 'fp1', paused_flows: [], held_tags: [] } }

  it('Sync now on a first sync shows the count + audience and sends nothing more', async () => {
    fetchMock = cardFetch({ live: true, syncReplies: [ASK] }); vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    await click(button('Sync now'))
    expect(container.textContent).toContain(
      'This will subscribe 19 people to Bee Organized Friends. They have not been synced before.')
    expect(button('Sync now')).toBeUndefined()
    expect(syncCalls()).toHaveLength(1)
    expect(JSON.parse(syncCalls()[0][1].body).confirm).toBeUndefined()
    unmount()
  })

  it('Cancel sends nothing', async () => {
    fetchMock = cardFetch({ live: true, syncReplies: [ASK] }); vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    await click(button('Sync now'))
    await click(button('Cancel'))
    expect(syncCalls()).toHaveLength(1)
    expect(container.textContent).not.toContain('This will subscribe')
    expect(button('Sync now')).toBeTruthy()
    unmount()
  })

  it('Yes re-sends with the confirmed count + audience, and shows the result', async () => {
    fetchMock = cardFetch({ live: true, syncReplies: [ASK, { ran: true, reason: null, complete: true, pushed: 19, already: 0, skipped: 3, failed: 0, remaining: 0, tags_held: [], confirm: null }] })
    vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    await click(button('Sync now'))
    await click(button('Yes, subscribe 19'))
    expect(syncCalls()).toHaveLength(2)
    expect(JSON.parse(syncCalls()[1][1].body).confirm).toEqual({ count: 19, list_id: 'list1', flows: 'fp1', tags_ok: [] })
    expect(container.textContent).toContain('Done: added 19 people to Bee Organized Friends.')
    unmount()
  })

  it('if the count moved, the card asks again with the new number', async () => {
    const ASK20 = { ...ASK, confirm: { ...ASK.confirm, count: 20 } }
    fetchMock = cardFetch({ live: true, syncReplies: [ASK, ASK20] }); vi.stubGlobal('fetch', fetchMock)
    await mountCard(READY)
    await click(button('Sync now'))
    await click(button('Yes, subscribe 19'))
    expect(container.textContent).toContain('This will subscribe 20 people to Bee Organized Friends.')
    expect(button('Yes, subscribe 20')).toBeTruthy()
    unmount()
  })
})
