// @vitest-environment node
//
// In-person vs virtual (migrations/assessment_type.sql). Pins:
//   1. the send screen's starting choice: client's own → location default → in-person
//   2. Jobber's instructions: virtual sends the exact note, in-person sends nothing
//   3. THE COPY-BACK RULE: the Jobber import/webhook (upsertAssessment) never
//      writes assessments.assessment_type, so a re-sync can't wipe a recorded
//      choice — proven by running the real upsert against an in-memory table,
//      in both orders (send first / webhook first)
//   4. source wiring: send route, settings route, page load
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// ── in-memory assessments table with the prod unique key (service_request_id)
const h = vi.hoisted(() => {
  const state = { rows: [] as any[], nextId: 1, upsertPayloads: [] as any[] }
  const builder = (table: string) => {
    if (table !== 'assessments') throw new Error(`unexpected table ${table}`)
    let mode: 'select' | 'upsert' | 'update' = 'select'
    let filter: [string, any] | null = null
    let written: any = null
    let patch: any = null
    const b: any = {}
    b.select = () => b
    b.eq = (k: string, v: any) => { filter = [k, v]; return b }
    b.maybeSingle = () => {
      const hit = state.rows.find(r => filter && r[filter[0]] === filter[1])
      return Promise.resolve({ data: hit ? { id: hit.id } : null, error: null })
    }
    b.upsert = (payload: any, opts: any) => {
      mode = 'upsert'
      state.upsertPayloads.push(payload)
      const key = opts.onConflict
      const hit = state.rows.find(r => r[key] === payload[key])
      if (hit) { Object.assign(hit, payload); written = hit }
      else { written = { id: `a-${state.nextId++}`, ...payload }; state.rows.push(written) }
      return b
    }
    b.single = () => Promise.resolve({ data: { id: written.id }, error: null })
    b.update = (p: any) => { mode = 'update'; patch = p; return b }
    b.then = (res: any, rej: any) => {
      if (mode === 'update' && filter) {
        for (const r of state.rows) if (r[filter[0]] === filter[1]) Object.assign(r, patch)
      }
      return Promise.resolve({ data: null, error: null }).then(res, rej)
    }
    return b
  }
  return { state, client: { from: builder } }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: h.client }))
vi.mock('./supabase-service', () => ({ supabaseService: h.client }))
// The SR upsert has its own tests; here it only has to hand back the row id
// the webhook would also resolve for this request.
vi.mock('@/lib/jobber-import', async (orig) => ({
  ...(await orig<any>()),
  upsertServiceRequest: vi.fn(async () => ({ id: 'sr-1' })),
}))

import { resolveAssessmentType, assessmentInstructions, VIRTUAL_ASSESSMENT_INSTRUCTIONS, isAssessmentType } from './assessment-type'
import { upsertAssessment } from '@/lib/jobber-import'
import { recordSentAssessmentType } from './assessment-type-record'

beforeEach(() => { h.state.rows = []; h.state.nextId = 1; h.state.upsertPayloads = [] })

describe('the send screen starting choice', () => {
  it('client’s own type wins over the location default', () => {
    expect(resolveAssessmentType('virtual', 'in-person')).toBe('virtual')
    expect(resolveAssessmentType('in-person', 'virtual')).toBe('in-person')
  })
  it('no client type → the location default', () => {
    expect(resolveAssessmentType(null, 'virtual')).toBe('virtual')
    expect(resolveAssessmentType(undefined, 'in-person')).toBe('in-person')
  })
  it('neither → in-person', () => {
    expect(resolveAssessmentType(null, null)).toBe('in-person')
  })
  it('junk values are skipped, never shown', () => {
    expect(resolveAssessmentType('Virtual', 'zoom')).toBe('in-person')
    expect(resolveAssessmentType('', 'virtual')).toBe('virtual')
    expect(isAssessmentType('in_person')).toBe(false)
  })
})

describe('what Jobber receives', () => {
  it('virtual → exactly "Virtual assessment — no site visit required."', () => {
    expect(VIRTUAL_ASSESSMENT_INSTRUCTIONS).toBe('Virtual assessment — no site visit required.')
    expect(assessmentInstructions('virtual')).toBe(VIRTUAL_ASSESSMENT_INSTRUCTIONS)
  })
  it('in-person, or no type → nothing', () => {
    expect(assessmentInstructions('in-person')).toBeUndefined()
    expect(assessmentInstructions(undefined)).toBeUndefined()
  })
})

// A full webhook-shaped request, as REQUESTS_QUERY / SINGLE_REQUEST_QUERY return it.
const webhookRequest = {
  id: 'Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMTIz',      // Request/123
  assessment: {
    id: 'Z2lkOi8vSm9iYmVyL0Fzc2Vzc21lbnQvNDU2',  // Assessment/456
    startAt: '2026-10-20T14:00:00Z',
    isComplete: false,
    completedAt: null,
    duration: 60,
  },
}
const send = (type: string) => recordSentAssessmentType({
  assessmentType: type,
  requestRec: { id: webhookRequest.id, title: 'Sofia', client: { id: 'c' }, property: null },
  jobberAssessmentGlobalId: webhookRequest.assessment.id,
  startAtIso: '2026-10-20T14:00:00.000Z',
  leadId: 'lead-1',
  locationSlug: 'loc_seattle',
})

describe('the webhook copy-back leaves assessment_type alone', () => {
  it('upsertAssessment’s payload never carries assessment_type', async () => {
    await upsertAssessment(webhookRequest, 'sr-1', 'lead-1', 'loc_seattle')
    expect(h.state.upsertPayloads).toHaveLength(1)
    expect(Object.keys(h.state.upsertPayloads[0])).not.toContain('assessment_type')
  })

  it('send first, webhook after: the recorded type survives the re-sync', async () => {
    const r = await send('virtual')
    expect(r.ok).toBe(true)
    expect(h.state.rows).toHaveLength(1)
    expect(h.state.rows[0].assessment_type).toBe('virtual')

    await upsertAssessment(webhookRequest, 'sr-1', 'lead-1', 'loc_seattle')
    await upsertAssessment(webhookRequest, 'sr-1', 'lead-1', 'loc_seattle')   // a re-delivery
    expect(h.state.rows).toHaveLength(1)
    expect(h.state.rows[0].assessment_type).toBe('virtual')
    expect(h.state.rows[0].duration_minutes).toBe(60)                         // webhook did its job
  })

  it('webhook first, send after: one row, carrying the type', async () => {
    await upsertAssessment(webhookRequest, 'sr-1', 'lead-1', 'loc_seattle')
    const r = await send('in-person')
    expect(r.ok).toBe(true)
    expect(h.state.rows).toHaveLength(1)
    expect(h.state.rows[0].assessment_type).toBe('in-person')
    expect(h.state.rows[0].jobber_assessment_id).toBe('456')
  })

  it('a send with no type records nothing', async () => {
    const r = await recordSentAssessmentType({
      assessmentType: undefined, requestRec: { id: webhookRequest.id },
      jobberAssessmentGlobalId: webhookRequest.assessment.id, startAtIso: 'x',
      leadId: 'lead-1', locationSlug: 'loc_seattle',
    })
    expect(r.ok).toBe(false)
    expect(h.state.rows).toHaveLength(0)
  })

  it('source: no Jobber import/webhook path writes assessment_type', () => {
    for (const f of ['lib/jobber-import.ts', 'lib/jobber-webhook-handlers.ts', 'app/api/import/jobber-clients/route.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toContain('assessment_type')
    }
  })
})

describe('wiring', () => {
  const route = readFileSync('app/api/leads/[id]/send-to-jobber/route.ts', 'utf8')
  it('send route: instructions only when there are some (in-person input unchanged)', () => {
    expect(route).toContain('...(assessmentInstructions(assessment_type)')
    expect(route).toContain('? { instructions: assessmentInstructions(assessment_type) }')
    expect(route).toContain(': {}),')
  })
  it('send route: records the type, non-fatal, reusing a pre-written SR', () => {
    expect(route).toContain('recordSentAssessmentType({')
    expect(route).toContain('serviceRequestId: preWrittenSrId')
    expect(route).toContain('topic=ASSESSMENT_TYPE_NOT_RECORDED')
  })
  it('send route: virtual keeps the property on the client, never on the request', () => {
    expect(route).toContain("creation_type === 'request_with_assessment' && assessment_type === 'virtual'")
    expect(route).toContain('if (jobberPropertyGlobalId && !isVirtualAssessment) requestInput.propertyId = jobberPropertyGlobalId')
    // the property step itself is untouched: still created/reused when there is an address
    expect(route).toContain('if (address) {')
  })
  it('settings route: accepts only in-person / virtual', () => {
    const loc = readFileSync('app/api/locations/[id]/route.ts', 'utf8')
    expect(loc).toContain("if (!isAssessmentType(v))")
    expect(loc).toContain('patch.default_assessment_type = v')
  })
  it('page load reads the default error-tolerantly for both owner and corporate', () => {
    const page = readFileSync('app/_hub-page.tsx', 'utf8')
    expect(page).toContain('default_assessment_type: currentAssessmentDefault')
    expect(page).toContain("assessmentType: assessmentDefaultById[row.id] || 'in-person'")
    // never in the main location selects — a missing column must not break the page
    const mainSelects = page.match(/'id, name, [^']*'/g) || []
    for (const sel of mainSelects) expect(sel).not.toContain('default_assessment_type')
  })
})
