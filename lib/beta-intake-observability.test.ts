// @vitest-environment node
// /api/leads/intake — sync_log observability + email-or-phone policy.
//
// OBSERVABILITY: every AUTHENTICATED outcome writes a sync_log row
// (direction='inbound', entity_type='client', message prefixed
// '[intake] topic=LEAD_INTAKE …' — the topic token is what lets
// fetchWebhookLogEvents keep the row for the Webhooks tab + Slack
// digest). 401s write NOTHING (mirrors the Jobber signature-invalid
// exception). sync_log.location_id carries the location SLUG — that's
// what the dashboard joins location names on.
//
// EMAIL-OR-PHONE: full_name + (valid email OR phone with ≥7 digits).
// Phone-only leads are captured but NEVER drip-enrolled — enrolling
// would let sendDripStep stop the progress row with
// stopped_reason='no_email', and the merge path blocks re-enrollment on
// ANY existing progress row, permanently burning drip eligibility. The
// merge-fills-email-then-enrolls scenario is the critical pin.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock supabaseService: same recording builder as beta-intake-dedup.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})
const syncLog = vi.hoisted(() => ({ writeSyncLog: vi.fn(async () => {}) }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/sync-log', () => syncLog)
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({
  sendDripStep: vi.fn(async () => ({ sent: true })),
}))

import { POST } from '@/app/api/leads/intake/route'
import { applyDripSideEffects, startDripForLead } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'

// ── helpers ────────────────────────────────────────────────
const LOC = {
  id: 'loc-uuid-1',
  name: 'Boulder',
  location_id: 'boulder-01',
  lifecycle_status: 'active', // drip-eligible by default; tests opt out
}

const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
}) as any

const badJsonReq = (key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => { throw new Error('bad json') },
}) as any

const submission = (over: any = {}) => ({
  location_slug: 'boulder-01',
  full_name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  ...over,
})

const storedLead = (over: any = {}) => ({
  id: 'lead-A',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: null,
  phone_normalized: '',
  address: null,
  city: null,
  state: null,
  zip: null,
  project_type: null,
  stage: 'New',
  is_junk: null,
  location_uuid: 'loc-uuid-1',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

const logCalls = () => syncLog.writeSyncLog.mock.calls.map(c => c[0] as any)
const lastLog = () => {
  const calls = logCalls()
  return calls[calls.length - 1]
}
const insertPayloads = (table: string) =>
  h.state.calls.filter(c => c.table === table)
    .flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))
const updatePayloads = (table: string) =>
  h.state.calls.filter(c => c.table === table)
    .flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
})

// ═══ A. sync_log observability ═════════════════════════════
describe('intake observability — auth boundary', () => {
  it('401 writes NOTHING to sync_log (unauthenticated noise must not fill the log)', async () => {
    const res = await POST(makeReq(submission(), 'wrong-key'))
    expect(res.status).toBe(401)
    expect(syncLog.writeSyncLog).not.toHaveBeenCalled()
  })
})

describe('intake observability — error rows', () => {
  it('invalid_json → error/na row, null location, entity unknown', async () => {
    const res = await POST(badJsonReq())
    expect(res.status).toBe(400)
    expect(syncLog.writeSyncLog).toHaveBeenCalledTimes(1)
    expect(lastLog()).toMatchObject({
      status: 'error',
      landed_status: 'na',
      location_id: null,
      entity_id: 'unknown',
      direction: 'inbound',
      entity_type: 'client',
    })
    expect(lastLog().message).toMatch(/^\[intake\] topic=LEAD_INTAKE /)
    expect(lastLog().message).toContain('error=invalid_json')
  })

  it('validation 400 → logged with the error code; entity_id is the submitted email', async () => {
    const res = await POST(makeReq(submission({ location_slug: undefined })))
    expect(res.status).toBe(400)
    expect(lastLog()).toMatchObject({
      status: 'error', landed_status: 'na', location_id: null,
      entity_id: 'sarah@email.com',
    })
    expect(lastLog().message).toContain('error=location_slug required')
  })

  it('location_not_found → entity_id is the slug and the message carries it (Make typo diagnosable)', async () => {
    // No location enqueued → lookup resolves null.
    const res = await POST(makeReq(submission({ location_slug: 'typo-slug' })))
    expect(res.status).toBe(400)
    expect(lastLog()).toMatchObject({
      status: 'error', landed_status: 'na', location_id: null,
      entity_id: 'typo-slug',
    })
    expect(lastLog().message).toContain('error=location_not_found')
    expect(lastLog().message).toContain('slug=typo-slug')
  })

  it('location_lookup_failed (500) → logged with the DB error detail', async () => {
    h.enqueue('locations', null, { message: 'connection refused' })
    const res = await POST(makeReq(submission()))
    expect(res.status).toBe(500)
    expect(lastLog()).toMatchObject({ status: 'error', entity_id: 'boulder-01' })
    expect(lastLog().message).toContain('error=location_lookup_failed')
    expect(lastLog().message).toContain('connection refused')
  })

  it('insert_failed → error row scoped to the location slug, message carries insertErr.message', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', []) // strong keys
    h.enqueue('leads', []) // name
    h.enqueue('leads', null, { message: 'value too long for column "zip"' }) // insert
    const res = await POST(makeReq(submission()))
    expect(res.status).toBe(500)
    expect(lastLog()).toMatchObject({
      status: 'error',
      landed_status: 'na',
      location_id: 'boulder-01', // SLUG — the dashboard joins names on it
      entity_id: 'sarah@email.com',
    })
    expect(lastLog().message).toContain('error=insert_failed')
    expect(lastLog().message).toContain('value too long')
  })
})

describe('intake observability — success rows', () => {
  it('fresh insert → success/landed row: entity=lead.id, source + dedup=none + drip_enrolled in message', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new-1' })
    const res = await POST(makeReq(submission({ source: 'facebook_lead_ad' })))
    expect(res.status).toBe(200)
    expect(lastLog()).toMatchObject({
      status: 'success',
      landed_status: 'landed',
      location_id: 'boulder-01',
      entity_id: 'lead-new-1',
      direction: 'inbound',
      entity_type: 'client',
    })
    const msg = lastLog().message
    expect(msg).toMatch(/^\[intake\] topic=LEAD_INTAKE /)
    expect(msg).toContain('lead=lead-new-1')
    // Producer slugs are normalized into the lead_sources vocabulary at
    // intake (lib/lead-source.ts) — the log reports the STORED value.
    expect(msg).toContain('source=Facebook')
    expect(msg).toContain('dedup=none')
    expect(msg).toContain('drip_enrolled=true')
    // Exactly one row per request.
    expect(syncLog.writeSyncLog).toHaveBeenCalledTimes(1)
  })

  it('in_question dedup → message carries the tier with match count', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', [storedLead({ id: 'lead-A' }), storedLead({ id: 'lead-B' })])
    h.enqueue('leads', { id: 'lead-new-2' })
    await POST(makeReq(submission()))
    expect(lastLog().message).toContain('dedup=in_question(2)')
  })

  it('warnings appear in the success message WITHOUT flipping status', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new-3' })
    h.enqueue('touchpoints', null, { message: 'tp boom' })
    const res = await POST(makeReq(submission()))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(lastLog().status).toBe('success')
    expect(lastLog().message).toContain('warnings: touchpoint_insert_failed: tp boom')
  })

  it('dedup-degrade path (match query throws) → blind insert still logs success WITH the degrade warning', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', null, { message: 'db down' }) // strong-key query errors → degrade
    h.enqueue('leads', { id: 'lead-new-4' })          // blind insert
    const res = await POST(makeReq(submission()))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.lead_id).toBe('lead-new-4')
    expect(lastLog().status).toBe('success')
    expect(lastLog().message).toContain('dedup_match_failed: db down')
  })

  it('merge path → entity_id is the MATCHED id, message notes merged (matched on <key>)', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', [storedLead()])                 // solid email match
    h.enqueue('lead_drip_progress', { id: 'prog-1' })  // already enrolled
    const res = await POST(makeReq(submission()))
    const body = await res.json()
    expect(body.merged).toBe(true)
    expect(lastLog()).toMatchObject({
      status: 'success',
      landed_status: 'landed',
      location_id: 'boulder-01',
      entity_id: 'lead-A',
    })
    expect(lastLog().message).toContain('merged (matched on email)')
    expect(lastLog().message).toContain('drip_enrolled=false')
  })
})

// ═══ C. email-or-phone policy ══════════════════════════════
describe('intake email-or-phone — validation', () => {
  it('neither email nor usable phone → 400 email_or_phone_required (and logged)', async () => {
    const res = await POST(makeReq(submission({ email: undefined, phone: undefined })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('email_or_phone_required')
    expect(lastLog().message).toContain('error=email_or_phone_required')
  })

  it('phone under 7 digits does not satisfy the policy', async () => {
    const res = await POST(makeReq(submission({ email: undefined, phone: '555-01' })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('email_or_phone_required')
  })

  it('invalid email + valid phone → captured with email NULL + email_invalid_ignored warning', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new-5' })
    const res = await POST(makeReq(submission({ email: 'not-an-email' })))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.warnings).toContain('email_invalid_ignored')
    expect(insertPayloads('leads')[0].email).toBeNull()
  })
})

describe('intake email-or-phone — phone-only leads NEVER enroll the drip', () => {
  // Enrolling would let sendDripStep permanently stop the progress row
  // with stopped_reason='no_email'; merge blocks re-enrollment on ANY
  // progress row — so enrollment here burns the lead's drip eligibility.
  it('phone-only intake at an ACTIVE location → lead captured, drip fully skipped, reason surfaced', async () => {
    h.enqueue('locations', LOC) // active
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-po-1' })
    const res = await POST(makeReq(submission({ email: undefined })))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.drip_enrolled).toBe(false)
    expect(body.drip_skipped_reason).toBe('no_email')
    // The whole enrollment machinery stays untouched — no progress row
    // can exist to block a later email-bearing resubmission.
    expect(applyDripSideEffects).not.toHaveBeenCalled()
    expect(sendDripStep).not.toHaveBeenCalled()
    expect(insertPayloads('leads')[0].email).toBeNull()
    expect(lastLog().message).toContain('drip_skipped_reason=no_email')
  })

  it('phone-only dedupe works unchanged: phone_normalized match merges, no email → still no enrollment', async () => {
    h.enqueue('locations', LOC)
    h.enqueue('leads', [storedLead({
      id: 'lead-po-2',
      email: null,
      phone: '(561) 555-0199',
      phone_normalized: '5615550199',
    })])
    const res = await POST(makeReq(submission({ email: undefined })))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-po-2')
    expect(body.matched_on).toBe('phone')
    expect(body.drip_enrolled).toBe(false)
    expect(body.drip_skipped_reason).toBe('no_email')
    expect(startDripForLead).not.toHaveBeenCalled()
    expect(sendDripStep).not.toHaveBeenCalled()
  })

  it('THE critical sequence: phone-only lead later resubmits WITH email → merge fills email AND enrolls + sends step 1', async () => {
    // The stored lead is what the phone-only intake above left behind:
    // no email, stage New, NO drip progress row (enrollment was skipped).
    h.enqueue('locations', LOC)
    h.enqueue('leads', [storedLead({
      id: 'lead-po-3',
      email: null,
      phone: '(561) 555-0199',
      phone_normalized: '5615550199',
    })])
    h.enqueue('lead_drip_progress', null)                 // never enrolled
    h.enqueue('lead_drip_progress', { id: 'prog-new-1' }) // seeded after start
    const res = await POST(makeReq(submission())) // now WITH email
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-po-3')
    // The submitted email fills the gap…
    expect(updatePayloads('leads')[0]).toMatchObject({ email: 'sarah@email.com' })
    // …and eligibility was preserved: enrollment + step 1 fire NOW.
    expect(body.drip_enrolled).toBe(true)
    expect(body.drip_skipped_reason).toBeUndefined()
    expect(startDripForLead).toHaveBeenCalledWith('lead-po-3', 'loc-uuid-1')
    expect(sendDripStep).toHaveBeenCalledTimes(1)
    expect(lastLog().message).toContain('drip_enrolled=true')
  })
})
