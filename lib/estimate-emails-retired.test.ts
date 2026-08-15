// @vitest-environment node
//
// Issue 240 — the Estimate Sent follow-ups are retired.
//
// Entering 'Estimate Sent' used to queue four templates:
//   opp_organizing_estimate_3d / _30d, opp_moving_estimate_3d / _30d
// Jobber sends its own estimate follow-ups, so a client got both. 67 of
// ours had already gone out when this was cut.
//
// Worth recording why this file exists at all: when the scheduling branch
// was removed, the full suite stayed green. Nothing had ever asserted that
// Estimate Sent schedules anything — the only scheduleStageEmails test used
// 'Closed Won'. A behaviour that sent real client email was invisible to the
// suite in both directions, so its removal needs pinning as much as its
// presence did.
//
// Pinned here:
//   1) Estimate Sent queues nothing, for either drip category
//   2) Closed Won still queues 3mo + 12mo, at 90 and 365 days
//   3) the four estimate keys stay CANCELLABLE — cancelStageEmails must
//      still reach pending rows written before the retirement
//   4) leaving Estimate Sent still cancels, so a lead that moves on does
//      not strand rows
//   5) Closed Won → Estimate Sent still does NOT cancel the 3mo/12mo rows
//      (the deliberate non-change to 220 scheduled emails)
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/resend', () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn() }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn() }))
vi.mock('@/lib/zoho', () => ({ zohoUpdate: vi.fn(), getZohoToken: vi.fn() }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn() }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))

import { scheduleStageEmails, cancelStageEmails } from '@/lib/stage-emails'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'

const ESTIMATE_KEYS = [
  'opp_organizing_estimate_3d',
  'opp_organizing_estimate_30d',
  'opp_moving_estimate_3d',
  'opp_moving_estimate_30d',
]

// Every row this run tried to queue into scheduled_stage_emails.
const upsertedRows = (): any[] =>
  h.state.calls
    .filter(c => c.table === 'scheduled_stage_emails')
    .flatMap(c => c.ops.filter(([m]) => m === 'upsert').flatMap(([, args]) => args[0] ?? []))

const updatedTables = (t: string) =>
  h.state.calls.filter(c => c.table === t && c.ops.some(([m]) => m === 'update'))

// scheduleStageEmails reads leads.marketing_opt_out first.
const notOptedOut = () => h.enqueue('leads', { marketing_opt_out: false })

beforeEach(() => h.reset())

describe('Estimate Sent schedules nothing (issue 240)', () => {
  it('queues no rows for an organizing lead', async () => {
    notOptedOut()
    await scheduleStageEmails({
      leadId: 'lead-1', newStage: 'Estimate Sent', projectType: 'Home or Office Organizing',
    })
    expect(upsertedRows()).toEqual([])
  })

  it('queues no rows for a moving lead', async () => {
    notOptedOut()
    await scheduleStageEmails({
      leadId: 'lead-1', newStage: 'Estimate Sent', projectType: 'Moving/Relocation',
    })
    expect(upsertedRows()).toEqual([])
  })

  it('queues no rows for an unrecognized project type either', async () => {
    // 'Client' is a real production value (53 leads) that matches no lookups
    // row. It used to fall through to the organizing follow-ups.
    notOptedOut()
    await scheduleStageEmails({ leadId: 'lead-1', newStage: 'Estimate Sent', projectType: 'Client' })
    expect(upsertedRows()).toEqual([])
  })

  it('never emits an estimate key from any stage', async () => {
    for (const stage of ['Estimate Sent', 'Closed Won', 'New', 'Nurturing']) {
      h.reset()
      notOptedOut()
      await scheduleStageEmails({ leadId: 'lead-1', newStage: stage, projectType: 'Moving/Relocation' })
      const keys = upsertedRows().map(r => r.stage_email_key)
      expect(keys.filter(k => ESTIMATE_KEYS.includes(k)), `stage='${stage}'`).toEqual([])
    }
  })
})

describe('Closed Won is untouched', () => {
  it('still queues 3mo + 12mo at 90 and 365 days', async () => {
    notOptedOut()
    const before = Date.now()
    await scheduleStageEmails({ leadId: 'lead-1', newStage: 'Closed Won', projectType: null })
    const rows = upsertedRows()
    expect(rows.map(r => r.stage_email_key)).toEqual(['opp_closed_job_3mo', 'opp_closed_job_12mo'])

    const days = (iso: string) => Math.round((new Date(iso).getTime() - before) / 86_400_000)
    expect(days(rows[0].send_at)).toBe(90)
    expect(days(rows[1].send_at)).toBe(365)
    // Re-entry must clear a prior cancellation — the upsert relies on it.
    expect(rows.every(r => r.cancelled_at === null && r.sent_at === null)).toBe(true)
  })
})

describe('pending estimate rows stay reachable', () => {
  it('cancelStageEmails still targets every pending row for the lead', async () => {
    // The retirement removes the WRITER, not the reader. Rows written before
    // it must still be cancellable, or the sweep cannot clear them.
    await cancelStageEmails({ leadId: 'lead-1', reason: 'manual' })
    const [call] = updatedTables('scheduled_stage_emails')
    expect(call, 'an update on scheduled_stage_emails').toBeTruthy()
    const [payload] = call.ops.find(([m]) => m === 'update')![1]
    expect(payload.cancelled_reason).toBe('manual')
    expect(payload.cancelled_at).toBeTruthy()
    // Scoped to the lead and to rows that are neither sent nor already cancelled.
    expect(call.ops.some(([m, a]) => m === 'eq' && a[0] === 'lead_id')).toBe(true)
    expect(call.ops.filter(([m]) => m === 'is').map(([, a]) => a[0]).sort())
      .toEqual(['cancelled_at', 'sent_at'])
  })
})

describe('lifecycle transitions around Estimate Sent', () => {
  const sideEffects = (prevStage: string | null, stage: string) =>
    applyDripSideEffects({ leadId: 'lead-1', locationUuid: 'loc-1', prevStage, patch: { stage } })

  it('entering Estimate Sent schedules nothing and cancels nothing', async () => {
    await sideEffects('Attempting', 'Estimate Sent')
    expect(upsertedRows()).toEqual([])
    expect(updatedTables('scheduled_stage_emails')).toEqual([])
  })

  it('Closed Won -> Estimate Sent still does NOT cancel the 3mo/12mo rows', async () => {
    // Estimate Sent stays in STAGE_EMAIL_TRIGGER_STAGES precisely so this
    // stays true. Dropping it would newly cancel 220 scheduled emails.
    await sideEffects('Closed Won', 'Estimate Sent')
    expect(updatedTables('scheduled_stage_emails')).toEqual([])
  })

  it('leaving Estimate Sent for a non-trigger stage still cancels', async () => {
    await sideEffects('Estimate Sent', 'Nurturing')
    expect(updatedTables('scheduled_stage_emails').length).toBeGreaterThan(0)
  })
})
