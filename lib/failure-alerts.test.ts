// @vitest-environment node
//
// Instant failure alerts (issue 159) — the ~5-min watermark cron.
// What these tests pin:
//
//   1) Each ALLOWLISTED signal fires: sync_log not_landed, import_jobs
//      failed, a genuine Jobber token expiry, ASSESSMENT_TEAM_MISMATCH.
//   2) The watermark advances and does NOT re-alert: an item alerted in one
//      window is gone from the next (its ts is at-or-before the new since).
//   3) NON-allowlisted noise stays silent: a self-healing token race, a raw
//      status='error' non-token failure, and a user-cancelled import.
//   4) A quiet window posts NOTHING (buildAlertMessage → null).
//   5) The token-expiry settle: a reauth failure newer than now-5min is not
//      yet settled and does not fire until its window commits.
//   6) Fetch + source pins: import_jobs status/type + cancel handling, the
//      ASSESSMENT_TEAM_MISMATCH scoped on the message (both directions),
//      never reads notification_log, never writes sync_log, CRON_SECRET
//      fail-closed, and vercel.json registers "*/5 * * * *".

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// failure-alerts imports supabaseService at module load (createClient needs
// env we don't set). Every test that touches the fetch layer injects its own
// supabase; the pure selector needs none. Stub the module.
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import {
  selectNewAlerts,
  buildAlertMessage,
  collectFailureAlerts,
  fetchImportFailures,
  fetchAssessmentMismatches,
  ALERT_SETTLE_MS,
  type AlertItem,
} from '@/lib/failure-alerts'
import type { WebhookLogEvent } from '@/lib/webhook-observability'

const NOW = Date.parse('2026-07-18T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000

// A committed window: (SINCE, CUTOFF]. CUTOFF trails NOW by the settle.
const CUTOFF = NOW - ALERT_SETTLE_MS       // 11:55:00
const SINCE = NOW - 10 * MIN               // 11:50:00
const inWin = NOW - 8 * MIN                // 11:52:00 — inside (SINCE, CUTOFF]

function ev(over: Partial<WebhookLogEvent>): WebhookLogEvent {
  return {
    id: Math.random().toString(36).slice(2),
    created_at: iso(inWin),
    topic: 'JOB_UPDATE',
    friendly: 'Job updated',
    skipped: false,
    processed: true,
    error: null,
    reason: null,
    landed: 'landed',
    client_name: null,
    lead_id: null,
    location_id: 'loc_kc',
    location_name: 'Kansas City',
    jobber_item: '123',
    intake_slug: null,
    entity_id: null,
    stage_from: null,
    stage_to: null,
    message: 'topic=JOB_UPDATE item=123',
    ...over,
  }
}

const base = {
  events: [] as WebhookLogEvent[],
  importFailed: [] as any[],
  mismatches: [] as any[],
  locName: new Map<string, string>([['loc_kc', 'Kansas City']]),
  sinceMs: SINCE,
  cutoffMs: CUTOFF,
  nowMs: NOW,
}

describe('selectNewAlerts — each allowlisted signal fires', () => {
  it('sync_log not_landed → a "Didn\'t land" alert', () => {
    const items = selectNewAlerts({
      ...base,
      events: [ev({ topic: 'QUOTE_UPDATE', friendly: 'Quote updated', landed: 'stuck', client_name: 'Jane Doe' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('not_landed')
    expect(items[0].text).toContain("Didn't land")
    expect(items[0].text).toContain('Kansas City')
    expect(items[0].text).toContain('Jane Doe')
  })

  it('import_jobs failed → an "Import failed" alert', () => {
    const items = selectNewAlerts({
      ...base,
      importFailed: [{ location_id: 'loc_kc', phase: 'clients', error_message: 'Jobber 500', processed_records: 10, total_records: 200, completed_at: iso(inWin) }],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('import_failed')
    expect(items[0].text).toContain('Import failed')
    expect(items[0].text).toContain('Kansas City')
    expect(items[0].text).toContain('(10/200)')
    expect(items[0].text).toContain('Jobber 500')
  })

  it('a genuine reauth expiry (no following success) → a "token expired" alert', () => {
    const items = selectNewAlerts({
      ...base,
      events: [ev({ topic: 'QUOTE_UPDATE', processed: false, landed: null, error: 'reauth required', reason: 'reauth', jobber_item: '999' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('token_expired')
    expect(items[0].text).toContain('Jobber token expired')
    expect(items[0].text).toContain('Kansas City')
  })

  it('ASSESSMENT_TEAM_MISMATCH breadcrumb → an "Assessment team" alert with the missing count', () => {
    const items = selectNewAlerts({
      ...base,
      mismatches: [{
        location_id: 'loc_kc',
        message: '[send-to-jobber] topic=ASSESSMENT_TEAM_MISMATCH (issue 144) assessment=gid://x requested=[a,b,c] returned=[a] missing=[b,c] unexpected=[]',
        created_at: iso(inWin),
      }],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('assessment_mismatch')
    expect(items[0].text).toContain("Assessment team didn't apply")
    expect(items[0].text).toContain('Kansas City')
    expect(items[0].text).toContain('2 assignees missing')
  })
})

describe('selectNewAlerts — noise stays silent (allowlist, not denylist)', () => {
  it('a self-healing token race (reauth fail → success on the same entity within 5min) does NOT fire', () => {
    const items = selectNewAlerts({
      ...base,
      events: [
        ev({ topic: 'QUOTE_UPDATE', processed: false, landed: null, error: 'reauth', reason: 'reauth', jobber_item: '999', created_at: iso(inWin) }),
        ev({ topic: 'QUOTE_UPDATE', processed: true, landed: 'landed', jobber_item: '999', created_at: iso(inWin + 2 * MIN) }),
      ],
    })
    expect(items).toEqual([])
  })

  it('a raw status=error non-token failure does NOT fire', () => {
    const items = selectNewAlerts({
      ...base,
      events: [ev({ topic: 'QUOTE_UPDATE', processed: false, landed: null, error: 'validation failed: missing field', reason: 'validation failed' })],
    })
    expect(items).toEqual([])
  })

  it('a user-cancelled import does NOT fire', () => {
    const items = selectNewAlerts({
      ...base,
      importFailed: [{ location_id: 'loc_kc', error_message: 'Cancelled by user', completed_at: iso(inWin) }],
    })
    expect(items).toEqual([])
  })

  it('a quiet window posts nothing', () => {
    expect(selectNewAlerts({ ...base })).toEqual([])
    expect(buildAlertMessage([])).toBeNull()
  })
})

describe('selectNewAlerts — settle: a not-yet-settled reauth failure waits', () => {
  // The same reauth failure (created at 11:57) under two windows. The gate is
  // the CUTOFF, not the wall clock: it fires only once its window commits past
  // it — giving its 5-min self-heal chance time to elapse first.
  const failAt = NOW - 3 * MIN // 11:57
  const reauth = () => [ev({ topic: 'QUOTE_UPDATE', processed: false, landed: null, error: 'reauth', reason: 'reauth', jobber_item: '999', created_at: iso(failAt) })]

  it('does NOT fire while the failure is newer than the cutoff (still settling)', () => {
    const items = selectNewAlerts({
      ...base,
      sinceMs: NOW - 4 * MIN,         // 11:56
      cutoffMs: NOW - 4 * MIN + 30_000, // 11:56:30 — 11:57 is beyond it
      nowMs: NOW,
      events: reauth(),
    })
    expect(items).toEqual([])
  })

  it('DOES fire once its window commits past the failure', () => {
    const items = selectNewAlerts({
      ...base,
      sinceMs: NOW - 4 * MIN,         // 11:56
      cutoffMs: NOW,                  // 12:00 — 11:57 is now settled
      nowMs: NOW + 5 * MIN,
      events: reauth(),
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('token_expired')
  })
})

describe('watermark advances and does not re-alert', () => {
  it('an item alerted in one window is absent from the next window', () => {
    const stuck = ev({ topic: 'QUOTE_UPDATE', friendly: 'Quote updated', landed: 'stuck', created_at: iso(inWin) })

    // Run 1: window (SINCE, CUTOFF] contains the 11:52 event → fires.
    const run1 = selectNewAlerts({ ...base, events: [stuck], sinceMs: SINCE, cutoffMs: CUTOFF, nowMs: NOW })
    expect(run1).toHaveLength(1)

    // Run 2: watermark advanced to CUTOFF; new window (CUTOFF, NOW]. Same data,
    // but 11:52 ≤ CUTOFF (the new `since`) → excluded. No re-alert.
    const run2 = selectNewAlerts({ ...base, events: [stuck], sinceMs: CUTOFF, cutoffMs: NOW, nowMs: NOW + 5 * MIN })
    expect(run2).toEqual([])
  })
})

describe('buildAlertMessage', () => {
  const item = (over: Partial<AlertItem>): AlertItem => ({ kind: 'not_landed', ts: inWin, text: 'x', ...over })

  it('renders a header count + one bullet per item', () => {
    const msg = buildAlertMessage([
      item({ kind: 'not_landed', text: "Didn't land — A: rec · Quote updated" }),
      item({ kind: 'import_failed', text: 'Import failed — B: boom' }),
    ])!
    expect(msg.count).toBe(2)
    expect(msg.text).toContain('2 failures to check')
    expect(msg.text).toContain('• :warning: ')
    expect(msg.text).toContain('• :x: ')
  })

  it('singular header for one item', () => {
    expect(buildAlertMessage([item({})])!.text).toContain('1 failure to check')
  })
})

// ── fetch layer + collect (injected supabase, injected event fetcher) ──

// A chainable, awaitable builder: every op is chainable and the builder is
// itself a thenable that resolves to the per-table data — so both
// `.select().eq()....limit()` and bare `.select()` (locations) resolve.
function makeSupabase(byTable: Record<string, any[]>) {
  const calls: Array<{ table: string; ops: [string, any[]][] }> = []
  const supabase: any = {
    from(table: string) {
      const rec = { table, ops: [] as [string, any[]][] }
      calls.push(rec)
      const b: any = {
        then: (resolve: (v: any) => void) => resolve({ data: byTable[table] ?? [], error: null }),
      }
      for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'ilike', 'not', 'or', 'order', 'limit']) {
        b[m] = (...args: any[]) => { rec.ops.push([m, args]); return b }
      }
      return b
    },
  }
  return { supabase, calls }
}

describe('fetchImportFailures', () => {
  it('filters type=jobber_clients, status=failed, completed_at in (since, cutoff]', async () => {
    const { supabase, calls } = makeSupabase({ import_jobs: [] })
    await fetchImportFailures(supabase, iso(SINCE), iso(CUTOFF))
    const c = calls.find(c => c.table === 'import_jobs')!
    const eqs = c.ops.filter(o => o[0] === 'eq').map(o => o[1])
    expect(eqs).toEqual(expect.arrayContaining([['type', 'jobber_clients'], ['status', 'failed']]))
    expect(c.ops.find(o => o[0] === 'gt')?.[1]).toEqual(['completed_at', iso(SINCE)])
    expect(c.ops.find(o => o[0] === 'lte')?.[1]).toEqual(['completed_at', iso(CUTOFF)])
  })
})

describe('fetchAssessmentMismatches', () => {
  it('scopes on the message token across BOTH directions (no direction filter)', async () => {
    const { supabase, calls } = makeSupabase({ sync_log: [] })
    await fetchAssessmentMismatches(supabase, iso(SINCE), iso(CUTOFF))
    const c = calls.find(c => c.table === 'sync_log')!
    const ilike = c.ops.find(o => o[0] === 'ilike')?.[1]
    expect(ilike?.[0]).toBe('message')
    expect(ilike?.[1]).toContain('ASSESSMENT_TEAM_MISMATCH')
    // Must NOT constrain direction — the two breadcrumbs write inbound + outbound.
    const eqCols = c.ops.filter(o => o[0] === 'eq').map(o => o[1][0])
    expect(eqCols).not.toContain('direction')
  })
})

describe('collectFailureAlerts', () => {
  it('short-circuits to no work when the window has not settled yet', async () => {
    const { supabase, calls } = makeSupabase({})
    const fetchEvents = vi.fn()
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: NOW, supabase, fetchEvents: fetchEvents as any })
    expect(out.items).toEqual([])
    expect(fetchEvents).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('wires the three sources + location names through the selector', async () => {
    const { supabase } = makeSupabase({
      import_jobs: [{ location_id: 'loc_kc', error_message: 'boom', completed_at: iso(inWin) }],
      sync_log: [],
      locations: [{ location_id: 'loc_kc', name: 'Kansas City' }],
    })
    const fetchEvents = vi.fn(async () => ({
      events: [ev({ topic: 'QUOTE_UPDATE', landed: 'stuck', created_at: iso(inWin) })],
      truncated: false,
    }))
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    const kinds = out.items.map(i => i.kind).sort()
    expect(kinds).toEqual(['import_failed', 'not_landed'])
    // location name resolved from the injected locations table
    expect(out.items.every(i => i.text.includes('Kansas City'))).toBe(true)
  })
})

describe('cron route + registration pins', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/cron/failure-alerts/route.ts'), 'utf8')
  const lib = readFileSync(join(process.cwd(), 'lib/failure-alerts.ts'), 'utf8')
  const vercel = readFileSync(join(process.cwd(), 'vercel.json'), 'utf8')

  it('is CRON_SECRET fail-closed with Bearer + ?secret= accepted', () => {
    expect(route).toContain("{ error: 'cron_secret_not_configured' }, { status: 500 }")
    expect(route).toContain('`Bearer ${secret}`')
    expect(route).toContain("searchParams.get('secret')")
    expect(route).toContain("{ error: 'unauthorized' }, { status: 401 }")
  })

  it('reuses postSlackMessage + the watermark, and never writes sync_log', () => {
    expect(route).toContain('postSlackMessage(')
    expect(route).toContain('fetchLastAlertWatermark(')
    expect(route).toContain('recordAlertRun(')
    // Must not hook the never-throw write path (the doc comment names it, so
    // pin the call form, not the word).
    expect(route).not.toContain('writeSyncLog(')
    expect(lib).not.toContain('writeSyncLog(')
  })

  it('is an allowlist: never QUERIES notification_log or send_status', () => {
    // The doc comment names these as deliberately-excluded, so scope the pin to
    // actual query surfaces (.from(...) / column filters), not prose.
    expect(lib).not.toContain("from('notification_log')")
    expect(lib).not.toContain("'send_status'")
    expect(route).not.toContain("from('notification_log')")
    // The four allowlisted sources ARE queried.
    expect(lib).toContain("from('import_jobs')")
    expect(lib).toContain("from('sync_log')")
    expect(lib).toContain('ASSESSMENT_TEAM_MISMATCH')
  })

  it('vercel.json registers the every-5-minutes schedule (issue 159)', () => {
    expect(vercel).toContain('"path": "/api/cron/failure-alerts", "schedule": "*/5 * * * *"')
  })
})
