// @vitest-environment happy-dom
//
// The Slack and Jobber connection screens, to Kevin's Lovable design
// (2026-11-25). LOOK ONLY: every action is the one the old cards made.
//
//   1 · the rules — which state a screen is in (lib/connection-health.ts)
//   2 · the reads — existing tables only, nothing written, no new column
//   3 · the door  — GET connection-health: who gets an answer
//   4 · Slack     — Not connected / Connected / Channel broken
//   5 · Jobber    — Not brought in / Bringing in / Stuck / Running / Reconnect
//   6 · both      — Disconnect is a quiet text link at the foot, under a rule
//   7 · actions   — connect, disconnect, test message, invite link, import
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const db = vi.hoisted(() => ({ tables: {} as Record<string, any[]>, log: [] as any[] }))
const who = vi.hoisted(() => ({ user: null as any }))
vi.mock('@/lib/auth', () => ({ requireAuth: async () => ({ id: who.user?.id }), getHubUser: async () => who.user }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => fakeFrom(t) } }))

import * as BeeHub from '@/components/BeeHub'
import { slackChannelBroken, jobberScreenState, importStoppedPartWay, whenWords, readSlackLastPost, readJobberHealth } from '@/lib/connection-health'
import { GET } from '@/app/api/locations/[id]/connection-health/route'

const SlackCard = (BeeHub as any).SlackCard as React.ComponentType<any>
const JobberCard = (BeeHub as any).JobberCard as React.ComponentType<any>

// ── a stand-in database that only knows how to READ ───────────────────────
// Every filter is recorded, so a test can say exactly what was asked for. A
// write of any kind throws: these screens' reads may never write.
function fakeFrom(table: string) {
  const q: any = { table, select: '', eq: [] as any[], in: [] as any[], not: [] as any[], order: null as any, limit: null as any }
  db.log.push(q)
  const rows = () => {
    let r = [...(db.tables[table] || [])]
    for (const [c, v] of q.eq) r = r.filter(x => x[c] === v)
    for (const [c, vs] of q.in) r = r.filter(x => vs.includes(x[c]))
    for (const [c, op, v] of q.not) if (op === 'like') r = r.filter(x => !String(x[c] ?? '').startsWith(String(v).replace(/%$/, '')))
    if (q.order) r.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? 1 : -1) * (q.order[1].ascending ? -1 : 1))
    return r
  }
  const api: any = {
    select: (s: string) => { q.select = s; return api },
    eq: (c: string, v: any) => { q.eq.push([c, v]); return api },
    in: (c: string, v: any[]) => { q.in.push([c, v]); return api },
    not: (c: string, op: string, v: any) => { q.not.push([c, op, v]); return api },
    order: (c: string, o: any) => { q.order = [c, o]; return api },
    limit: (n: number) => { q.limit = n; return api },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
  }
  for (const w of ['insert', 'update', 'upsert', 'delete', 'rpc']) api[w] = () => { throw new Error(`the connection screens must never ${w}`) }
  return api
}

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

// ═══════════════════════════════════════════════════════════════════════
// 1 · THE RULES
// ═══════════════════════════════════════════════════════════════════════
describe('1 · which state a screen is in', () => {
  it('Slack is "channel broken" only when the LAST post failed with channel_not_found', () => {
    expect(slackChannelBroken({ status: 'failed', error: 'channel_not_found', at: '2026-11-24T03:35:21Z' })).toBe(true)
    expect(slackChannelBroken({ status: 'accepted', error: null, at: '2026-11-24T03:35:21Z' })).toBe(false)
    // Another failure is not this one, and "not known" is never broken.
    expect(slackChannelBroken({ status: 'failed', error: 'slack_http_429', at: '2026-11-24T03:35:21Z' })).toBe(false)
    expect(slackChannelBroken({ status: 'failed', error: 'not_in_channel', at: '2026-11-24T03:35:21Z' })).toBe(false)
    expect(slackChannelBroken(null)).toBe(false)
    expect(slackChannelBroken(undefined)).toBe(false)
  })

  it('Jobber: one state from the connection, the import stamp, the live import and the last import', () => {
    const s = (a: any) => jobberScreenState({ status: 'connected', importPhase: 'idle', hasImported: false, lastJob: null, ...a })
    expect(s({ status: 'disconnected' })).toBe('off')
    expect(s({ status: 'reconnect_required', hasImported: true })).toBe('reconnect')
    expect(s({})).toBe('first')
    expect(s({ importPhase: 'running' })).toBe('importing')
    expect(s({ importPhase: 'parked' })).toBe('importing')
    expect(s({ importPhase: 'error' })).toBe('stuck')
    expect(s({ lastJob: { status: 'failed', processed: 12, total: 28, at: null } })).toBe('stuck')
    expect(s({ hasImported: true })).toBe('running')
    expect(s({ importPhase: 'complete' })).toBe('running')
    // Reconnect beats everything; a running import beats a stale failure;
    // an import that finished since beats an older stopped one.
    expect(s({ status: 'reconnect_required', importPhase: 'running' })).toBe('reconnect')
    expect(s({ importPhase: 'running', lastJob: { status: 'failed', processed: 12, total: 28, at: null } })).toBe('importing')
    expect(s({ hasImported: true, lastJob: { status: 'failed', processed: 12, total: 28, at: null } })).toBe('running')
    // Not known is never "stuck".
    expect(s({ lastJob: undefined })).toBe('first')
  })

  it('"stopped part way" needs some clients in and not all of them', () => {
    expect(importStoppedPartWay({ status: 'failed', processed: 12, total: 28, at: null })).toEqual({ done: 12, total: 28 })
    expect(importStoppedPartWay({ status: 'failed', processed: 0, total: 28, at: null })).toBeNull()      // nothing came across
    expect(importStoppedPartWay({ status: 'failed', processed: 28, total: 28, at: null })).toBeNull()
    expect(importStoppedPartWay({ status: 'failed', processed: 5, total: 0, at: null })).toBeNull()
    expect(importStoppedPartWay({ status: 'completed', processed: 12, total: 28, at: null })).toBeNull()
    expect(importStoppedPartWay({ status: 'running', processed: 12, total: 28, at: null })).toBeNull()
    expect(importStoppedPartWay(null)).toBeNull()
  })

  it('times read as Today / Yesterday / a date', () => {
    const now = new Date(2026, 10, 25, 15, 0)
    expect(whenWords(new Date(2026, 10, 25, 10, 18).toISOString(), now)).toMatch(/^Today, 10:18/)
    expect(whenWords(new Date(2026, 10, 24, 23, 59).toISOString(), now)).toMatch(/^Yesterday, 11:59/)
    expect(whenWords(new Date(2026, 10, 19, 9, 30).toISOString(), now)).toMatch(/^Nov 19, 9:30/)
    expect(whenWords(new Date(2025, 10, 19, 9, 30).toISOString(), now)).toMatch(/^Nov 19, 2025, 9:30/)
    expect(whenWords(null, now)).toBe('')
    expect(whenWords('not a date', now)).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2 · THE READS
// ═══════════════════════════════════════════════════════════════════════
describe('2 · read from what Bee Hub already stores', () => {
  beforeEach(() => { db.tables = {}; db.log = [] })

  it('Slack: the newest lead alert that was actually tried — a muted row is not a post', async () => {
    db.tables.notification_log = [
      { location_id: LOC, channel: 'slack', send_status: 'accepted', error: null, created_at: '2026-11-20T10:00:00Z' },
      { location_id: LOC, channel: 'slack', send_status: 'failed', error: 'channel_not_found', created_at: '2026-11-24T03:35:21Z' },
      { location_id: LOC, channel: 'slack', send_status: 'muted', error: 'muted', created_at: '2026-11-25T01:00:00Z' },
      { location_id: LOC, channel: 'email', send_status: 'accepted', error: null, created_at: '2026-11-25T02:00:00Z' },
      { location_id: OTHER, channel: 'slack', send_status: 'accepted', error: null, created_at: '2026-11-25T03:00:00Z' },
    ]
    expect(await readSlackLastPost({ from: fakeFrom }, LOC)).toEqual({ status: 'failed', error: 'channel_not_found', at: '2026-11-24T03:35:21Z' })
    const q = db.log[0]
    expect(q.table).toBe('notification_log')
    expect(q.eq).toEqual([['location_id', LOC], ['channel', 'slack']])
    expect(q.in).toEqual([['send_status', ['accepted', 'failed']]])
    expect(q.order).toEqual(['created_at', { ascending: false }])
    expect(q.limit).toBe(1)
    // No post at all → not known.
    expect(await readSlackLastPost({ from: fakeFrom }, OTHER.replace('b', 'c'))).toBeNull()
  })

  it('Jobber: when Jobber last sent something, how the last import ended, how many it brought in', async () => {
    db.tables.sync_log = [
      { location_id: 'loc_katy', direction: 'inbound', message: 'topic=JOB_UPDATE item=1', created_at: '2026-11-25T02:40:36Z' },
      { location_id: 'loc_katy', direction: 'outbound', message: 'pushed', created_at: '2026-11-25T09:00:00Z' },
      // The one inbound row the IMPORT writes: Jobber did not send this.
      { location_id: 'loc_katy', direction: 'inbound', message: '[job-status] topic=JOB_STATUS_UNMAPPED …', created_at: '2026-11-25T08:00:00Z' },
      { location_id: 'loc_other', direction: 'inbound', message: 'topic=JOB_UPDATE item=2', created_at: '2026-11-25T10:00:00Z' },
    ]
    db.tables.import_jobs = [
      { location_id: 'loc_katy', type: 'jobber_clients', status: 'completed', processed_records: 139, total_records: 139, started_at: '2026-08-19T19:46:39Z', completed_at: '2026-08-19T19:50:00Z', phase: 'done' },
      { location_id: 'loc_katy', type: 'jobber_clients', status: 'failed', processed_records: 12, total_records: 140, started_at: '2026-10-01T00:00:00Z', completed_at: null, phase: 'parked at 12/140 — debug next session' },
      { location_id: 'loc_katy', type: 'something_else', status: 'completed', processed_records: 999, total_records: 999, started_at: '2026-11-01T00:00:00Z', completed_at: null },
    ]
    const h = await readJobberHealth({ from: fakeFrom }, 'loc_katy')
    expect(h).toEqual({
      lastInboundAt: '2026-11-25T02:40:36Z',
      lastJob: { status: 'failed', processed: 12, total: 140, at: '2026-10-01T00:00:00Z' },
      broughtIn: 139,
    })
    // The import's `phase` holds notes written for support. It is never asked for.
    for (const q of db.log) expect(q.select, q.table).not.toMatch(/phase|error|token/)
    expect(db.log.map(q => q.table).sort()).toEqual(['import_jobs', 'import_jobs', 'sync_log'])
    // Nothing known → every answer is "not known", never a guess.
    expect(await readJobberHealth({ from: fakeFrom }, 'loc_new')).toEqual({ lastInboundAt: null, lastJob: null, broughtIn: null })
  })

  it('nothing in the reads or the door can write, and no column was added', () => {
    const strip = (f: string) => readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    for (const f of ['lib/connection-health.ts', 'app/api/locations/[id]/connection-health/route.ts']) {
      const code = strip(f)
      expect(code, f).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
      expect(code, f).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/)
      expect(code, f).not.toMatch(/slack_bot_token|access_token|refresh_token/)
      expect(code, f).not.toMatch(/slack\.com|getjobber|jobberQuery|postToSlack/)
    }
    // Every column these reads name was already in the database snapshot.
    const snap = readFileSync('lib/db-columns.snapshot.txt', 'utf8')
    const cols = (t: string) => (snap.split('\n').find(l => l.startsWith(t + ':')) || '').slice(t.length + 1).split(',')
    for (const c of ['location_id', 'channel', 'send_status', 'error', 'created_at']) expect(cols('notification_log'), c).toContain(c)
    for (const c of ['location_id', 'direction', 'message', 'created_at']) expect(cols('sync_log'), c).toContain(c)
    for (const c of ['location_id', 'type', 'status', 'processed_records', 'total_records', 'started_at', 'completed_at']) expect(cols('import_jobs'), c).toContain(c)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3 · THE DOOR
// ═══════════════════════════════════════════════════════════════════════
describe('3 · GET /api/locations/[id]/connection-health', () => {
  beforeEach(() => {
    db.log = []
    db.tables = {
      locations: [{ id: LOC, location_id: 'loc_katy' }, { id: OTHER, location_id: 'loc_other' }],
      notification_log: [{ location_id: LOC, channel: 'slack', send_status: 'failed', error: 'channel_not_found', created_at: '2026-11-24T03:35:21Z' }],
      sync_log: [{ location_id: 'loc_katy', direction: 'inbound', message: 'topic=JOB_UPDATE item=1', created_at: '2026-11-25T02:40:36Z' }],
      import_jobs: [{ location_id: 'loc_katy', type: 'jobber_clients', status: 'completed', processed_records: 139, total_records: 139, started_at: '2026-08-19T19:46:39Z', completed_at: '2026-08-19T19:50:00Z' }],
    }
  })
  const ask = async (id: string) => { const r = await GET({} as any, { params: { id } }); return { status: r.status, body: await r.json() } }

  it('the location\'s own owner and manager, and head office, get the answer', async () => {
    for (const user of [{ id: 'u1', role: 'owner', location_id: LOC }, { id: 'u2', role: 'manager', location_id: LOC }, { id: 'u3', role: 'admin', location_id: null }, { id: 'u4', role: 'super_admin', location_id: null }]) {
      who.user = user
      const r = await ask(LOC)
      expect(r.status, user.role).toBe(200)
      expect(r.body, user.role).toEqual({
        slack: { lastPost: { status: 'failed', error: 'channel_not_found', at: '2026-11-24T03:35:21Z' } },
        jobber: { lastInboundAt: '2026-11-25T02:40:36Z', lastJob: { status: 'completed', processed: 139, total: 139, at: '2026-08-19T19:50:00Z' }, broughtIn: 139 },
      })
    }
  })

  it('another location\'s owner gets exactly what a location that does not exist gets, and nothing is read', async () => {
    who.user = { id: 'u9', role: 'owner', location_id: OTHER }
    const theirs = await ask(LOC)
    const missing = await ask('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const junk = await ask('not-an-id')
    expect(theirs).toEqual({ status: 404, body: { error: 'not_found' } })
    expect(missing).toEqual(theirs)
    expect(junk).toEqual(theirs)
    expect(db.log).toEqual([])
    // Head office asking for one that is not there: the same answer.
    who.user = { id: 'u4', role: 'super_admin', location_id: null }
    expect(await ask('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toEqual(theirs)
  })

  it('no profile → refused, nothing read', async () => {
    who.user = null
    expect((await ask(LOC)).status).toBe(403)
    expect(db.log).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// the page harness for 4–7
// ═══════════════════════════════════════════════════════════════════════
let host: HTMLElement, root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[]
let answers: Record<string, (init: any) => any>
let href: string
const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

beforeEach(() => {
  calls = []; href = ''
  answers = {}
  Object.defineProperty(window.location, 'href', { configurable: true, get: () => href, set: (v: string) => { href = v } })
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
    const key = Object.keys(answers).find(k => u.includes(k))
    return key ? answers[key](init) : json({ error: 'unmocked' }, 404)
  }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }); await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const show = async (ui: React.ReactElement) => { await act(async () => { root.render(ui) }); await flush() }
const btn = (t: string) => Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === t) as HTMLButtonElement | undefined
const tap = async (t: string) => { await act(async () => { btn(t)!.click() }); await flush() }
const chip = () => host.querySelector('[data-conn-chip]') as HTMLElement
const words = () => (host.querySelector('[data-conn-body]')?.textContent || '')
const posts = () => calls.filter(c => c.method === 'POST')
const areas = () => Array.from(host.querySelectorAll('[data-conn-area] > h2')).map(h => h.textContent)

const NEW_SCOPES = 'chat:write,chat:write.public,channels:read,channels:manage,incoming-webhook,users:read,users:read.email'
const slack = (over: Record<string, any> = {}) => (
  <SlackCard updateLocation={vi.fn()} settings={{ location: { locId: LOC, name: 'Katy', slackConnected: true, slackTeamName: 'Bee Organized Katy', slackChannelName: 'leads', slackScopes: NEW_SCOPES, slackInviteUrl: 'https://join.slack.com/t/katy/shared_invite/abc', ...over } }} />
)
const jobber = (over: Record<string, any> = {}) => (
  <JobberCard updateLocation={vi.fn()} settings={{ location: { locId: LOC, name: 'Katy', jobberStatus: 'connected', jobberAccountName: 'Bee Organized Katy', jobberInitialImportCompletedAt: null, ...over } }} />
)
const health = (over: any = {}) => () => json({
  slack: { lastPost: null, ...(over.slack || {}) },
  jobber: { lastInboundAt: null, lastJob: null, broughtIn: null, ...(over.jobber || {}) },
})

// ═══════════════════════════════════════════════════════════════════════
// 4 · SLACK
// ═══════════════════════════════════════════════════════════════════════
describe('4 · the Slack screen', () => {
  it('NOT CONNECTED: says so, offers Add to Slack, and asks the database nothing', async () => {
    await show(slack({ slackConnected: false, slackTeamName: '', slackChannelName: '' }))
    expect(host.querySelector('[data-slack-screen]')!.getAttribute('data-slack-screen')).toBe('off')
    expect(chip().textContent).toBe('Not connected')
    expect(chip().getAttribute('data-conn-tone')).toBe('quiet')
    expect(host.querySelector('h1')!.textContent).toBe('Slack')
    expect(host.querySelector('[data-conn-place]')!.textContent).toBe('Katy')
    expect(areas()).toEqual(['Your workspace'])
    expect(btn('Add to Slack')!.getAttribute('data-sbtn')).toBe('primary')
    expect(btn('Send test message')).toBeUndefined()
    expect(host.querySelector('[data-conn-footer]')).toBeNull()      // nothing to disconnect
    expect(calls).toEqual([])
  })

  it('CONNECTED: the channel, the workspace, when the last alert arrived, and the three areas', async () => {
    answers['/connection-health'] = health({ slack: { lastPost: { status: 'accepted', error: null, at: new Date().toISOString() } } })
    answers['/slack-auto-channels'] = () => json({ setUp: true, on: false, since: null, capped: false, cap: 15, connected: true, reconnected: true, canSet: true })
    await show(slack())
    expect(host.querySelector('[data-slack-screen]')!.getAttribute('data-slack-screen')).toBe('connected')
    expect(chip().textContent).toBe('Connected')
    expect(chip().getAttribute('data-conn-tone')).toBe('ok')
    expect(host.querySelector('[data-conn-account]')!.textContent).toBe('Workspace · Bee Organized Katy')
    expect(areas()).toEqual(['Lead alerts', 'Job channels', 'Invite your team'])
    expect(host.querySelector('[data-slack-channel]')!.textContent).toBe('#leads')
    expect(host.querySelector('[data-slack-last-post]')!.textContent).toMatch(/^Last lead alert posted Today, /)
    expect(host.querySelector('[data-slack-broken]')).toBeNull()
    expect(btn('Send test message')!.getAttribute('data-sbtn')).toBe('outline')
    expect(host.querySelector('[data-slack-auto-switch]')).toBeTruthy()
    expect(calls.map(c => c.url).sort()).toEqual([`/api/locations/${LOC}/connection-health`, `/api/locations/${LOC}/slack-auto-channels`])
    expect(posts()).toEqual([])                                       // opening the screen changes nothing
  })

  it('CHANNEL BROKEN: the last alert failed with channel_not_found → warns, names the channel, says what to do', async () => {
    answers['/connection-health'] = health({ slack: { lastPost: { status: 'failed', error: 'channel_not_found', at: '2026-11-24T03:35:21Z' } } })
    await show(slack())
    expect(host.querySelector('[data-slack-screen]')!.getAttribute('data-slack-screen')).toBe('broken')
    expect(chip().textContent).toBe('Channel unavailable')
    expect(chip().getAttribute('data-conn-tone')).toBe('warn')
    const box = host.querySelector('[data-slack-broken]')!
    expect(box.textContent).toContain('Bee Hub can’t post to #leads.')
    expect(box.textContent).toMatch(/The last lead alert \(Nov 2[34], .+\) didn’t arrive/)
    expect(box.textContent).toContain('New leads still reach you by email.')
    expect(box.textContent).toContain('type /invite and add the Bee Hub app')
    expect(box.textContent).toContain('Disconnect, then Add to Slack again and pick a public channel.')
    // Not the design's sample words: nobody knows the channel "no longer exists".
    expect(host.textContent).not.toMatch(/no longer exists/)
    expect(host.querySelector('[data-slack-last-post]')).toBeNull()
    // The way to check a fix is the primary button here.
    expect(btn('Send test message')!.getAttribute('data-sbtn')).toBe('primary')
  })

  it('not broken when the failure was something else, when nothing is known, or when the read fails', async () => {
    for (const a of [
      health({ slack: { lastPost: { status: 'failed', error: 'slack_http_429', at: '2026-11-24T03:35:21Z' } } }),
      health({ slack: { lastPost: null } }),
      () => json({ error: 'Server error' }, 500),
      () => { throw new Error('offline') },
    ]) {
      act(() => root.unmount()); root = createRoot(host)
      answers['/connection-health'] = a
      await show(slack())
      expect(chip().textContent).toBe('Connected')
      expect(host.querySelector('[data-slack-broken]')).toBeNull()
    }
  })

  it('a test message that arrives clears "channel broken" there and then; one that fails leaves it', async () => {
    answers['/connection-health'] = health({ slack: { lastPost: { status: 'failed', error: 'channel_not_found', at: '2026-11-24T03:35:21Z' } } })
    answers['/slack-test'] = () => json({ error: 'The test didn’t arrive: Bee Hub can’t post to your channel.' }, 502)
    await show(slack())
    await tap('Send test message')
    expect(host.querySelector('[data-slack-test-result]')!.textContent).toContain('The test didn’t arrive')
    expect(chip().textContent).toBe('Channel unavailable')
    answers['/slack-test'] = () => json({ message: 'Test message sent — go check Slack.' })
    await tap('Send test message')
    expect(host.querySelector('[data-slack-test-result]')!.textContent).toBe('Test message sent — go check Slack.')
    expect(chip().textContent).toBe('Connected')
    expect(host.querySelector('[data-slack-broken]')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5 · JOBBER
// ═══════════════════════════════════════════════════════════════════════
describe('5 · the Jobber screen', () => {
  const idle = () => json({ job: null, client_count: 28 })

  it('NOT CONNECTED: Connect Jobber, nothing asked', async () => {
    await show(jobber({ jobberStatus: 'disconnected', jobberAccountName: '' }))
    expect(host.querySelector('[data-jobber-screen]')!.getAttribute('data-jobber-screen')).toBe('off')
    expect(chip().textContent).toBe('Not connected')
    expect(areas()).toEqual(['Your account'])
    expect(btn('Connect Jobber')!.getAttribute('data-sbtn')).toBe('primary')
    expect(host.querySelector('[data-conn-footer]')).toBeNull()
    expect(calls).toEqual([])
  })

  it('CLIENTS NOT BROUGHT IN YET: Ready to import, one button, the estimate', async () => {
    answers['/api/import/active'] = idle
    answers['/connection-health'] = health()
    await show(jobber())
    expect(host.querySelector('[data-jobber-screen]')!.getAttribute('data-jobber-screen')).toBe('first')
    expect(chip().textContent).toBe('Ready to import')
    expect(host.querySelector('[data-conn-account]')!.textContent).toBe('Account · Bee Organized Katy')
    expect(areas()).toEqual(['Your clients', 'New updates'])
    expect(host.querySelector('[data-import-first]')!.textContent).toContain('Bring your existing Jobber clients into Bee Hub.')
    expect(host.querySelector('[data-import-first]')!.textContent).toContain('about 28 clients')
    expect(btn('Bring in my clients')!.getAttribute('data-sbtn')).toBe('primary')
    expect(host.querySelector('[data-conn-metrics]')).toBeNull()
    expect(posts()).toEqual([])
  })

  it('BRINGING THEM IN: Importing, "12 of 28", a bar that is 12/28 full, and a quiet Cancel', async () => {
    answers['/api/import/active'] = () => json({ job: { id: 'job-1', status: 'running', phase: 'writing', processed_records: 12, total_records: 28 } })
    answers['/api/import/status/job-1'] = () => json({ id: 'job-1', status: 'running', phase: 'writing', processed_records: 12, total_records: 28 })
    answers['/connection-health'] = health()
    await show(jobber())
    expect(host.querySelector('[data-jobber-screen]')!.getAttribute('data-jobber-screen')).toBe('importing')
    expect(chip().textContent).toBe('Importing')
    const box = host.querySelector('[data-import-running]')!
    expect(box.textContent).toContain('Bringing in your clients')
    expect(box.querySelector('[role="status"]')!.textContent).toBe('12 of 28')
    const bar = box.querySelector('[role="progressbar"]') as HTMLElement
    expect(bar.getAttribute('aria-valuenow')).toBe('12'); expect(bar.getAttribute('aria-valuemax')).toBe('28')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('43%')
    expect(box.textContent).toContain('You can leave this page; it keeps going.')
    expect(btn('Cancel import')!.hasAttribute('data-conn-quiet')).toBe(true)
    expect(btn('Bring in my clients')).toBeUndefined()
  })

  it('bringing them in, before any count: words and a sliding bar, never "0 of 28"', async () => {
    answers['/api/import/active'] = () => json({ job: { id: 'job-1', status: 'running', phase: 'fetching clients', processed_records: 0, total_records: 28 } })
    answers['/api/import/status/job-1'] = () => json({ id: 'job-1', status: 'running', phase: 'fetching clients', processed_records: 0, total_records: 28 })
    answers['/connection-health'] = health()
    await show(jobber())
    const box = host.querySelector('[data-import-running]')!
    expect(box.textContent).not.toMatch(/0 of 28/)
    expect(box.querySelector('[role="progressbar"]')!.getAttribute('data-conn-progress')).toBe('waiting')
    expect(box.querySelector('[role="progressbar"]')!.hasAttribute('aria-valuenow')).toBe(false)
  })

  it('STUCK PART WAY (found on opening the page): On hold, "12 of 28 came across", Carry on', async () => {
    answers['/api/import/active'] = idle
    answers['/connection-health'] = health({ jobber: { lastJob: { status: 'failed', processed: 12, total: 28, at: '2026-11-20T10:00:00Z' } } })
    await show(jobber())
    expect(host.querySelector('[data-jobber-screen]')!.getAttribute('data-jobber-screen')).toBe('stuck')
    expect(chip().textContent).toBe('On hold')
    expect(chip().getAttribute('data-conn-tone')).toBe('warn')
    const box = host.querySelector('[data-import-stopped]')!
    expect(box.textContent).toContain('12 of 28 clients came across before the import stopped.')
    expect(box.textContent).toContain('Your imported clients are safe. Carry on and it brings in the rest; nobody is added twice.')
    expect(btn('Carry on')!.getAttribute('data-sbtn')).toBe('primary')
    expect(btn('Bring in my clients')).toBeUndefined()
    // Carry on is the same request the first import makes — nothing new.
    // (phase 'clients': the engine re-posts by itself from 'writing', which
    // is its own doing and would muddy the count here.)
    answers['/api/import/jobber-clients'] = () => json({ job_id: 'job-2' })
    answers['/api/import/status/job-2'] = () => json({ id: 'job-2', status: 'running', phase: 'clients', processed_records: 13, total_records: 28 })
    await tap('Carry on')
    expect(posts().map(c => c.url)).toEqual([`/api/import/jobber-clients?location_id=${LOC}`])
    expect(chip().textContent).toBe('Importing')
  })

  it('stuck part way (it stopped while the page was open): the same box, with what stopped it', async () => {
    answers['/api/import/active'] = () => json({ job: { id: 'job-1', status: 'running', phase: 'writing', processed_records: 12, total_records: 28 } })
    answers['/api/import/status/job-1'] = () => json({ id: 'job-1', status: 'failed', phase: 'writing', processed_records: 12, total_records: 28, error: 'Jobber was busy' })
    answers['/connection-health'] = health()
    await show(jobber())
    expect(chip().textContent).toBe('On hold')
    const box = host.querySelector('[data-import-stopped]')!
    expect(box.textContent).toContain('12 of 28 clients came across before the import stopped.')
    expect(box.querySelector('[data-import-error]')!.textContent).toBe('What stopped it: Jobber was busy')
    expect(btn('Carry on')).toBeTruthy()
  })

  it('a stopped import with nothing across is "not brought in yet", not "stuck"', async () => {
    answers['/api/import/active'] = idle
    answers['/connection-health'] = health({ jobber: { lastJob: { status: 'failed', processed: 0, total: 28, at: null } } })
    await show(jobber())
    expect(chip().textContent).toBe('Ready to import')
    expect(btn('Bring in my clients')).toBeTruthy()
  })

  it('RUNNING: Syncing, how many came across, and when Jobber last sent an update', async () => {
    answers['/api/import/active'] = idle
    answers['/connection-health'] = health({ jobber: { lastInboundAt: new Date().toISOString(), lastJob: { status: 'completed', processed: 139, total: 139, at: null }, broughtIn: 1390 } })
    await show(jobber({ jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' }))
    expect(host.querySelector('[data-jobber-screen]')!.getAttribute('data-jobber-screen')).toBe('running')
    expect(chip().textContent).toBe('Syncing')
    expect(chip().getAttribute('data-conn-tone')).toBe('ok')
    expect(host.querySelector('[data-jobber-brought-in]')!.textContent).toBe('Clients brought in1,390')
    expect(host.querySelector('[data-jobber-last-sent]')!.textContent).toMatch(/^Jobber last sent an updateToday, /)
    expect(btn('Bring in my clients')).toBeUndefined()
    expect(words()).toContain('New requests, quotes, jobs and invoices come across on their own.')
    expect(words()).not.toContain('Updates are paused')
    expect(btn('Re-sync from Jobber')!.hasAttribute('data-conn-quiet')).toBe(true)
  })

  it('running: a number that is not known is left out, never made up', async () => {
    answers['/api/import/active'] = idle
    answers['/connection-health'] = health()                           // known: nothing has arrived, no finished import on record
    await show(jobber({ jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' }))
    expect(host.querySelector('[data-jobber-brought-in]')).toBeNull()
    expect(host.querySelector('[data-jobber-last-sent]')!.textContent).toBe('Jobber last sent an updateNothing yet')
    act(() => root.unmount()); root = createRoot(host)
    answers['/connection-health'] = () => json({ error: 'Server error' }, 500)   // not known at all
    await show(jobber({ jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' }))
    expect(chip().textContent).toBe('Syncing')
    expect(host.querySelector('[data-conn-metrics]')).toBeNull()
    expect(host.textContent).not.toMatch(/Nothing yet|NaN|undefined|null/)
  })

  it('NEEDS RECONNECTING: Needs attention, one Reconnect button, updates paused, no import offered', async () => {
    answers['/connection-health'] = health({ jobber: { lastInboundAt: '2026-10-01T00:00:00Z', broughtIn: 139 } })
    await show(jobber({ jobberStatus: 'reconnect_required', jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' }))
    expect(host.querySelector('[data-jobber-screen]')!.getAttribute('data-jobber-screen')).toBe('reconnect')
    expect(chip().textContent).toBe('Needs attention')
    expect(chip().getAttribute('data-conn-tone')).toBe('warn')
    expect(host.querySelector('[data-jobber-reconnect]')!.textContent).toContain('Jobber needs your permission again.')
    expect(host.querySelector('[data-jobber-reconnect]')!.textContent).toContain('Your clients are still here.')
    expect(btn('Reconnect Jobber')!.getAttribute('data-sbtn')).toBe('primary')
    expect(host.querySelector('[data-jobber-paused]')!.textContent).toBe('Updates are paused until you reconnect.')
    expect(btn('Bring in my clients')).toBeUndefined()
    expect(host.querySelector('[data-conn-metrics]')).toBeNull()       // "Syncing" numbers would mislead here
    expect(calls.some(c => c.url.includes('/api/import/'))).toBe(false) // the import engine is not even mounted
    expect(btn('Reconnect to a different account')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6 · DISCONNECT IS A QUIET TEXT LINK AT THE FOOT, UNDER A RULE
// ═══════════════════════════════════════════════════════════════════════
describe('6 · Disconnect: a quiet text link at the bottom, below a divider, never a button', () => {
  const check = (which: string) => {
    const foot = host.querySelector('[data-conn-footer]') as HTMLElement
    expect(foot, which).toBeTruthy()
    // The foot is the last thing on the screen, and it starts with a rule.
    expect(host.querySelector('[data-conn-screen]')!.lastElementChild, which).toBe(foot)
    expect(foot.style.borderTop, which).toMatch(/^1px solid/)
    const all = Array.from(host.querySelectorAll('button')).filter(b => /disconnect/i.test(b.textContent || ''))
    expect(all.length, which).toBe(1)
    const link = all[0]
    expect(link.textContent, which).toBe('Disconnect')
    expect(foot.contains(link), which).toBe(true)
    // A text link: no box, no fill, no button styling, muted words.
    expect(link.hasAttribute('data-conn-quiet'), which).toBe(true)
    expect(link.hasAttribute('data-sbtn'), which).toBe(false)
    expect(link.style.border, which).toMatch(/none/)
    expect(link.style.background, which).toBe('transparent')
    expect(link.style.padding, which).toMatch(/^0(px)?$/)
    expect((link.firstElementChild as HTMLElement).style.fontWeight, which).toBe('400')
    expect(link.style.minHeight, which).toBe('44px')                  // still tappable
  }

  it('Slack: connected and channel broken', async () => {
    answers['/connection-health'] = health()
    await show(slack()); check('slack connected')
    act(() => root.unmount()); root = createRoot(host)
    answers['/connection-health'] = health({ slack: { lastPost: { status: 'failed', error: 'channel_not_found', at: '2026-11-24T03:35:21Z' } } })
    await show(slack()); check('slack broken')
  })

  it('Jobber: not brought in, stuck, running, needs reconnecting', async () => {
    answers['/api/import/active'] = () => json({ job: null, client_count: 28 })
    for (const [name, h, over] of [
      ['first', health(), {}],
      ['stuck', health({ jobber: { lastJob: { status: 'failed', processed: 12, total: 28, at: null } } }), {}],
      ['running', health(), { jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' }],
      ['reconnect', health(), { jobberStatus: 'reconnect_required' }],
    ] as const) {
      act(() => root.unmount()); root = createRoot(host)
      answers['/connection-health'] = h
      await show(jobber(over)); check(`jobber ${name}`)
    }
  })

  it('the source draws Disconnect through QuietLink and nothing else', () => {
    const hub = readFileSync('components/BeeHub.jsx', 'utf8')
    for (const name of ['SlackCard', 'JobberCard']) {
      const a = hub.indexOf(`export function ${name}(`)
      const card = hub.slice(a, hub.indexOf('\n}\n', a))
      const drawn = card.split('\n').filter(l => />Disconnect</.test(l))
      expect(drawn.length, name).toBe(1)
      expect(drawn[0], name).toMatch(/<KUI\.QuietLink data-(slack|jobber)-disconnect onClick=\{\(\)=>setConfirming\(true\)\}/)
      expect(card.indexOf('>Disconnect<'), name).toBeGreaterThan(card.indexOf('<KUI.ConnFooter'))
      expect(card, name).not.toMatch(/Manage connection/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7 · EVERY ACTION STILL DOES WHAT IT DID
// ═══════════════════════════════════════════════════════════════════════
describe('7 · look only: the actions are the ones the old cards made', () => {
  it('Slack: Add to Slack and Reconnect go to the same connect address', async () => {
    await show(slack({ slackConnected: false }))
    await tap('Add to Slack')
    expect(href).toBe(`/api/slack/connect?location_id=${LOC}`)
    act(() => root.unmount()); root = createRoot(host); href = ''
    answers['/connection-health'] = health()
    await show(slack())
    await tap('Reconnect')
    expect(href).toBe(`/api/slack/connect?location_id=${LOC}`)
    expect(posts()).toEqual([])
  })

  it('Slack: Disconnect asks first; Cancel does nothing; Disconnect posts once and tells the page', async () => {
    const updateLocation = vi.fn()
    answers['/connection-health'] = health()
    answers['/slack-disconnect'] = () => json({ ok: true })
    await show(<SlackCard updateLocation={updateLocation} settings={{ location: { locId: LOC, name: 'Katy', slackConnected: true, slackTeamName: 'T', slackChannelName: 'leads', slackScopes: NEW_SCOPES } }} />)
    await tap('Disconnect')
    const win = host.querySelector('[role="dialog"]')!
    expect(win.textContent).toContain('Disconnect from Slack?')
    expect(win.textContent).toContain('New leads will stop posting to Slack. Your email notifications are unaffected. You can reconnect any time.')
    expect(posts()).toEqual([])
    await act(async () => { (Array.from(win.querySelectorAll('button')).find(b => b.textContent === 'Cancel') as HTMLButtonElement).click() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(posts()).toEqual([])
    await tap('Disconnect')
    await act(async () => { (Array.from(host.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === 'Disconnect') as HTMLButtonElement).click() })
    await flush()
    expect(posts()).toEqual([{ url: `/api/locations/${LOC}/slack-disconnect`, method: 'POST', body: null }])
    expect(updateLocation.mock.calls).toEqual([['slackConnected', false], ['slackTeamName', ''], ['slackChannelName', '']])
  })

  it('Slack: Send test message posts to the test address; the invite link saves and copies', async () => {
    const updateLocation = vi.fn()
    const copied: string[] = []
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => { copied.push(t) } } })
    answers['/connection-health'] = health()
    answers['/slack-test'] = () => json({ message: 'Test message sent — go check Slack.' })
    answers['/slack-invite'] = (init: any) => json({ slack_invite_url: JSON.parse(init.body).slack_invite_url })
    await show(<SlackCard updateLocation={updateLocation} settings={{ location: { locId: LOC, name: 'Katy', slackConnected: true, slackTeamName: 'T', slackChannelName: 'leads', slackScopes: NEW_SCOPES, slackInviteUrl: 'https://join.slack.com/t/katy/old' } }} />)
    await tap('Send test message')
    expect(posts()).toEqual([{ url: `/api/locations/${LOC}/slack-test`, method: 'POST', body: null }])

    const input = host.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('https://join.slack.com/t/katy/old')
    expect(btn('Save')!.disabled).toBe(true)                           // nothing changed yet
    await tap('Copy team invite')
    expect(copied).toEqual(['https://join.slack.com/t/katy/old'])
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'https://join.slack.com/t/katy/new')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(btn('Save')!.disabled).toBe(false)
    await tap('Save')
    expect(posts()[1]).toEqual({ url: `/api/locations/${LOC}/slack-invite`, method: 'POST', body: { slack_invite_url: 'https://join.slack.com/t/katy/new' } })
    expect(updateLocation).toHaveBeenCalledWith('slackInviteUrl', 'https://join.slack.com/t/katy/new')
  })

  it('Slack: the job channels switch is the same switch, making the same request', async () => {
    answers['/connection-health'] = health()
    answers['/slack-auto-channels'] = (init: any) => json({ setUp: true, on: init.method === 'POST' ? JSON.parse(init.body).on : false, since: init.method === 'POST' ? '2026-11-25T12:00:00Z' : null, capped: false, cap: 15, connected: true, reconnected: true, canSet: true })
    await show(slack())
    const sw = host.querySelector('[data-slack-auto-switch]') as HTMLButtonElement
    expect(sw.closest('[data-conn-area]')!.querySelector('h2')!.textContent).toBe('Job channels')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await act(async () => { sw.click() }); await flush()
    expect(posts()).toEqual([{ url: `/api/locations/${LOC}/slack-auto-channels`, method: 'POST', body: { on: true } }])
    expect((host.querySelector('[data-slack-auto-switch]') as HTMLElement).getAttribute('aria-checked')).toBe('true')
  })

  it('Slack: no "Job channels" heading over nothing; the reconnect line still shows without the switch', async () => {
    answers['/connection-health'] = health()
    answers['/slack-auto-channels'] = () => json({ setUp: false })
    await show(slack())
    expect(areas()).toEqual(['Lead alerts', 'Invite your team'])
    act(() => root.unmount()); root = createRoot(host)
    await show(slack({ slackScopes: null }))
    expect(areas()).toEqual(['Lead alerts', 'Job channels', 'Invite your team'])
    expect(host.querySelector('[data-slack-reconnect-words]')!.textContent).toContain('your lead posts stay in #leads.')
    await tap('Reconnect Slack')
    expect(href).toBe(`/api/slack/connect?location_id=${LOC}`)
  })

  it('Jobber: Bring in my clients makes the one import request; Cancel import the one cancel request', async () => {
    answers['/api/import/active'] = () => json({ job: null, client_count: 28 })
    answers['/connection-health'] = health()
    answers['/api/import/jobber-clients'] = () => json({ job_id: 'job-7' })
    answers['/api/import/status/job-7'] = () => json({ id: 'job-7', status: 'running', phase: 'clients', processed_records: 4, total_records: 28 })
    answers['/api/import/cancel'] = () => json({ ok: true })
    await show(jobber())
    await tap('Bring in my clients')
    expect(posts().map(c => c.url)).toEqual([`/api/import/jobber-clients?location_id=${LOC}`])
    expect(chip().textContent).toBe('Importing')
    await tap('Cancel import')
    expect(posts().map(c => c.url)).toEqual([`/api/import/jobber-clients?location_id=${LOC}`, '/api/import/cancel?job_id=job-7'])
    expect(chip().textContent).toBe('On hold')
  })

  it('Jobber: Connect, Reconnect and "a different account" go to the same connect address; Re-sync runs the import', async () => {
    await show(jobber({ jobberStatus: 'disconnected' }))
    await tap('Connect Jobber'); expect(href).toBe(`/api/jobber/connect?location_id=${LOC}`)
    act(() => root.unmount()); root = createRoot(host); href = ''
    answers['/connection-health'] = health()
    await show(jobber({ jobberStatus: 'reconnect_required' }))
    await tap('Reconnect Jobber'); expect(href).toBe(`/api/jobber/connect?location_id=${LOC}`)
    act(() => root.unmount()); root = createRoot(host); href = ''
    answers['/api/import/active'] = () => json({ job: null, client_count: 28 })
    answers['/api/import/jobber-clients'] = () => json({ job_id: 'job-8' })
    answers['/api/import/status/job-8'] = () => json({ id: 'job-8', status: 'running', phase: 'clients', processed_records: 4, total_records: 28 })
    await show(jobber({ jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' }))
    await tap('Reconnect to a different account'); expect(href).toBe(`/api/jobber/connect?location_id=${LOC}`)
    expect(posts()).toEqual([])
    await tap('Re-sync from Jobber')
    expect(posts().map(c => c.url)).toEqual([`/api/import/jobber-clients?location_id=${LOC}`])
  })

  it('Jobber: Disconnect asks first, then posts once and tells the page', async () => {
    const updateLocation = vi.fn()
    answers['/api/import/active'] = () => json({ job: null, client_count: 28 })
    answers['/connection-health'] = health()
    answers['/jobber-disconnect'] = () => json({ ok: true })
    await show(<JobberCard updateLocation={updateLocation} settings={{ location: { locId: LOC, name: 'Katy', jobberStatus: 'connected', jobberAccountName: 'A', jobberInitialImportCompletedAt: '2026-08-19T19:50:00Z' } }} />)
    await tap('Disconnect')
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('Disconnect from Jobber?')
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('This will stop syncing. Your imported leads and history will remain in Bee Hub. You can reconnect any time.')
    expect(posts()).toEqual([])
    await act(async () => { (Array.from(host.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === 'Disconnect') as HTMLButtonElement).click() })
    await flush()
    expect(posts()).toEqual([{ url: `/api/locations/${LOC}/jobber-disconnect`, method: 'POST', body: null }])
    expect(updateLocation.mock.calls).toEqual([['jobberStatus', 'disconnected'], ['jobberAccountName', '']])
    expect(chip().textContent).toBe('Not connected')
  })

  it('BeeHub.jsx is main c35bb70 plus these two screens, and nothing else', async () => {
    const { isMainOnceTakenOut, CONNECTION_SCREENS_HUB } = await import('@/lib/connection-screens-hub-footprint')
    // 2026-11-25 (FL-101): Mailchimp slice 6 came after these screens and
    // changed the Mailchimp card only, so it is taken back out first.
    const { withoutMailchimpSendSlice6 } = await import('@/lib/network/mailchimp-send-hub-footprint')
    expect(CONNECTION_SCREENS_HUB.sha256).toBe('f73d39091fca81ddb7d91c6e6c87f4f20143f481c1a01777911cf62973867cb1')
    expect(isMainOnceTakenOut(withoutMailchimpSendSlice6(readFileSync('components/BeeHub.jsx', 'utf8')))).toBe(true)
  })

  it('the design\'s preview pills (a design-tool control) are not on either screen', async () => {
    answers['/connection-health'] = health()
    await show(slack())
    expect(host.querySelector('[aria-label="Connection screen preview"]')).toBeNull()
    expect(Array.from(host.querySelectorAll('button')).map(b => b.textContent)).not.toContain('Channel broken')
  })
})
