// @vitest-environment node
//
// fetchImportHealth — the import_jobs read behind the webhook digest's import
// section (item 2). Pins that it queries TWO buckets with the right filters:
//   • failed  — status='failed', completed_at within the window
//   • stalled — status='running', started_at older than the stall threshold
//               AND a null-or-stale location_claim_at
// and that the stall threshold is above the sweeper's 2-min re-poke cutoff so
// normal between-segment handoffs are never reported as stalls.
import { describe, it, expect, vi } from 'vitest'

// import-health imports supabaseService at module load (createClient needs env
// we don't set here). Every test injects its own supabase, so stub the module.
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import {
  fetchImportHealth,
  IMPORT_DIGEST_STALL_MS,
  IMPORT_DIGEST_WINDOW_MS,
} from '@/lib/import-health'

// A chainable query mock: records every filter op, returns per-status data on
// the terminal .limit(). Each .from() starts a fresh builder.
function makeSupabase(byStatus: Record<string, any[]>) {
  const calls: Array<{ ops: [string, any[]][]; status?: string }> = []
  const supabase: any = {
    from() {
      const rec: { ops: [string, any[]][]; status?: string } = { ops: [] }
      calls.push(rec)
      const b: any = {}
      for (const m of ['select', 'eq', 'gte', 'lt', 'or', 'order']) {
        b[m] = (...args: any[]) => {
          rec.ops.push([m, args])
          if (m === 'eq' && args[0] === 'status') rec.status = args[1]
          return b
        }
      }
      b.limit = (...args: any[]) => {
        rec.ops.push(['limit', args])
        return Promise.resolve({ data: byStatus[rec.status || ''] ?? [], error: null })
      }
      return b
    },
  }
  return { supabase, calls }
}

const NOW = Date.parse('2026-07-18T12:00:00Z')

describe('fetchImportHealth', () => {
  it('returns the failed + stalled buckets', async () => {
    const { supabase } = makeSupabase({
      failed: [{ location_id: 'loc_a', status: 'failed' }],
      running: [{ location_id: 'loc_b', status: 'running' }, { location_id: 'loc_c', status: 'running' }],
    })
    const out = await fetchImportHealth({ nowMs: NOW, supabase })
    expect(out.failed).toHaveLength(1)
    expect(out.stalled).toHaveLength(2)
  })

  it('filters failed by status + completed_at within the window', async () => {
    const { supabase, calls } = makeSupabase({ failed: [], running: [] })
    await fetchImportHealth({ nowMs: NOW, supabase })
    const failedCall = calls.find((c) => c.status === 'failed')!
    const gte = failedCall.ops.find((o) => o[0] === 'gte')
    expect(gte?.[1][0]).toBe('completed_at')
    expect(gte?.[1][1]).toBe(new Date(NOW - IMPORT_DIGEST_WINDOW_MS).toISOString())
  })

  it('filters stalled by started_at older than the stall threshold + null-or-stale claim', async () => {
    const { supabase, calls } = makeSupabase({ failed: [], running: [] })
    await fetchImportHealth({ nowMs: NOW, supabase })
    const runningCall = calls.find((c) => c.status === 'running')!
    const lt = runningCall.ops.find((o) => o[0] === 'lt')
    expect(lt?.[1][0]).toBe('started_at')
    const orClause = runningCall.ops.find((o) => o[0] === 'or')?.[1]?.[0] ?? ''
    expect(orClause).toContain('location_claim_at.is.null')
    expect(orClause).toContain('location_claim_at.lt.')
  })

  it('the stall threshold is well above the sweeper 2-min re-poke cutoff', () => {
    // Normal handoffs (~2min) must never read as a digest stall.
    expect(IMPORT_DIGEST_STALL_MS).toBeGreaterThan(2 * 60 * 1000)
  })

  // ── continuation bounces (the leading indicator of a stall) ────
  // Recorded by recordContinuationAttempt as sync_log rows with
  // entity_type='location' + status='error'. The mock keys its data off the
  // .eq('status', …) filter, so these rows come back under 'error'.
  const bounce = (loc: string, outcome: string, job = 'job-1') => ({
    location_id: loc,
    message: `[continuation] source=sweeper outcome=${outcome} job=${job} status=0 — blocked by a redirect`,
    created_at: new Date(NOW - 60_000).toISOString(),
  })

  it('aggregates failed continuation attempts per location', async () => {
    const { supabase } = makeSupabase({
      failed: [], running: [],
      error: [bounce('loc_kc', 'bounced'), bounce('loc_kc', 'bounced'), bounce('loc_kc', 'no_claim'), bounce('loc_pdx', 'errored')],
    })
    const out = await fetchImportHealth({ nowMs: NOW, supabase })
    expect(out.bounced).toHaveLength(2)
    // Busiest location first.
    expect(out.bounced[0]).toMatchObject({ location_id: 'loc_kc', count: 3 })
    expect(out.bounced[0].outcomes).toContain('bounced×2')
    expect(out.bounced[0].outcomes).toContain('no_claim×1')
    expect(out.bounced[1]).toMatchObject({ location_id: 'loc_pdx', count: 1 })
  })

  it('ignores non-continuation sync_log rows sharing the same scope', async () => {
    const { supabase } = makeSupabase({
      failed: [], running: [],
      error: [
        { location_id: 'loc_kc', message: 'Leads: 3 created; Errors: 2', created_at: new Date(NOW).toISOString() },
        bounce('loc_kc', 'bounced'),
      ],
    })
    const out = await fetchImportHealth({ nowMs: NOW, supabase })
    expect(out.bounced).toEqual([expect.objectContaining({ location_id: 'loc_kc', count: 1 })])
  })

  it('a landed attempt is never reported as a bounce', async () => {
    const { supabase } = makeSupabase({
      failed: [], running: [], error: [bounce('loc_kc', 'landed')],
    })
    expect((await fetchImportHealth({ nowMs: NOW, supabase })).bounced).toEqual([])
  })

  it('reads continuation rows scoped to entity_type=location within the window', async () => {
    const { supabase, calls } = makeSupabase({ failed: [], running: [], error: [] })
    await fetchImportHealth({ nowMs: NOW, supabase })
    const bounceCall = calls.find((c) => c.status === 'error')!
    const eqCols = bounceCall.ops.filter((o) => o[0] === 'eq').map((o) => o[1])
    expect(eqCols).toEqual(expect.arrayContaining([['entity_type', 'location'], ['status', 'error']]))
    const gte = bounceCall.ops.find((o) => o[0] === 'gte')
    expect(gte?.[1][1]).toBe(new Date(NOW - IMPORT_DIGEST_WINDOW_MS).toISOString())
  })
})
