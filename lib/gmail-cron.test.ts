// @vitest-environment node
//
// Gmail scheduled sync (step 5) — pins the caller's contract:
//   • zero enabled accounts → zero report, no throw, no engine call
//   • one account throwing does not prevent the next from running, and the
//     failure lands in that row's last_error / error_count
//   • error_count >= 10 opens the circuit — skipped with NO engine call
//   • a successful run zeroes error_count
// The engine itself is not exercised here; syncMailbox is injected.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import { runScheduledGmailSync, CIRCUIT_BREAKER_THRESHOLD } from './gmail-cron'

function fakeDb(accounts: any[]) {
  const rows = JSON.parse(JSON.stringify(accounts))
  function from(table: string) {
    if (table !== 'email_accounts') throw new Error(`unexpected table ${table}`)
    let op = 'select'
    let patch: any = null
    const filters: ((r: any) => boolean)[] = []
    const b: any = {}
    const self = (fn: (...a: any[]) => void) => (...a: any[]) => { fn(...a); return b }
    b.select = self(() => {})
    b.order = self(() => {})
    b.eq = self((c: string, v: any) => filters.push((r) => r[c] === v))
    b.update = self((p: any) => { op = 'update'; patch = p })
    b.then = (resolve: any) => {
      const match = rows.filter((r: any) => filters.every((f) => f(r)))
      if (op === 'update') {
        match.forEach((r: any) => Object.assign(r, patch))
        return resolve({ data: null, error: null })
      }
      return resolve({ data: match, error: null })
    }
    return b
  }
  return { client: { from }, rows }
}

const okReport = (over: Partial<any> = {}) => ({
  ran: true, mode: 'incremental', capHit: false, cursorAdvancedTo: 'h1',
  messagesScanned: 5, threadsWritten: 1, messagesWritten: 2, attachmentsWritten: 0,
  ...over,
})

describe('runScheduledGmailSync', () => {
  it('zero enabled accounts: zero report, no throw, no engine call', async () => {
    const db = fakeDb([{ id: 'a1', sync_enabled: false, error_count: 0 }])
    const sync = vi.fn()
    const report = await runScheduledGmailSync({ deps: { supabase: db.client, syncMailbox: sync } })
    expect(report.ran).toBe(true)
    expect(report.accountsEnabled).toBe(0)
    expect(report.accountsSynced).toBe(0)
    expect(report.results).toEqual([])
    expect(sync).not.toHaveBeenCalled()
  })

  it('one account throwing does not prevent the next from running', async () => {
    const db = fakeDb([
      { id: 'a1', sync_enabled: true, error_count: 2, last_error: null, last_synced_at: '2026-01-01' },
      { id: 'a2', sync_enabled: true, error_count: 0, last_error: null, last_synced_at: '2026-01-02' },
    ])
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error('Gmail API 500 on messages'))
      .mockResolvedValueOnce(okReport())
    const report = await runScheduledGmailSync({ deps: { supabase: db.client, syncMailbox: sync } })

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls.map((c) => c[0])).toEqual(['a1', 'a2'])
    expect(report.accountsFailed).toEqual(['a1'])
    expect(report.accountsSynced).toBe(1)
    const a1 = db.rows.find((r: any) => r.id === 'a1')
    expect(a1.error_count).toBe(3) // incremented, not reset
    expect(a1.last_error).toMatch(/Gmail API 500/)
    expect(report.results.find((r) => r.accountId === 'a2')?.ok).toBe(true)
  })

  it('error_count >= threshold is circuit-open: skipped with no engine call', async () => {
    const db = fakeDb([
      { id: 'broken', sync_enabled: true, error_count: CIRCUIT_BREAKER_THRESHOLD, last_error: 'x', last_synced_at: null },
      { id: 'fine', sync_enabled: true, error_count: 0, last_error: null, last_synced_at: null },
    ])
    const sync = vi.fn().mockResolvedValue(okReport())
    const report = await runScheduledGmailSync({ deps: { supabase: db.client, syncMailbox: sync } })

    expect(report.circuitOpen).toEqual(['broken'])
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith('fine', expect.anything())
    // circuit-open row untouched — no reset, no increment
    expect(db.rows.find((r: any) => r.id === 'broken').error_count).toBe(CIRCUIT_BREAKER_THRESHOLD)
  })

  it('a successful run zeroes error_count and clears last_error', async () => {
    const db = fakeDb([
      { id: 'a1', sync_enabled: true, error_count: 3, last_error: 'old failure', last_synced_at: null },
    ])
    const sync = vi.fn().mockResolvedValue(okReport())
    const report = await runScheduledGmailSync({ deps: { supabase: db.client, syncMailbox: sync } })

    expect(report.accountsSynced).toBe(1)
    const a1 = db.rows.find((r: any) => r.id === 'a1')
    expect(a1.error_count).toBe(0)
    expect(a1.last_error).toBeNull()
  })

  it('accounts run sequentially and past the start cutoff are reported skipped', async () => {
    const db = fakeDb([
      { id: 'a1', sync_enabled: true, error_count: 0, last_error: null, last_synced_at: null },
      { id: 'a2', sync_enabled: true, error_count: 0, last_error: null, last_synced_at: null },
    ])
    let concurrent = 0
    let maxConcurrent = 0
    const sync = vi.fn(async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 25))
      concurrent--
      return okReport()
    })
    // cutoff 10ms: a1 starts at ~0ms and runs 25ms; a2 would start past it
    const report = await runScheduledGmailSync({
      startCutoffMs: 10,
      deps: { supabase: db.client, syncMailbox: sync },
    })
    expect(maxConcurrent).toBe(1)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(report.skippedForTime).toEqual(['a2'])
    expect(report.accountsSynced).toBe(1)
  })
})
