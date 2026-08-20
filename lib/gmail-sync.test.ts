// @vitest-environment node
//
// Gmail ingest (step 4) — pins the load-bearing behaviors:
//   • the sync_enabled gate lives in the ENGINE and makes ZERO fetch calls
//     (counted on global fetch AND every injected Gmail dep)
//   • re-running the same messages writes no duplicate rows (idempotency
//     across a full run followed by an incremental run)
//   • an ambiguous address yields thread lead_id NULL — never a guess
//   • an unmatched thread is never inserted, and its body is NEVER fetched
//     (getMessageFull call list is the privacy pin)
//   • a mid-run write failure leaves last_history_id unchanged
//   • a history.list 404 falls back to a full window and records it
// All addresses are mock @example.com data.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('./supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import { GmailApiError } from './gmail'
import { syncMailbox } from './gmail-sync'

const MAILBOX = 'agent@beeorganized.com'
const ACCT = 'acct-1'
const LOC_UUID = 'loc-uuid-1'

// ---- stateful fake supabase ------------------------------------------------
function fakeDb(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = JSON.parse(JSON.stringify(seed))
  const log: string[] = []
  let idSeq = 0
  let failNext: { table: string; op: string } | null = null
  const failOnce = (table: string, op: string) => { failNext = { table, op } }

  function from(table: string) {
    let op = 'select'
    let payload: any = null
    let conflictKeys: string[] = []
    let head = false
    const filters: ((r: any) => boolean)[] = []
    const b: any = {}
    const self = (fn: (...a: any[]) => void) => (...a: any[]) => { fn(...a); return b }
    b.select = self((_cols?: string, o?: any) => { if (o?.head) head = true })
    b.limit = self(() => {})
    b.order = self(() => {})
    b.eq = self((c: string, v: any) => filters.push((r) => r[c] === v))
    b.neq = self((c: string, v: any) => filters.push((r) => r[c] !== v))
    b.in = self((c: string, vs: any[]) => filters.push((r) => vs.includes(r[c])))
    b.not = self((c: string, o: string, v: any) => {
      if (o === 'is' && v === null) filters.push((r) => r[c] != null)
      else if (o === 'is') filters.push((r) => r[c] !== v)
    })
    b.ilikeAnyOf = self((c: string, patterns: string[]) => {
      const wanted = patterns.map((p) => p.replace(/\\([\\%_])/g, '$1').toLowerCase())
      filters.push((r) => r[c] != null && wanted.includes(String(r[c]).toLowerCase()))
    })
    b.insert = self((rows: any) => { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows] })
    b.upsert = self((rows: any, o?: any) => {
      op = 'upsert'
      payload = Array.isArray(rows) ? rows : [rows]
      conflictKeys = String(o?.onConflict ?? '').split(',')
    })
    b.update = self((patch: any) => { op = 'update'; payload = patch })
    b.then = (resolve: any) => resolve(execute())
    function execute() {
      log.push(`${table}.${op}`)
      if (failNext && failNext.table === table && failNext.op === op) {
        failNext = null
        return { data: null, error: { message: 'injected failure' }, count: null }
      }
      const rows = tables[table] ?? (tables[table] = [])
      const match = () => rows.filter((r) => filters.every((f) => f(r)))
      if (op === 'select') {
        return head
          ? { data: null, error: null, count: match().length }
          : { data: match(), error: null, count: null }
      }
      if (op === 'insert') {
        const inserted = payload.map((r: any) => ({ id: `uuid-${++idSeq}`, ...r }))
        rows.push(...inserted)
        return { data: inserted, error: null }
      }
      if (op === 'upsert') {
        const out: any[] = []
        for (const r of payload) {
          const existing = rows.find((x) => conflictKeys.every((k) => x[k] === r[k]))
          if (existing) { Object.assign(existing, r); out.push(existing) }
          else { const nr = { id: `uuid-${++idSeq}`, ...r }; rows.push(nr); out.push(nr) }
        }
        return { data: out, error: null }
      }
      if (op === 'update') {
        match().forEach((r) => Object.assign(r, payload))
        return { data: null, error: null }
      }
      throw new Error(`fake db: unknown op ${op}`)
    }
    return b
  }
  return { client: { from }, tables, log, failOnce }
}

const seedTables = (over: Partial<Record<string, any[]>> = {}) => ({
  email_accounts: [{
    id: ACCT, email_address: MAILBOX, location_id: LOC_UUID,
    sync_enabled: true, last_history_id: null, last_synced_at: null,
  }],
  locations: [{ id: LOC_UUID, slug: 'loc_test' }],
  leads: [
    { id: 'lead-1', email: 'lead1@example.com', location_id: 'loc_test', location_uuid: LOC_UUID, is_junk: false },
    { id: 'lead-2', email: 'both@example.com', location_id: 'loc_test', location_uuid: LOC_UUID, is_junk: false },
    { id: 'lead-3', email: 'Both@Example.com', location_id: 'loc_test', location_uuid: LOC_UUID, is_junk: false },
  ],
  email_threads: [],
  email_messages: [],
  email_attachments: [],
  ...over,
})

// ---- gmail mocks -----------------------------------------------------------
const b64 = (s: string) => Buffer.from(s).toString('base64url')

// m1 t1 inbound from lead1 (with attachment) — exactly-one match
// m4 t1 outbound from the mailbox to lead1 — direction 'out'
// m2 t2 from a stranger — UNMATCHED, must never be written or body-fetched
// m3 t3 from both@ (two leads) — AMBIGUOUS, stored with lead_id NULL
const MESSAGES = [
  {
    id: 'm1', threadId: 't1', internalDate: '1723900000000',
    meta: { from: 'Lead One <lead1@example.com>', to: `Agent <${MAILBOX}>`, subject: 'Hello' },
    full: {
      headers: [
        { name: 'From', value: 'Lead One <lead1@example.com>' },
        { name: 'To', value: `Agent <${MAILBOX}>` },
        { name: 'Subject', value: 'Hello' },
        { name: 'Message-ID', value: '<m1@example.com>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('hi there') } },
        { mimeType: 'application/pdf', filename: 'quote.pdf', body: { attachmentId: 'att-1', size: 123 } },
      ],
    },
  },
  {
    id: 'm4', threadId: 't1', internalDate: '1723900100000',
    meta: { from: `Agent <${MAILBOX}>`, to: 'lead1@example.com', subject: 'Re: Hello' },
    full: {
      headers: [
        { name: 'From', value: `Agent <${MAILBOX}>` },
        { name: 'To', value: 'lead1@example.com' },
        { name: 'Subject', value: 'Re: Hello' },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64('reply') } }],
    },
  },
  {
    id: 'm2', threadId: 't2', internalDate: '1723900200000',
    meta: { from: 'stranger@example.com', to: `Agent <${MAILBOX}>`, subject: 'Personal' },
    full: { headers: [{ name: 'From', value: 'stranger@example.com' }], parts: [] },
  },
  {
    id: 'm3', threadId: 't3', internalDate: '1723900300000',
    meta: { from: 'BOTH@EXAMPLE.COM', to: `Agent <${MAILBOX}>`, subject: 'Which lead?' },
    full: {
      headers: [
        { name: 'From', value: 'BOTH@EXAMPLE.COM' },
        { name: 'To', value: `Agent <${MAILBOX}>` },
        { name: 'Subject', value: 'Which lead?' },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64('hm') } }],
    },
  },
]

function makeGmail() {
  const byId = new Map(MESSAGES.map((m) => [m.id, m]))
  const refs = MESSAGES.map((m) => ({ id: m.id, threadId: m.threadId }))
  return {
    listMessageIds: vi.fn(async () => ({ messages: refs, nextPageToken: undefined })),
    listHistory: vi.fn(async () => ({ messagesAdded: refs, historyId: 'hist-100', nextPageToken: undefined })),
    getMessageMetadata: vi.fn(async (_u: string, id: string) => {
      const m = byId.get(id)!
      return { id: m.id, threadId: m.threadId, internalDate: m.internalDate, headers: m.meta }
    }),
    getMessageFull: vi.fn(async (_u: string, id: string) => {
      const m = byId.get(id)!
      return {
        id: m.id, threadId: m.threadId, internalDate: m.internalDate, snippet: 'snip',
        payload: { mimeType: 'multipart/mixed', headers: m.full.headers, parts: m.full.parts },
      }
    }),
    getProfile: vi.fn(async () => ({
      emailAddress: MAILBOX, messagesTotal: 4, threadsTotal: 3, historyId: 'hist-99',
    })),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('syncMailbox', () => {
  it('sync_enabled=false: zero report, ZERO fetch calls of any kind, zero writes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const db = fakeDb(seedTables({
      email_accounts: [{ id: ACCT, email_address: MAILBOX, location_id: LOC_UUID, sync_enabled: false, last_history_id: null }],
    }))
    const gmail = makeGmail()
    const report = await syncMailbox(ACCT, { deps: { supabase: db.client, ...gmail } })

    expect(report.ran).toBe(false)
    expect(report.reason).toBe('sync_not_enabled')
    expect(report.threadsWritten + report.messagesWritten + report.attachmentsWritten).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(gmail.listMessageIds).not.toHaveBeenCalled()
    expect(gmail.listHistory).not.toHaveBeenCalled()
    expect(gmail.getMessageMetadata).not.toHaveBeenCalled()
    expect(gmail.getMessageFull).not.toHaveBeenCalled()
    expect(gmail.getProfile).not.toHaveBeenCalled()
    expect(db.log.filter((l) => !l.endsWith('.select'))).toEqual([])
  })

  it('unknown account: zero report, no Gmail calls', async () => {
    const db = fakeDb(seedTables())
    const gmail = makeGmail()
    const report = await syncMailbox('nope', { deps: { supabase: db.client, ...gmail } })
    expect(report.ran).toBe(false)
    expect(report.reason).toBe('account_not_found')
    expect(gmail.getProfile).not.toHaveBeenCalled()
  })

  it('full sync stores matched threads only; ambiguity is NULL; unmatched bodies never fetched', async () => {
    const db = fakeDb(seedTables())
    const gmail = makeGmail()
    const report = await syncMailbox(ACCT, { deps: { supabase: db.client, ...gmail } })

    expect(report.ran).toBe(true)
    expect(report.mode).toBe('full')
    expect(report.locationSlug).toBe('loc_test')
    expect(report.messagesScanned).toBe(4)
    expect(report.messagesMatchedExactlyOneLead).toBe(2) // m1, m4
    expect(report.messagesMatchedMultipleLeadsSameLocation).toBe(1) // m3
    expect(report.messagesUnmatched).toBe(1) // m2
    expect(report.threadsWritten).toBe(2)
    expect(report.messagesWritten).toBe(3)
    expect(report.attachmentsWritten).toBe(1)
    expect(report.cursorAdvancedTo).toBe('hist-99')

    const threads = db.tables.email_threads
    expect(threads).toHaveLength(2)
    const t1 = threads.find((t: any) => t.gmail_thread_id === 't1')
    const t3 = threads.find((t: any) => t.gmail_thread_id === 't3')
    expect(threads.find((t: any) => t.gmail_thread_id === 't2')).toBeUndefined() // privacy boundary
    expect(t1.lead_id).toBe('lead-1')
    expect(t1.match_method).toBe('email')
    expect(t1.matched_at).toBeTruthy()
    expect(t1.message_count).toBe(2)
    expect(t3.lead_id).toBeNull() // ambiguous — no guessing
    expect(t3.match_method).toBeNull()

    const messages = db.tables.email_messages
    expect(messages).toHaveLength(3)
    expect(messages.map((m: any) => m.gmail_message_id).sort()).toEqual(['m1', 'm3', 'm4'])
    expect(messages.find((m: any) => m.gmail_message_id === 'm1').direction).toBe('in')
    expect(messages.find((m: any) => m.gmail_message_id === 'm4').direction).toBe('out')
    expect(messages.find((m: any) => m.gmail_message_id === 'm1').body_text).toBe('hi there')

    // The privacy pin: format=full was requested ONLY for matched-thread messages.
    const fullIds = gmail.getMessageFull.mock.calls.map((c) => c[1]).sort()
    expect(fullIds).toEqual(['m1', 'm3', 'm4'])

    const acct = db.tables.email_accounts[0]
    expect(acct.last_history_id).toBe('hist-99')
    expect(acct.last_synced_at).toBeTruthy()
  })

  it('re-running the same messages writes no duplicates', async () => {
    const db = fakeDb(seedTables())
    const gmail = makeGmail()
    await syncMailbox(ACCT, { deps: { supabase: db.client, ...gmail } })
    const snapshot = {
      threads: db.tables.email_threads.length,
      messages: db.tables.email_messages.length,
      attachments: db.tables.email_attachments.length,
    }
    // Second run is incremental (cursor now set) and replays the same ids.
    const report2 = await syncMailbox(ACCT, { deps: { supabase: db.client, ...gmail } })
    expect(report2.mode).toBe('incremental')
    expect(db.tables.email_threads).toHaveLength(snapshot.threads)
    expect(db.tables.email_messages).toHaveLength(snapshot.messages)
    expect(db.tables.email_attachments).toHaveLength(snapshot.attachments)
    expect(db.tables.email_accounts[0].last_history_id).toBe('hist-100')
  })

  it('a mid-run write failure leaves last_history_id unchanged', async () => {
    const db = fakeDb(seedTables())
    const gmail = makeGmail()
    db.failOnce('email_messages', 'upsert')
    await expect(
      syncMailbox(ACCT, { deps: { supabase: db.client, ...gmail } })
    ).rejects.toThrow(/email_messages upsert failed/)
    expect(db.tables.email_accounts[0].last_history_id).toBeNull()
    expect(db.tables.email_accounts[0].last_synced_at).toBeFalsy()
  })

  it('history.list 404 falls back to a full window and records it', async () => {
    const db = fakeDb(seedTables({
      email_accounts: [{ id: ACCT, email_address: MAILBOX, location_id: LOC_UUID, sync_enabled: true, last_history_id: 'ancient-1' }],
    }))
    const gmail = makeGmail()
    gmail.listHistory.mockRejectedValueOnce(new GmailApiError(404, 'Gmail API 404 on history: expired'))
    const report = await syncMailbox(ACCT, { deps: { supabase: db.client, ...gmail } })
    expect(report.mode).toBe('full')
    expect(report.historyFallback).toBe(true)
    expect(gmail.listMessageIds).toHaveBeenCalled()
    expect(report.cursorAdvancedTo).toBe('hist-99')
  })
})
