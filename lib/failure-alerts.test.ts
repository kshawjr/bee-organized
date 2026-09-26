// @vitest-environment node
//
// Instant failure alerts (issue 159, rebuilt Sept 2026) — the ~5-min
// watermark cron. What these tests pin:
//
//   1) Each ALLOWLISTED signal fires: a failed website lead, a Jobber
//      RECONNECT REQUIRED stamp, import_jobs failed, ASSESSMENT_TEAM_MISMATCH.
//   2) The watermark advances and does NOT re-alert: an item alerted in one
//      window is gone from the next (its ts is at-or-before the new since).
//   3) NON-allowlisted noise stays silent: ANY individual token failure
//      (healed or not), not_landed rows (a daily line now), a raw
//      status='error' non-token failure, and a user-cancelled import.
//   4) A quiet window posts NOTHING (buildAlertMessages → []).
//   5) The settle: a failed lead newer than now-5min waits for its window.
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
  buildAlertMessages,
  collectFailureAlerts,
  MAX_ALERT_MESSAGES,
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
  it('a failed LEAD_INTAKE row → a "lead didn\'t arrive" alert', () => {
    const items = selectNewAlerts({
      ...base,
      events: [ev({ topic: 'LEAD_INTAKE', processed: false, landed: null, location_id: null, jobber_item: null, error: 'full_name required email_present=true', reason: 'full_name required email_present=true' })],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('lead_failed')
    expect(items[0].text).toContain("didn't arrive")
    expect(items[0].text).toContain('full_name required')
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

  it('a RECONNECT REQUIRED stamp in the window → a "Jobber disconnected" alert', () => {
    const items = selectNewAlerts({
      ...base,
      reconnects: [{ location_id: 'loc_kc', stamped_at: iso(inWin) }],
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('reconnect_required')
    expect(items[0].text).toContain('Jobber disconnected')
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
  it('a sync_log not_landed row does NOT fire — it is a daily "never landed" line now', () => {
    const items = selectNewAlerts({
      ...base,
      events: [ev({ topic: 'PROPERTY_UPDATE', friendly: 'Property updated', landed: 'stuck' })],
    })
    expect(items).toEqual([])
  })

  it('an un-healed reauth failure with no RECONNECT stamp does NOT fire', () => {
    const items = selectNewAlerts({
      ...base,
      events: [ev({ topic: 'QUOTE_UPDATE', processed: false, landed: null, error: 'reauth required', reason: 'reauth', jobber_item: '999' })],
    })
    expect(items).toEqual([])
  })

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
    expect(buildAlertMessages([])).toEqual([])
  })
})

describe('selectNewAlerts — settle: a not-yet-settled row waits', () => {
  // The same failed lead (11:57) under two windows. The gate is the CUTOFF,
  // not the wall clock: it fires only once its window commits past it.
  const failAt = NOW - 3 * MIN // 11:57
  const lead = () => [ev({ topic: 'LEAD_INTAKE', processed: false, landed: null, location_id: null, jobber_item: null, error: 'location_slug required', reason: 'location_slug required', created_at: iso(failAt) })]

  it('does NOT fire while the row is newer than the cutoff (still settling)', () => {
    const items = selectNewAlerts({
      ...base,
      sinceMs: NOW - 4 * MIN,
      cutoffMs: NOW - 4 * MIN + 30_000,
      nowMs: NOW,
      events: lead(),
    })
    expect(items).toEqual([])
  })

  it('DOES fire once its window commits past the row', () => {
    const items = selectNewAlerts({
      ...base,
      sinceMs: NOW - 4 * MIN,
      cutoffMs: NOW,
      nowMs: NOW + 5 * MIN,
      events: lead(),
    })
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('lead_failed')
  })
})

describe('watermark advances and does not re-alert', () => {
  it('an item alerted in one window is absent from the next window', () => {
    const stuck = ev({ topic: 'LEAD_INTAKE', processed: false, landed: null, location_id: null, jobber_item: null, reason: 'full_name required', created_at: iso(inWin) })

    // Run 1: window (SINCE, CUTOFF] contains the 11:52 event → fires.
    const run1 = selectNewAlerts({ ...base, events: [stuck], sinceMs: SINCE, cutoffMs: CUTOFF, nowMs: NOW })
    expect(run1).toHaveLength(1)

    // Run 2: watermark advanced to CUTOFF; new window (CUTOFF, NOW]. Same data,
    // but 11:52 ≤ CUTOFF (the new `since`) → excluded. No re-alert.
    const run2 = selectNewAlerts({ ...base, events: [stuck], sinceMs: CUTOFF, cutoffMs: NOW, nowMs: NOW + 5 * MIN })
    expect(run2).toEqual([])
  })
})

describe('buildAlertMessages — one message per problem', () => {
  const item = (over: Partial<AlertItem>): AlertItem => ({ kind: 'lead_failed', ts: inWin, text: 'x', ...over })

  it('renders each item as its own message with its icon', () => {
    const msgs = buildAlertMessages([
      item({ kind: 'lead_failed', text: "A website lead didn't arrive" }),
      item({ kind: 'import_failed', text: 'Import failed — B: boom' }),
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[0].text).toBe(":inbox_tray: A website lead didn't arrive")
    expect(msgs[1].text).toBe(':x: Import failed — B: boom')
  })

  it('past the cap, the rest go into ONE summary message instead of flooding', () => {
    const many = Array.from({ length: MAX_ALERT_MESSAGES + 3 }, (_, i) => item({ text: `lead ${i}` }))
    const msgs = buildAlertMessages(many)
    expect(msgs).toHaveLength(MAX_ALERT_MESSAGES + 1)
    expect(msgs.at(-1)!.text).toContain('…and 3 more problems')
    expect(msgs.at(-1)!.items).toHaveLength(3)
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
      for (const m of ['select', 'eq', 'gt', 'gte', 'lte', 'lt', 'ilike', 'not', 'or', 'order', 'limit', 'is', 'in']) {
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

  it('wires the sources + location directory through the selector', async () => {
    const { supabase } = makeSupabase({
      import_jobs: [{ location_id: 'loc_kc', error_message: 'boom', completed_at: iso(inWin) }],
      sync_log: [],
      locations: [{
        location_id: 'loc_kc', name: 'Kansas City',
        last_sync_status: `RECONNECT REQUIRED — Jobber rejected refresh token (401) @ ${iso(inWin).slice(0, 19)}`,
      }],
    })
    const fetchEvents = vi.fn(async () => ({
      events: [ev({ topic: 'QUOTE_UPDATE', landed: 'stuck', created_at: iso(inWin) })],
      truncated: false,
    }))
    const out = await collectFailureAlerts({ nowMs: NOW, sinceMs: SINCE, supabase, fetchEvents: fetchEvents as any })
    const kinds = out.items.map(i => i.kind).sort()
    expect(kinds).toEqual(['import_failed', 'reconnect_required'])
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

  it('is an allowlist: notification_log is never read (Slack channel failures are the owner\'s fix)', () => {
    // The Sept 2026 rebuild closed the one notification_log slice the
    // silent-sends rail had opened (channel='slack' failed): every such row is
    // an owner's private channel, which Kevin cannot fix.
    expect(lib).not.toContain("from('notification_log')")
    expect(route).not.toContain("from('notification_log')")
    // The original allowlisted sources ARE still queried.
    expect(lib).toContain("from('import_jobs')")
    expect(lib).toContain("from('sync_log')")
    expect(lib).toContain('ASSESSMENT_TEAM_MISMATCH')
  })

  it('vercel.json registers the every-5-minutes schedule (issue 159)', () => {
    expect(vercel).toContain('"path": "/api/cron/failure-alerts", "schedule": "*/5 * * * *"')
  })
})
