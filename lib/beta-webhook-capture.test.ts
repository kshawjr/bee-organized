// @vitest-environment node
//
// Webhook dispatcher — "capture every webhook" (observability Phase 1).
// Every return path of POST /api/webhooks/jobber past the signature
// check writes exactly one sync_log row:
//   — dispatched topics (success AND handler-error) with landed_status
//     from checkLanded
//   — unknown topics ([skipped], landed na)
//   — unknown accounts (previously UNLOGGED → now location_id=null row)
//   — unparseable JSON (previously UNLOGGED → error row, location null)
//   — missing envelope fields (previously UNLOGGED → error row)
// The single documented exception: signature-INVALID requests are 401'd
// with NO row (unauthenticated writes would be a spam vector).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  verify: vi.fn(() => true),
  lookup: vi.fn(async (): Promise<any> => ({
    id: 'loc-uuid-1',
    location_id: 'loc_test',
    name: 'Test Location',
  })),
  handler: vi.fn(async (): Promise<any> => ({
    processed: true, lead_id: 'lead-1', lead_stage: 'Closed Won', prev_stage: 'Job in Progress',
  })),
  writeSyncLog: vi.fn(async () => {}),
  checkLanded: vi.fn(async (): Promise<any> => 'landed'),
}))

vi.mock('@/lib/jobber-webhook', () => ({
  verifyWebhookSignature: h.verify,
  lookupLocationByJobberAccountId: h.lookup,
}))
vi.mock('@/lib/jobber-webhook-handlers', () => ({
  TOPIC_HANDLERS: { JOB_COMPLETE: h.handler },
  SUPPORTED_TOPICS: ['JOB_COMPLETE'],
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: h.writeSyncLog }))
vi.mock('@/lib/webhook-landed', () => ({ checkLanded: h.checkLanded }))

import { POST } from '@/app/api/webhooks/jobber/route'

const post = (body: string) =>
  POST(new NextRequest('http://localhost/api/webhooks/jobber', {
    method: 'POST',
    body,
    headers: { 'x-jobber-hmac-sha256': 'sig' },
  }))

const envelope = (over: any = {}) =>
  JSON.stringify({ topic: 'JOB_COMPLETE', accountId: 'acct-1', itemId: '555', occurredAt: new Date().toISOString(), ...over })

const loggedRows = () => h.writeSyncLog.mock.calls.map(c => c[0] as any)

beforeEach(() => {
  vi.clearAllMocks()
  h.verify.mockReturnValue(true)
  h.lookup.mockResolvedValue({ id: 'loc-uuid-1', location_id: 'loc_test', name: 'Test Location' })
  h.handler.mockResolvedValue({ processed: true, lead_id: 'lead-1', lead_stage: 'Closed Won', prev_stage: 'Job in Progress' })
  h.checkLanded.mockResolvedValue('landed')
})

describe('dispatched topics', () => {
  it('success → one row with landed_status from checkLanded + landed in the response', async () => {
    const res = await post(envelope())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, processed: true, landed: 'landed' })
    const rows = loggedRows()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      location_id: 'loc_test',
      direction: 'inbound',
      status: 'success',
      landed_status: 'landed',
    })
    expect(h.checkLanded).toHaveBeenCalledTimes(1)
  })

  it('not_landed is recorded verbatim (silent-stuck reaches the row)', async () => {
    h.checkLanded.mockResolvedValue('not_landed')
    await post(envelope())
    expect(loggedRows()[0].landed_status).toBe('not_landed')
  })

  it('handler throw → still 200, one error row, landed_status na', async () => {
    h.handler.mockRejectedValue(new Error('boom'))
    h.checkLanded.mockResolvedValue('na')
    const res = await post(envelope())
    expect(res.status).toBe(200) // Jobber must not retry
    const rows = loggedRows()
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('error')
    expect(rows[0].message).toContain('error=boom')
    expect(rows[0].landed_status).toBe('na')
  })
})

describe('previously-unlogged paths now write rows', () => {
  it('unknown account → success row with location_id=null naming the account', async () => {
    h.lookup.mockResolvedValue(null)
    const res = await post(envelope())
    expect((await res.json()).skipped).toBe('unknown_account')
    const rows = loggedRows()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ location_id: null, status: 'success', landed_status: 'na' })
    expect(rows[0].message).toContain('no connected location for account=acct-1')
    expect(rows[0].message).toContain('topic=JOB_COMPLETE')
  })

  it('unparseable JSON (signature valid) → error row, location null, 400', async () => {
    const res = await post('this is {not json')
    expect(res.status).toBe(400)
    const rows = loggedRows()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ location_id: null, status: 'error', landed_status: 'na' })
    expect(rows[0].message).toContain('error=bad_json')
  })

  it('missing envelope fields → error row, 400', async () => {
    const res = await post(JSON.stringify({ topic: 'JOB_COMPLETE' })) // no accountId/itemId
    expect(res.status).toBe(400)
    const rows = loggedRows()
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('error')
    expect(rows[0].message).toContain('error=missing_fields')
  })

  it('unknown topic → [skipped] row with landed na (pre-existing behavior kept)', async () => {
    const res = await post(envelope({ topic: 'WEIRD_TOPIC' }))
    expect((await res.json()).skipped).toBe('unknown_topic')
    const rows = loggedRows()
    expect(rows.length).toBe(1)
    expect(rows[0].message).toContain('[skipped] unknown topic=WEIRD_TOPIC')
    expect(rows[0].landed_status).toBe('na')
  })
})

describe('the one documented no-log path', () => {
  it('invalid signature → 401 and NO sync_log row (unauthenticated spam vector)', async () => {
    h.verify.mockReturnValue(false)
    const res = await post(envelope())
    expect(res.status).toBe(401)
    expect(h.writeSyncLog).not.toHaveBeenCalled()
  })
})
