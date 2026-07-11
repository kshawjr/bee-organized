// @vitest-environment node
// upsertAssessment — webhook-race idempotency (the Chelsea Atkins
// dupe snowball). Pins:
//   — writes via .upsert with onConflict:'service_request_id'
//     (DB-level idempotent; arbiter assessments_service_request_id_idx),
//     NOT check-then-insert
//   — a simulated concurrent double-call for the same
//     service_request_id lands ONE row, not two
//   — the pre-select's error is no longer silently discarded
//     (PGRST116 must throw, not read as "no rows")
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock supabaseService: in-memory assessments table with REAL
//    unique-key semantics on service_request_id. .upsert merges on the
//    key (like the prod unique index arbiter); .insert appends blindly
//    (like the pre-index table) — so these tests distinguish an
//    idempotent upsert from the old racy check-then-insert.
const h = vi.hoisted(() => {
  const state = {
    rows: [] as any[],
    nextId: 1,
    selectError: null as any,
    upserts: [] as { payload: any; opts: any }[],
    inserts: [] as any[],
  }
  const reset = () => {
    state.rows = []; state.nextId = 1; state.selectError = null
    state.upserts = []; state.inserts = []
  }
  const makeBuilder = (table: string) => {
    if (table !== 'assessments') {
      const noop: any = {}
      for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'order', 'limit']) {
        noop[m] = () => noop
      }
      noop.maybeSingle = () => Promise.resolve({ data: null, error: null })
      noop.single = () => Promise.resolve({ data: null, error: null })
      noop.then = (res: any) => Promise.resolve({ data: null, error: null }).then(res)
      return noop
    }
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select'
    let filterKey: string | null = null
    let filterVal: any = null
    let written: any = null
    const b: any = {}
    b.select = () => b
    b.eq = (k: string, v: any) => { filterKey = k; filterVal = v; return b }
    b.insert = (payload: any) => {
      mode = 'insert'
      state.inserts.push(payload)
      written = { id: `a-${state.nextId++}`, ...payload }
      state.rows.push(written)
      return b
    }
    b.update = (payload: any) => {
      mode = 'update'
      written = payload
      return b
    }
    b.upsert = (payload: any, opts: any) => {
      mode = 'upsert'
      state.upserts.push({ payload, opts })
      const key = opts?.onConflict
      const hit = key ? state.rows.find(r => r[key] === payload[key]) : undefined
      if (hit) {
        Object.assign(hit, payload)
        written = hit
      } else {
        written = { id: `a-${state.nextId++}`, ...payload }
        state.rows.push(written)
      }
      return b
    }
    b.maybeSingle = () => {
      if (state.selectError) return Promise.resolve({ data: null, error: state.selectError })
      const hits = state.rows.filter(r => r[filterKey!] === filterVal)
      if (hits.length > 1) {
        // What prod PostgREST does on duplicate rows — the discarded
        // error that turned dupes into a snowball.
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
        })
      }
      return Promise.resolve({ data: hits[0] ?? null, error: null })
    }
    b.single = () => Promise.resolve(
      mode === 'update'
        ? { data: written, error: null }
        : { data: written ? { id: written.id } : null, error: written ? null : { message: 'no row' } },
    )
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

import { upsertAssessment } from '@/lib/jobber-import'

// Request/Assessment ids are Jobber EncodedIds (base64 gid); upsert
// stores the extracted numeric. gid://Jobber/Request/99 and
// gid://Jobber/Assessment/424242 below.
const REQUEST = {
  id: 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvOTk=',
  assessment: { id: 'Z2lkOi8vSm9iYmVyL0Fzc2Vzc21lbnQvNDI0MjQy', startAt: '2026-07-17T22:30:00+00:00' },
}
const call = () => upsertAssessment(REQUEST, 'sr-1', 'lead-1', 'loc-1')

beforeEach(() => h.reset())

describe('upsertAssessment idempotency', () => {
  it('writes via upsert with onConflict service_request_id, never bare insert', async () => {
    const res = await call()
    expect(res.created).toBe(true)
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.upserts).toHaveLength(1)
    expect(h.state.upserts[0].opts).toMatchObject({ onConflict: 'service_request_id' })
    expect(h.state.upserts[0].payload.service_request_id).toBe('sr-1')
  })

  it('captures the appointment id from request.assessment.id (numeric)', async () => {
    // The bug: assessments landed with null jobber_assessment_id, so the
    // engagement-assignee sync had no appointment to target (assessment=none).
    await call()
    expect(h.state.upserts).toHaveLength(1)
    expect(h.state.upserts[0].payload.jobber_assessment_id).toBe('424242')
    expect(h.state.rows[0].jobber_assessment_id).toBe('424242')
  })

  it('an id-less assessment payload does not write jobber_assessment_id (never nulls a good id on re-sync)', async () => {
    const res = await upsertAssessment(
      { id: REQUEST.id, assessment: { startAt: '2026-07-17T22:30:00+00:00' } },
      'sr-2', 'lead-1', 'loc-1',
    )
    expect(res.created).toBe(true)
    expect('jobber_assessment_id' in h.state.upserts[0].payload).toBe(false)
  })

  it('concurrent double-call for the same service_request_id lands ONE row', async () => {
    // Both calls pre-select before either writes — the exact webhook
    // race. Check-then-insert would insert twice; onConflict merges.
    const [a, b] = await Promise.all([call(), call()])
    expect(h.state.rows).toHaveLength(1)
    expect(a.id).toBe(h.state.rows[0].id)
    expect(b.id).toBe(h.state.rows[0].id)
  })

  it('sequential re-sync updates the existing row and reports created:false', async () => {
    const first = await call()
    const second = await call()
    expect(h.state.rows).toHaveLength(1)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.id).toBe(first.id)
  })

  it('pre-select error (PGRST116) throws instead of reading as "no rows"', async () => {
    h.state.selectError = { code: 'PGRST116', message: 'multiple (or no) rows returned' }
    await expect(call()).rejects.toThrow(/Assessment lookup: .*multiple/)
    // The old code discarded this error and inserted another dupe.
    expect(h.state.rows).toHaveLength(0)
  })

  it('regression shape: pre-seeded duplicate rows throw loudly rather than snowballing', async () => {
    // Simulates the pre-cleanup table state: two rows already share the
    // key. maybeSingle returns PGRST116; the call must fail, not add a third.
    h.state.rows.push(
      { id: 'a-old-1', service_request_id: 'sr-1' },
      { id: 'a-old-2', service_request_id: 'sr-1' },
    )
    await expect(call()).rejects.toThrow(/Assessment lookup:/)
    expect(h.state.rows).toHaveLength(2)
  })
})

describe('upsertAssessment completion mapping (isComplete/completedAt)', () => {
  const completeReq = {
    id: REQUEST.id,
    assessment: {
      ...REQUEST.assessment,
      isComplete: true,
      completedAt: '2026-04-09T18:00:00+00:00',
    },
  }
  const incompleteReq = {
    id: REQUEST.id,
    assessment: { ...REQUEST.assessment, isComplete: false, completedAt: null },
  }

  it('isComplete:true → status:completed + completed_at from completedAt', async () => {
    await upsertAssessment(completeReq, 'sr-c', 'lead-1', 'loc-1')
    const p = h.state.upserts[0].payload
    expect(p.status).toBe('completed')
    expect(p.completed_at).toBe('2026-04-09T18:00:00+00:00')
  })

  it('isComplete:false → status:scheduled + completed_at:null', async () => {
    await upsertAssessment(incompleteReq, 'sr-i', 'lead-1', 'loc-1')
    const p = h.state.upserts[0].payload
    expect(p.status).toBe('scheduled')
    expect(p.completed_at).toBeNull()
  })

  it('isComplete:true with null completedAt → status:completed, completed_at:null (no bad date)', async () => {
    await upsertAssessment(
      { id: REQUEST.id, assessment: { ...REQUEST.assessment, isComplete: true, completedAt: null } },
      'sr-cn', 'lead-1', 'loc-1',
    )
    const p = h.state.upserts[0].payload
    expect(p.status).toBe('completed')
    expect(p.completed_at).toBeNull()
  })

  it('guard: malformed payload (no isComplete boolean) never writes completed_at — keeps scheduled default, cannot null a recorded completion on re-sync', async () => {
    // REQUEST has no isComplete → else branch: status default 'scheduled',
    // completed_at omitted entirely (preserved on update, not nulled).
    await call()
    const p = h.state.upserts[0].payload
    expect(p.status).toBe('scheduled')
    expect('completed_at' in p).toBe(false)
  })

  it('re-sync from complete→incomplete flips both back (Jobber un-complete is honored)', async () => {
    await upsertAssessment(completeReq, 'sr-flip', 'lead-1', 'loc-1')
    await upsertAssessment(
      { id: REQUEST.id, assessment: { ...REQUEST.assessment, isComplete: false, completedAt: null } },
      'sr-flip', 'lead-1', 'loc-1',
    )
    expect(h.state.rows).toHaveLength(1)
    expect(h.state.rows[0].status).toBe('scheduled')
    expect(h.state.rows[0].completed_at).toBeNull()
  })
})
