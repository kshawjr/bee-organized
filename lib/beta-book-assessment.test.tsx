// @vitest-environment happy-dom
//
// Book assessment (fix 1 of 2, 2026-11) — book a Jobber assessment on a request
// Bee Hub ALREADY sent, from the card, so the owner never makes a second
// request in Jobber (the twin-card cause: 31 of 41 pairs since 1 Sept).
//
// What these pin, in the order Kevin listed them:
//   1. a card with a Jobber request and no assessment offers the action
//   2. a card with no Jobber request does not
//   3. a card that already has an assessment never gets a second one
//   4. booking writes the assessment ONTO the existing request — no new request
//   5. no new card appears as a result (the real REQUEST_UPDATE webhook runs)
//   6. the timezone conversion is the send route's, byte for byte
//   7. a Jobber refusal surfaces, and nothing is half-written locally
//   8. a lite_user cannot reach it
//
// 4 and 5 run the REAL route and the REAL webhook handler against one shared
// in-memory table set (lib/test-memdb.ts). Only Supabase, Jobber's HTTP and
// sync_log are stood in. LIMIT: Jobber itself is faked — that a real
// assessmentCreate attaches to the request we name is Jobber's contract, not
// provable here (see the todo at the bottom).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── shared in-memory DB + Jobber fakes ──────────────────────────────────────
const h = vi.hoisted(() => ({
  db: null as any,
  user: { id: 'u-owner' } as { id: string } | null,
  graphql: null as any,
  mutation: null as any,
  syncLog: [] as any[],
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.db.from(t), rpc: (...a: any[]) => h.db.rpc(...a) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    from: (t: string) => h.db.from(t),
  }),
}))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: (...a: any[]) => h.graphql(...a),
  jobberMutation: (...a: any[]) => h.mutation(...a),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: async (row: any) => { h.syncLog.push(row) } }))

import { createMemDb } from '@/lib/test-memdb'
import { encodeJobberId } from '@/lib/jobber-import'
import { POST as bookPOST } from '@/app/api/engagements/[id]/assessment/route'
import { handleRequestUpdate } from '@/lib/jobber-webhook-handlers'
import { createAssessmentOnRequest, toLocalDateTime } from '@/lib/jobber-assessment-create'
import { canBookAssessment } from '@/components/hive/shared/bookAssessmentGate'
import { buildAssessmentIso, ASSESSMENT_TIME_OPTIONS } from '@/components/hive/shared/assessmentTime'
import { BookAssessmentDialog } from '@/components/hive/BookAssessment'

// ── fixture: Sioux Falls-shaped card, sent "Request only" ───────────────────
const LOC_UUID = 'loc-uuid-sf'
const SLUG = 'loc_siouxfalls'
const LEAD = 'lead-donna'
const ENG = 'eng-donna'
const SR = 'sr-donna'
const REQ = '35753033'
const REQ_GID = encodeJobberId('Request', REQ)
const CLIENT_GID = encodeJobberId('Client', '158201931')
const PROP_GID = encodeJobberId('Property', '164101834')
const TED = 'gid-user-ted'

function seed(over: { assessments?: any[]; srs?: any[]; role?: string; userLoc?: string; tz?: string } = {}) {
  return createMemDb({
    hub_users: [
      { id: 'u-owner', role: over.role ?? 'owner', location_id: over.userLoc ?? LOC_UUID },
    ],
    locations: [{
      id: LOC_UUID, location_id: SLUG, name: 'Sioux Falls', timezone: over.tz ?? 'Central Time (CT)',
      jobber_access_token: 'tok', jobber_account_id: 'acct', lifecycle_status: 'active', subscription_status: 'active',
    }],
    leads: [{
      id: LEAD, name: 'Donna Hawk', location_id: SLUG, location_uuid: LOC_UUID,
      jobber_client_id: '158201931', jobber_request_id: REQ, stage: 'Request', email: 'donna@example.com',
    }],
    engagements: [{
      id: ENG, client_id: LEAD, location_uuid: LOC_UUID, stage: 'Request', founded_by: 'request',
      title: 'Engagement – Nov 2026', created_at: '2026-11-02T21:48:54Z',
    }],
    service_requests: over.srs ?? [{
      id: SR, lead_id: LEAD, location_id: SLUG, jobber_request_id: REQ, engagement_id: ENG,
      stage: 'New', status: 'active', source: 'jobber',
    }],
    assessments: over.assessments ?? [],
    engagement_assignees: [{ engagement_id: ENG, hub_user_id: 'u-ted', created_at: '2026-11-02T22:00:00Z' }],
    hub_users_extra: [],
  })
}

// Jobber as it really is for Donna's request before booking: no assessment.
let liveRequest: any
function jobberWithRequest() {
  liveRequest = {
    id: REQ_GID, requestStatus: 'new', title: 'Donna', createdAt: '2026-11-02T21:48:54Z',
    jobberWebUri: `https://secure.getjobber.com/work_requests/${REQ}`,
    client: { id: CLIENT_GID, firstName: 'Donna', lastName: 'Hawk', emails: [], phones: [] },
    property: { id: PROP_GID }, assessment: null, quotes: { nodes: [] }, jobs: { nodes: [] },
  }
  h.graphql = vi.fn(async (_loc: string, query: string, vars: any) => {
    if (vars?.id === REQ_GID) return { data: { request: liveRequest } }
    return { data: {} }
  })
  // A working Jobber: assessmentCreate attaches to the request named, echoes the team.
  h.mutation = vi.fn(async (_loc: string, mutation: string, vars: any) => {
    if (String(mutation).includes('assessmentCreate')) {
      const team: string[] = vars?.input?.schedule?.teamMemberIdsToAssign ?? []
      if (vars.requestId === REQ_GID) {
        liveRequest.assessment = { id: encodeJobberId('Assessment', '999'), startAt: '2026-11-20T15:00:00Z', isComplete: false }
        liveRequest.requestStatus = 'upcoming'
      }
      return {
        data: { assessmentCreate: { assessment: { id: encodeJobberId('Assessment', '999'), assignedUsers: { nodes: team.map(id => ({ id })) } } } },
        userErrors: undefined,
      }
    }
    return { data: {}, userErrors: undefined }
  })
}

// getEngagementAssignees joins engagement_assignees → hub_users. The memdb
// has no joins, so the assignee read is pinned at the module boundary: Ted,
// mapped to Jobber, at this location.
vi.mock('@/lib/engagement-assignee-sync', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    getEngagementAssignees: async () => [
      { hub_user_id: 'u-ted', name: 'Ted White', email: 'ted@example.com', jobber_user_id: TED, location_id: LOC_UUID },
    ],
  }
})

const AT = '2026-11-20T15:00:00.000Z' // 9:00 AM Central
async function book(body: any = { scheduled_assessment_at: AT, assessment_type: 'in-person' }) {
  const req = new Request('http://x/api/engagements/' + ENG + '/assessment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const res = await bookPOST(req as any, { params: Promise.resolve({ id: ENG }) })
  return { status: res.status, json: await res.json() }
}
const mutationNames = () => h.mutation.mock.calls.map((c: any[]) => (String(c[1]).match(/mutation\s+(\w+)/) || [])[1])

beforeEach(() => {
  h.user = { id: 'u-owner' }
  h.syncLog = []
  h.db = seed()
  jobberWithRequest()
})

// ══ 1–3) when it shows ═════════════════════════════════════════════════════
describe('the gate — when the card offers Book assessment', () => {
  const eng = { stage: 'Request' }
  const sent = { service_requests: [{ id: SR, jobber_request_id: REQ }], assessments: [] }

  it('1. a card with a Jobber request and no assessment offers it', () => {
    expect(canBookAssessment({ eng, children: sent, readOnly: false })).toBe(true)
  })
  it('2. a card with no Jobber request does not', () => {
    expect(canBookAssessment({ eng, children: { service_requests: [], assessments: [] }, readOnly: false })).toBe(false)
    // a request row with no Jobber id is nothing to hang it on either
    expect(canBookAssessment({ eng, children: { service_requests: [{ id: SR, jobber_request_id: null }], assessments: [] }, readOnly: false })).toBe(false)
  })
  it('3. a card that already has an assessment does not', () => {
    expect(canBookAssessment({ eng, children: { ...sent, assessments: [{ id: 'a1' }] }, readOnly: false })).toBe(false)
  })
  it('hidden when closed, read-only, or holding two requests', () => {
    expect(canBookAssessment({ eng: { stage: 'Closed Lost' }, children: sent, readOnly: false })).toBe(false)
    expect(canBookAssessment({ eng, children: sent, readOnly: true })).toBe(false)
    expect(canBookAssessment({ eng, children: { service_requests: [{ jobber_request_id: '1' }, { jobber_request_id: '2' }], assessments: [] }, readOnly: false })).toBe(false)
  })
  it('the panel wires the gate into its action bar, beside (never with) Send to Jobber', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(panel).toContain("const canBook = !!data && canBookAssessment({ eng, children, readOnly })")
    // mounted only when shown — a hidden element would still take an ActionRow column
    expect(panel).toContain('{canBook && (\n          <BookAssessment')
    // Send's own gate requires ZERO service_requests; Book's requires exactly one sent.
    expect(panel).toMatch(/canSendToJobber = [\s\S]{0,200}children\.service_requests\.length === 0/)
  })
})

// ══ 3) the server refuses a second assessment ══════════════════════════════
describe('3. no second assessment by accident (server)', () => {
  it('refuses when the card already holds an assessment row — and never calls Jobber to write', async () => {
    h.db = seed({ assessments: [{ id: 'a-old', engagement_id: ENG, service_request_id: SR }] })
    const r = await book()
    expect(r.status).toBe(409)
    expect(r.json.stage).toBe('already_booked')
    expect(h.mutation).not.toHaveBeenCalled()
  })
  it('refuses when Jobber already has one on the request even though our mirror lags', async () => {
    liveRequest.assessment = { id: encodeJobberId('Assessment', '1') }
    const r = await book()
    expect(r.status).toBe(409)
    expect(r.json.stage).toBe('already_booked')
    expect(h.mutation).not.toHaveBeenCalled()
  })
  it('a second press after a successful booking is refused, not doubled', async () => {
    expect((await book()).status).toBe(200)
    const again = await book()
    expect(again.status).toBe(409)
    expect(mutationNames().filter((n: string) => n === 'AssessmentCreate')).toHaveLength(1)
  })
  it('no Jobber request on the card → refused before any Jobber call', async () => {
    h.db = seed({ srs: [] })
    const r = await book()
    expect(r.status).toBe(400)
    expect(h.mutation).not.toHaveBeenCalled()
    expect(h.graphql).not.toHaveBeenCalled()
  })
})

// ══ 4) onto the existing request, no new request ═══════════════════════════
describe('4. booking writes the assessment onto the EXISTING request and creates no request', () => {
  it('exactly one Jobber write, it is assessmentCreate, aimed at the card’s own request', async () => {
    const r = await book()
    expect(r.status).toBe(200)
    expect(r.json.success).toBe(true)
    expect(mutationNames()).toEqual(['AssessmentCreate'])
    const vars = h.mutation.mock.calls[0][2]
    expect(vars.requestId).toBe(REQ_GID)
    // no request was created, anywhere in the call
    for (const c of h.mutation.mock.calls) expect(String(c[1])).not.toContain('requestCreate')
    // the team is the card's people, assigned at creation
    expect(vars.input.schedule.teamMemberIdsToAssign).toEqual([TED])
  })
  it('the route source has no request-creating path at all', () => {
    const route = readFileSync('app/api/engagements/[id]/assessment/route.ts', 'utf8')
    expect(route).not.toContain('requestCreate')
    expect(route).not.toContain('REQUEST_CREATE_MUTATION')
    expect(route).toContain('createAssessmentOnRequest({')
  })
  it('locally: no service_requests row is added, and the assessment lands on THIS card', async () => {
    const srBefore = h.db.rows('service_requests')
    await book()
    expect(h.db.rows('service_requests')).toEqual(srBefore)
    const a = h.db.rows('assessments')
    expect(a).toHaveLength(1)
    expect(a[0].engagement_id).toBe(ENG)
    expect(a[0].service_request_id).toBe(SR)
    expect(a[0].assessment_type).toBe('in-person')
    expect(h.syncLog.at(-1).message).toContain(`Book-assessment; request=${REQ}; engagement=${ENG}`)
  })
})

// ══ 5) no new card ═════════════════════════════════════════════════════════
describe('5. no new card appears', () => {
  const ctx = () => ({
    topic: 'REQUEST_UPDATE', itemId: REQ, occurredAt: new Date().toISOString(),
    location: { id: LOC_UUID, location_id: SLUG, name: 'Sioux Falls', timezone: 'Central Time (CT)', jobber_account_id: 'acct', jobber_access_token: 'tok' },
  })

  it('the route itself founds nothing: engagements unchanged', async () => {
    const before = h.db.rows('engagements')
    await book()
    expect(h.db.rows('engagements')).toEqual(before)
    expect(h.db.writes.filter((w: any) => w.table === 'engagements')).toEqual([])
  })

  it('then Jobber’s REQUEST_UPDATE for the new assessment runs through the REAL webhook handler — still one card, everything on it', async () => {
    await book()
    const res = await handleRequestUpdate(ctx() as any)
    expect(res.processed).toBe(true)
    const engs = h.db.rows('engagements')
    expect(engs).toHaveLength(1)
    expect(engs[0].id).toBe(ENG)
    expect(h.db.writes.filter((w: any) => w.table === 'engagements' && w.op === 'insert')).toEqual([])
    const srs = h.db.rows('service_requests')
    expect(srs).toHaveLength(1)
    expect(srs[0].engagement_id).toBe(ENG)
    const a = h.db.rows('assessments')
    expect(a).toHaveLength(1)
    expect(a[0].engagement_id).toBe(ENG)
  })

  it('also when the webhook beats our mirror write (route mirror failed): still one card', async () => {
    // Book in Jobber only — simulate the route's local mirror never landing.
    await createAssessmentOnRequest({
      locationSlug: SLUG, requestGlobalId: REQ_GID, scheduledAtIso: AT,
      timezoneLabel: 'Central Time (CT)', teamJobberIds: [TED], assessmentType: 'in-person',
    })
    await handleRequestUpdate(ctx() as any)
    expect(h.db.rows('engagements')).toHaveLength(1)
    const a = h.db.rows('assessments')
    expect(a).toHaveLength(1)
    expect(a[0].engagement_id).toBe(ENG)
  })
})

// ══ 6) the timezone conversion is the send route's ═════════════════════════
describe('6. the timezone conversion matches Send to Jobber', () => {
  it('both routes call the ONE shared create (no second copy of the conversion)', () => {
    const send = readFileSync('app/api/leads/[id]/send-to-jobber/route.ts', 'utf8')
    const bookSrc = readFileSync('app/api/engagements/[id]/assessment/route.ts', 'utf8')
    for (const src of [send, bookSrc]) {
      expect(src).toContain("import { createAssessmentOnRequest } from '@/lib/jobber-assessment-create'")
      expect(src).not.toContain('function toLocalDateTime')
      expect(src).not.toContain('formatInTimeZone')
      expect(src).not.toContain('requireIanaTimezone(')
    }
  })
  it('the same instant + label → the same wall-clock schedule, one-hour block, IANA zone', async () => {
    await book()
    const sched = h.mutation.mock.calls[0][2].input.schedule
    expect(sched.startAt).toEqual({ date: '2026-11-20', time: '09:00:00', timezone: 'America/Chicago' })
    expect(sched.endAt).toEqual({ date: '2026-11-20', time: '10:00:00', timezone: 'America/Chicago' })
    // and it equals the shared helper's output for the same input
    expect(sched.startAt).toEqual(toLocalDateTime(AT, 'America/Chicago'))
  })
  it('a DST-side date converts correctly too (Arizona never shifts)', async () => {
    h.db = seed({ tz: 'Arizona Time (AZ)' })
    await book({ scheduled_assessment_at: '2026-07-15T17:00:00.000Z', assessment_type: 'virtual' })
    const input = h.mutation.mock.calls[0][2].input
    expect(input.schedule.startAt).toEqual({ date: '2026-07-15', time: '10:00:00', timezone: 'America/Phoenix' })
    expect(input.instructions).toBeTruthy() // virtual → the field team's note
  })
  it('a timezone Bee Hub cannot resolve is refused before Jobber is touched (no silent fallback)', async () => {
    h.db = seed({ tz: 'Phoenix AZ' })
    const r = await book()
    expect(r.status).toBe(400)
    expect(r.json.stage).toBe('validation')
    expect(r.json.error).toContain('Settings → Location → Timezone')
    expect(h.mutation).not.toHaveBeenCalled()
  })
  it('the browser side is the send popup’s too: same slots, same pick → ISO', () => {
    const modal = readFileSync('components/hive/SendToJobberModal.jsx', 'utf8')
    expect(modal).toContain("import { ASSESSMENT_TIME_OPTIONS, buildAssessmentIso } from './shared/assessmentTime'")
    expect(modal).toContain('return buildAssessmentIso(date, time)')
    expect(ASSESSMENT_TIME_OPTIONS[0]).toBe('7:00 AM')
    expect(ASSESSMENT_TIME_OPTIONS.at(-1)).toBe('7:45 PM')
    expect(ASSESSMENT_TIME_OPTIONS).toHaveLength(52)
    const iso = buildAssessmentIso('2026-11-20', '2:30 PM')!
    const d = new Date(iso)
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 10, 20, 14, 30])
    expect(buildAssessmentIso('', '2:30 PM')).toBeNull()
  })
})

// ══ 7) a Jobber refusal surfaces; nothing half-written ═════════════════════
describe('7. a Jobber refusal surfaces and leaves nothing half-written', () => {
  it('Jobber says no → 502 with Jobber’s words and the stage; the database is byte-identical', async () => {
    h.mutation = vi.fn(async () => ({ data: { assessmentCreate: { assessment: null } }, userErrors: [{ message: 'Start time must be in the future' }] }))
    const before = h.db.snapshot()
    const r = await book()
    expect(r.status).toBe(502)
    expect(r.json).toMatchObject({ success: false, stage: 'assessment_create' })
    expect(r.json.error).toContain('Start time must be in the future')
    expect(h.db.snapshot()).toEqual(before)
    expect(h.db.writes).toEqual([])
    expect(h.syncLog).toEqual([])
  })
  it('in-person on a request with no address is refused in plain words, before Jobber is written', async () => {
    liveRequest.property = null
    const r = await book()
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('has no address')
    expect(h.mutation).not.toHaveBeenCalled()
    // virtual is still bookable on the same request
    expect((await book({ scheduled_assessment_at: AT, assessment_type: 'virtual' })).status).toBe(200)
  })
  it('the dialog shows what was refused, with the stage, and stays open', async () => {
    const onBooked = vi.fn(); const onClose = vi.fn()
    ;(globalThis as any).fetch = vi.fn(async () => ({
      ok: false, status: 502,
      json: async () => ({ success: false, stage: 'assessment_create', error: 'Jobber refused the assessment: Start time must be in the future' }),
    }))
    const el = document.createElement('div'); document.body.appendChild(el)
    const root = createRoot(el)
    await act(async () => { root.render(<BookAssessmentDialog engagementId={ENG} assignees={[{ name: 'Ted White', jobber_user_id: TED }] as any} onClose={onClose} onBooked={onBooked} />) })
    const date = el.querySelector('input[aria-label="Assessment date"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(date, '2026-11-20'); date.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Book assessment') && !b.getAttribute('data-testid'))!
    await act(async () => { btn.click() })
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Start time must be in the future (assessment_create)')
    expect(onBooked).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[aria-label="Book assessment"][role="dialog"]')).not.toBeNull()
    // and it names the team it will assign
    expect(document.querySelector('[data-book-team]')?.textContent).toContain('Ted White')
    await act(async () => { root.unmount() }); el.remove()
  })
})

// ══ 8) lite_user cannot reach it ═══════════════════════════════════════════
describe('8. permissions match Send to Jobber', () => {
  it('lite_user → 403, nothing read from or written to Jobber, nothing written locally', async () => {
    h.db = seed({ role: 'lite_user' })
    const before = h.db.snapshot()
    const r = await book()
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('forbidden_read_only_role')
    expect(h.mutation).not.toHaveBeenCalled()
    expect(h.graphql).not.toHaveBeenCalled()
    expect(h.db.snapshot()).toEqual(before)
  })
  it('an owner from another location → 403', async () => {
    h.db = seed({ userLoc: 'some-other-location' })
    const r = await book()
    expect(r.status).toBe(403)
    expect(r.json.error).toBe('forbidden_wrong_location')
    expect(h.mutation).not.toHaveBeenCalled()
  })
  it('admin from anywhere is allowed (as on Send)', async () => {
    h.db = seed({ role: 'admin', userLoc: 'hq' })
    expect((await book()).status).toBe(200)
  })
  it('not logged in → 401', async () => {
    h.user = null
    expect((await book()).status).toBe(401)
  })
  it('the gate hides it from read-only viewers too', () => {
    expect(canBookAssessment({ eng: { stage: 'Request' }, children: { service_requests: [{ jobber_request_id: REQ }], assessments: [] }, readOnly: true })).toBe(false)
  })
})

describe('live-only (needs a real Jobber call — out of scope)', () => {
  it.todo('a real assessmentCreate(requestId) attaches to that request and fires REQUEST_UPDATE, not REQUEST_CREATE')
})
