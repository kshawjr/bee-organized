// @vitest-environment happy-dom
//
// Issue 246 step 3A — push eligible website leads to the location's audience,
// manual trigger only. What this file exists to catch, in descending order of
// how much it would hurt:
//
//   1. RESURRECTING A MAILCHIMP-SIDE UNSUBSCRIBE. The upsert must send
//      status_if_new and NEVER a plain `status` — a `status` field on the PUT
//      would flip someone who unsubscribed inside Mailchimp back to
//      subscribed, which is the one thing a marketing sync must never do.
//      Pinned on the actual request body, not on source text.
//
//   2. THE GATE NOT GATING. mailchimp_sync_live=false must mean ZERO requests
//      to Mailchimp — not a dry run, not a partial run. Pinned by counting
//      fetch calls, which is the only count that matters.
//
//   3. A STALE STATUS TAG. leads.client_status is a point-in-time snapshot;
//      the tag must come from deriveClientStatus(), the live derivation. A
//      lead whose column says one thing and whose engagements say another
//      must be tagged with what the engagements say.
//
//   4. ONE BAD EMAIL KILLING THE RUN. Per-lead failure writes the error and
//      moves on; the rest of the batch still lands.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

// ── The chainable Supabase mock ───────────────────────────────
// One resolver receives every finished query (table + recorded calls) and
// returns { data, error, count }. The builder is thenable so `await q` works.
type Resolved = { data?: any; error?: any; count?: number }
let dbResolver: (q: any) => Resolved
let dbWrites: Array<{ table: string; payload: any; eq: any[] }>

function makeBuilder(table: string) {
  const q: any = { table, calls: [], op: 'select', head: false }
  const b: any = {}
  for (const m of ['select', 'eq', 'neq', 'not', 'is', 'in', 'order', 'range']) {
    b[m] = (...args: any[]) => { q.calls.push([m, ...args]); if (m === 'select' && args[1]?.head) q.head = true; return b }
  }
  b.update = (payload: any) => {
    q.op = 'update'; q.payload = payload
    return {
      eq: (...eqArgs: any[]) => {
        dbWrites.push({ table, payload, eq: eqArgs })
        return Promise.resolve({ data: null, error: null })
      },
    }
  }
  b.maybeSingle = () => Promise.resolve(dbResolver(q))
  b.then = (ok: any, err: any) => Promise.resolve(dbResolver(q)).then(ok, err)
  return b
}

vi.mock('./supabase-service', () => ({
  supabaseService: { from: (table: string) => makeBuilder(table) },
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (table: string) => makeBuilder(table) },
}))

import {
  syncWebsiteLeadsToMailchimp,
  buildMemberTags,
  MD5_OF_LOWERCASED_EMAIL,
} from '@/lib/mailchimp-sync'
import { MailchimpCard } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = 'aaaaaaaa-1111-4222-8333-444455556666'

const liveLocation = {
  id: LOC,
  mailchimp_connected: true,
  mailchimp_access_token: 'tok',
  mailchimp_server_prefix: 'us7',
  mailchimp_list_id: 'list1',
  mailchimp_sync_live: true,
}

const lead = (over: any = {}) => ({
  id: over.id || 'lead-1',
  email: 'person@example.com',
  first_name: 'Pat',
  last_name: 'Jones',
  source: 'Website',
  project_type: 'Moving',
  // The write-orphan COLUMN, poisoned on every row: real tags live in the
  // lead_tags junction, and any test asserting an exact tag list proves the
  // column was never read — this string appearing anywhere is the failure.
  tags: ['ColumnDecoyTag'],
  paid_amount: 0,
  is_junk: false,
  created_at: new Date().toISOString(),
  // A website lead is an ENQUIRY (Inbox rule): import_source 'manual'.
  import_source: 'manual',
  // The STALE snapshot — present on every row so a test that reads it by
  // mistake produces a visibly wrong tag.
  client_status: 'StaleColumnValue',
  ...over,
})

// Standard resolver: a live location, one page of eligible leads, empty
// children, a website head-count. opts.leadTags = lead_tags junction rows
// ({ lead_id, tag_lookup_id }); opts.lookups = the tag definition rows the
// batched .in('id', …) resolution reads ({ id, label }).
function standardResolver(leads: any[], totalWebsite: number, opts: any = {}) {
  return (q: any): Resolved => {
    if (q.table === 'locations') return { data: { ...liveLocation, ...(opts.location || {}) }, error: null }
    // The "synced before?" count behind the first-sync confirmation. These
    // push tests are about the push, so they default to a location that has
    // synced before (no confirm needed); the confirmation has its own suite,
    // lib/beta-mailchimp-first-sync-confirm.test.tsx.
    if (q.table === 'leads' && q.head && q.calls.some((c: any[]) => c[0] === 'not' && c[1] === 'mailchimp_synced_at')) {
      return { data: null, error: null, count: opts.syncedBefore ?? 1 }
    }
    if (q.table === 'leads' && q.head) return { data: null, error: null, count: totalWebsite }
    if (q.table === 'leads') return { data: leads, error: null }
    if (q.table === 'engagements') return { data: opts.engagements || [], error: null }
    if (q.table === 'touchpoints') return { data: opts.touchpoints || [], error: null }
    if (q.table === 'lead_tags') return { data: opts.leadTags || [], error: null }
    if (q.table === 'lookups') return { data: opts.lookups || [], error: null }
    return { data: [], error: null }
  }
}

let fetchMock: any

beforeEach(() => {
  dbWrites = []
  dbResolver = standardResolver([], 0)
  fetchMock = vi.fn(async (url: string, init: any = {}) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: 'subscribed' }),
    json: async () => ({ status: 'subscribed' }),
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1 · TAGS + HASH (pure)
// ═══════════════════════════════════════════════════════════════════════════
describe('the subscriber hash and the tags', () => {
  it('MD5s the LOWERCASED, trimmed email — the Mailchimp docs vector', () => {
    // The canonical example from Mailchimp's own docs. Casing and padding must
    // not change the hash, or an existing member gets a duplicate identity.
    expect(MD5_OF_LOWERCASED_EMAIL('urist.mcvankab@freddiesjokes.com'))
      .toBe('62eeb292278cc15f5817cb78f7790b08')
    expect(MD5_OF_LOWERCASED_EMAIL('  URIST.McVankab@FreddiesJokes.com  '))
      .toBe('62eeb292278cc15f5817cb78f7790b08')
  })

  it('tags = project type + source + live status + the junction tag labels', () => {
    expect(buildMemberTags({
      projectType: 'Moving', source: 'Website', clientStatus: 'New', leadTags: ['VIP'],
    })).toEqual(['Moving', 'Website', 'New', 'VIP'])
  })

  it('trims, drops empties, and dedupes case-insensitively (first casing wins)', () => {
    expect(buildMemberTags({
      projectType: '  Moving ', source: '', clientStatus: null,
      leadTags: ['moving', 'VIP', ' vip ', '', '   ', null, 42],
    })).toEqual(['Moving', 'VIP'])
  })

  it('a non-array leadTags value is survived, not crashed on', () => {
    expect(buildMemberTags({ projectType: 'Organizing', leadTags: 'oops-a-string' }))
      .toEqual(['Organizing'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE GATE
// ═══════════════════════════════════════════════════════════════════════════
describe('fail closed: a gated location sends NOTHING', () => {
  it('sync_live=false → zero report with a reason, and zero fetches', async () => {
    dbResolver = standardResolver([lead()], 1, { location: { mailchimp_sync_live: false } })
    const report = await syncWebsiteLeadsToMailchimp(LOC)
    // 2026-11-25 slice 6: the report carries more zero fields; the rule is the same.
    expect(report).toMatchObject({ ran: false, reason: 'sync_not_enabled', pushed: 0, skipped: 0, failed: 0, alreadyThere: 0, remaining: 0, errors: [] })
    // The count that matters: not one request left the building.
    expect(fetchMock.mock.calls).toHaveLength(0)
    expect(dbWrites).toHaveLength(0)
  })

  it('not connected, and no audience picked, fail the same way', async () => {
    dbResolver = standardResolver([], 0, { location: { mailchimp_connected: false } })
    expect((await syncWebsiteLeadsToMailchimp(LOC)).reason).toBe('not_connected')

    dbResolver = standardResolver([], 0, { location: { mailchimp_list_id: null } })
    expect((await syncWebsiteLeadsToMailchimp(LOC)).reason).toBe('no_audience')

    expect(fetchMock.mock.calls).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE PUSH
// ═══════════════════════════════════════════════════════════════════════════
// 2026-11-25, FL-75 slice 6 RETIRED this block ("the upsert"): it pinned the
// old engine — one PUT per website lead with status_if_new. Slice 6 replaced
// it with Mailchimp's batch add (update_existing:false) for the people ticked
// on "Who goes to Mailchimp". What these tests protected is pinned again,
// against the new engine, in lib/mailchimp-first-push.test.ts:
//   • never re-subscribing an unsubscribe → update_existing:false on every
//     batch, no PUT/PATCH ever, members already in Mailchimp never sent
//   • the live status tag, not the stale column; junction tag labels, never
//     the leads.tags column; one lead_tags + one lookups read per run
//   • one refused address does not stop the rest; a tag failure is never "done"

// ═══════════════════════════════════════════════════════════════════════════
// 4 · THE TRIGGER IS THE ONLY TRIGGER
// ═══════════════════════════════════════════════════════════════════════════
describe('manual trigger only, one guard, no second push path', () => {
  it('the sync route reuses resolveMailchimpTarget — no second copy of the rules', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/mailchimp/sync/route.ts'), 'utf8')
    expect(src).toMatch(/resolveMailchimpTarget/)
    expect(src).toMatch(/targetFailureResponse/)
    // No hand-rolled role checks in the route.
    expect(src).not.toMatch(/role === '/)
    // POST only — a GET that pushes marketing data is a prefetch incident.
    expect(src).toMatch(/export async function POST/)
    expect(src).not.toMatch(/export async function GET/)
  })

  it('no cron entry points at the sync', () => {
    const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')
    expect(vercel).not.toMatch(/mailchimp/i)
  })

  it('the engine is imported by the sync route and nothing else', () => {
    // The gate lives in the engine; a second importer would be a push path
    // this file has never audited. execSync grep would be fragile — walk the
    // two roots the app builds from instead.
    const { execSync } = require('node:child_process')
    const hits = execSync(
      `grep -rl "mailchimp-sync" app lib components --include="*.ts" --include="*.tsx" --include="*.jsx" || true`,
      { cwd: process.cwd(), encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean).filter((f: string) => !f.includes('.test.'))
    expect(hits.sort()).toEqual(['app/api/mailchimp/sync/route.ts', 'lib/mailchimp-sync.ts'].sort())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE BUTTON
// ═══════════════════════════════════════════════════════════════════════════
let container: HTMLElement
let root: ReturnType<typeof createRoot>

const settingsFor = (loc: Record<string, any>) => ({
  location: {
    locId: 'loc_test',
    mailchimpConnected: false,
    mailchimpAccountName: '',
    mailchimpListId: '',
    mailchimpListName: '',
    ...loc,
  },
})

const READY = {
  mailchimpConnected: true,
  mailchimpAccountName: 'Bee Organized KC',
  mailchimpListId: 'a1',
  mailchimpListName: 'Bee clients',
}

const mountCard = async (loc: Record<string, any>) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<MailchimpCard settings={settingsFor(loc)} updateLocation={() => {}} />)
  })
  await act(async () => {})
}

const unmountCard = () => {
  act(() => root.unmount())
  container.remove()
}

const syncButton = () =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Sync now')

describe('the Sync now button', () => {
  it('exists ONLY in the ready state — connected + audience picked', async () => {
    window.history.replaceState({}, '', '/settings')
    await mountCard({})
    expect(syncButton()).toBeUndefined()
    unmountCard()

    await mountCard({ mailchimpConnected: true, mailchimpAccountName: 'Acme' })
    expect(syncButton()).toBeUndefined()
    unmountCard()

    await mountCard(READY)
    expect(syncButton(), 'ready state has the button').toBeTruthy()
    unmountCard()
  })

  // FL-75 slice 6 (2026-11-25): Sync now lives on the Lovable connection
  // screen, which first reads the overview (read only); a location that has
  // synced before shows Sync now. The trigger and the numbers are unchanged.
  const RUNNING = { live: true, synced: true, reviewed: true, audience_count: 10, last_run: null, flows: { ok: true, mustPause: [], paused: [] } }
  const route = (syncAnswer: any, overview: any = RUNNING) => async (url: string) => ({
    ok: true, status: 200,
    json: async () => (String(url).startsWith('/api/mailchimp/overview?') ? overview : syncAnswer),
  })
  it('POSTs the trigger and reports the server’s numbers verbatim', async () => {
    fetchMock.mockImplementation(route({ ran: true, reason: null, complete: true, pushed: 12, already: 3, skipped: 7, failed: 2, remaining: 0, tags_held: [] }))
    await mountCard(READY)
    await act(async () => { syncButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const call = fetchMock.mock.calls.find((c: any[]) => String(c[0]) === '/api/mailchimp/sync')!
    expect(call, 'the trigger POST').toBeTruthy()
    expect(call[1].method).toBe('POST')

    // 2026-11-25 slice 6 wording: what was added, what was already there and
    // left as it was, what Mailchimp refused — the server's numbers verbatim.
    expect(container.textContent).toContain('Done: added 12 people to Bee clients.')
    expect(container.textContent).toContain('3 people were already there and left exactly as they were')
    expect(container.textContent).toContain('2 people couldn’t be added')
    unmountCard()
  })

  it('a gated-off location hears it plainly: nothing was sent', async () => {
    // 2026-11-25: the screen already knows the switch is off (the overview),
    // so Sync now is off and says why; the server would refuse it anyway.
    fetchMock.mockImplementation(route({ ran: false, reason: 'sync_not_enabled', pushed: 0, skipped: 0, failed: 0 }, { ...RUNNING, live: false }))
    await mountCard(READY)
    expect(syncButton()!.disabled).toBe(true)
    expect(container.textContent).toMatch(/switched on for your location yet/i)
    expect(fetchMock.mock.calls.filter((c: any[]) => String(c[0]) === '/api/mailchimp/sync')).toHaveLength(0)
    unmountCard()
  })
})
