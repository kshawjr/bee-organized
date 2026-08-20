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
  tags: [],
  paid_amount: 0,
  is_junk: false,
  created_at: new Date().toISOString(),
  // The STALE snapshot — present on every row so a test that reads it by
  // mistake produces a visibly wrong tag.
  client_status: 'StaleColumnValue',
  ...over,
})

// Standard resolver: a live location, one page of eligible leads, empty
// children, a website head-count.
function standardResolver(leads: any[], totalWebsite: number, opts: any = {}) {
  return (q: any): Resolved => {
    if (q.table === 'locations') return { data: { ...liveLocation, ...(opts.location || {}) }, error: null }
    if (q.table === 'leads' && q.head) return { data: null, error: null, count: totalWebsite }
    if (q.table === 'leads') return { data: leads, error: null }
    if (q.table === 'engagements') return { data: opts.engagements || [], error: null }
    if (q.table === 'touchpoints') return { data: opts.touchpoints || [], error: null }
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

  it('tags = project type + source + live status + the leads.tags entries', () => {
    expect(buildMemberTags({
      projectType: 'Moving', source: 'Website', clientStatus: 'New', leadTags: ['vip'],
    })).toEqual(['Moving', 'Website', 'New', 'vip'])
  })

  it('trims, drops empties, and dedupes case-insensitively (first casing wins)', () => {
    expect(buildMemberTags({
      projectType: '  Moving ', source: '', clientStatus: null,
      leadTags: ['moving', 'VIP', ' vip ', '', '   ', null, 42],
    })).toEqual(['Moving', 'VIP'])
  })

  it('a non-array leads.tags value is survived, not crashed on', () => {
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
    expect(report).toEqual({ ran: false, reason: 'sync_not_enabled', pushed: 0, skipped: 0, failed: 0, errors: [] })
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
describe('the upsert', () => {
  it('PUTs to /lists/{id}/members/{hash} with status_if_new and NO status field', async () => {
    dbResolver = standardResolver([lead()], 1)
    const report = await syncWebsiteLeadsToMailchimp(LOC)
    expect(report.pushed).toBe(1)

    const put = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === 'PUT')!
    expect(put, 'a member PUT').toBeTruthy()
    expect(String(put[0])).toBe(
      `https://us7.api.mailchimp.com/3.0/lists/list1/members/${MD5_OF_LOWERCASED_EMAIL('person@example.com')}`,
    )
    const body = JSON.parse(put[1].body)
    expect(body.email_address).toBe('person@example.com')
    expect(body.status_if_new).toBe('subscribed')
    // THE pin. A plain `status` would resurrect a Mailchimp-side unsubscribe.
    expect(Object.prototype.hasOwnProperty.call(body, 'status')).toBe(false)
    expect(body.merge_fields).toEqual({ FNAME: 'Pat', LNAME: 'Jones' })
  })

  it('tags ride the tags endpoint, each active', async () => {
    dbResolver = standardResolver([lead({ tags: ['vip'] })], 1)
    await syncWebsiteLeadsToMailchimp(LOC)
    const tagCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).endsWith('/tags'))!
    expect(tagCall, 'a tags POST').toBeTruthy()
    expect(tagCall[1].method).toBe('POST')
    const body = JSON.parse(tagCall[1].body)
    // New: created just now, no engagements, no touchpoints.
    expect(body.tags).toEqual([
      { name: 'Moving', status: 'active' },
      { name: 'Website', status: 'active' },
      { name: 'New', status: 'active' },
      { name: 'vip', status: 'active' },
    ])
  })

  it('THE STALE COLUMN: a won client is tagged Client, whatever client_status says', async () => {
    // The row's snapshot says 'StaleColumnValue'; the engagements say Closed
    // Won. The tag must say Client — the live derivation, not the column.
    dbResolver = standardResolver([lead()], 1, {
      engagements: [{ client_id: 'lead-1', stage: 'Closed Won' }],
    })
    await syncWebsiteLeadsToMailchimp(LOC)
    const body = JSON.parse(fetchMock.mock.calls.find((c: any[]) => String(c[0]).endsWith('/tags'))![1].body)
    const names = body.tags.map((t: any) => t.name)
    expect(names).toContain('Client')
    expect(names).not.toContain('StaleColumnValue')
    expect(names).not.toContain('New')
  })

  it('and the engine source never reads the snapshot column', () => {
    const src = readFileSync(join(process.cwd(), 'lib/mailchimp-sync.ts'), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/client_status/)
  })

  it('success stamps synced_at + the status MAILCHIMP returned, error null', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'unsubscribed' }),
    }))
    dbResolver = standardResolver([lead()], 1)
    await syncWebsiteLeadsToMailchimp(LOC)
    const write = dbWrites.find(w => w.table === 'leads')!
    expect(write.payload.mailchimp_synced_at).toBeTruthy()
    // They unsubscribed inside Mailchimp; status_if_new preserved that, and the
    // row records the truth rather than what we hoped.
    expect(write.payload.mailchimp_status).toBe('unsubscribed')
    expect(write.payload.mailchimp_sync_error).toBeNull()
    expect(write.eq).toEqual(['id', 'lead-1'])
  })

  it('one failure does not abort the run — the error lands, the rest push', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      if (init?.method === 'PUT' && String(url).includes(MD5_OF_LOWERCASED_EMAIL('bad@example.com'))) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ detail: 'looks fake or invalid' }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'subscribed' }) }
    })
    dbResolver = standardResolver([
      lead({ id: 'lead-bad', email: 'bad@example.com' }),
      lead({ id: 'lead-good', email: 'good@example.com' }),
    ], 2)

    const report = await syncWebsiteLeadsToMailchimp(LOC)
    expect(report.pushed).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.errors[0]).toEqual({ lead_id: 'lead-bad', error: 'looks fake or invalid' })

    // The failed row gets the error and KEEPS synced_at null — retryable.
    const badWrite = dbWrites.find(w => w.eq[1] === 'lead-bad')!
    expect(badWrite.payload.mailchimp_sync_error).toBe('looks fake or invalid')
    expect(badWrite.payload.mailchimp_synced_at).toBeUndefined()
    // The good row still landed.
    const goodWrite = dbWrites.find(w => w.eq[1] === 'lead-good')!
    expect(goodWrite.payload.mailchimp_synced_at).toBeTruthy()
  })

  it('a tags failure fails the LEAD — synced_at stays null so the retry re-PUTs', async () => {
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      if (String(url).endsWith('/tags')) {
        return { ok: false, status: 500, text: async () => JSON.stringify({ detail: 'tag store down' }) }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'subscribed' }) }
    })
    dbResolver = standardResolver([lead()], 1)
    const report = await syncWebsiteLeadsToMailchimp(LOC)
    expect(report.pushed).toBe(0)
    expect(report.failed).toBe(1)
    const write = dbWrites.find(w => w.table === 'leads')!
    expect(write.payload.mailchimp_synced_at).toBeUndefined()
    expect(write.payload.mailchimp_sync_error).toMatch(/tags_failed/)
  })

  it('skipped = website leads the eligibility clauses excluded', async () => {
    // 5 website leads exist for the location; 1 is eligible.
    dbResolver = standardResolver([lead()], 5)
    const report = await syncWebsiteLeadsToMailchimp(LOC)
    expect(report.pushed).toBe(1)
    expect(report.skipped).toBe(4)
  })

  it('requests are sequential — the second PUT starts after the first resolves', async () => {
    let inFlight = 0, maxInFlight = 0
    fetchMock.mockImplementation(async (url: string, init: any = {}) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'subscribed' }) }
    })
    dbResolver = standardResolver([
      lead({ id: 'l1', email: 'a@example.com' }),
      lead({ id: 'l2', email: 'b@example.com' }),
      lead({ id: 'l3', email: 'c@example.com' }),
    ], 3)
    await syncWebsiteLeadsToMailchimp(LOC)
    expect(maxInFlight).toBe(1)
  })
})

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

  it('POSTs the trigger and reports the server’s numbers verbatim', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ ran: true, reason: null, pushed: 12, skipped: 7, failed: 2 }),
    }))
    await mountCard(READY)
    await act(async () => { syncButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    const call = fetchMock.mock.calls.find((c: any[]) => String(c[0]) === '/api/mailchimp/sync')!
    expect(call, 'the trigger POST').toBeTruthy()
    expect(call[1].method).toBe('POST')

    expect(container.textContent).toContain('Pushed 12 to Mailchimp')
    expect(container.textContent).toContain('7 skipped')
    expect(container.textContent).toContain('2 failed')
    expect(container.textContent).toMatch(/retried on the next sync/i)
    unmountCard()
  })

  it('a gated-off location hears it plainly: nothing was sent', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ ran: false, reason: 'sync_not_enabled', pushed: 0, skipped: 0, failed: 0 }),
    }))
    await mountCard(READY)
    await act(async () => { syncButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.textContent).toMatch(/Nothing was sent/i)
    expect(container.textContent).toMatch(/switched on for your location yet/i)
    unmountCard()
  })
})
