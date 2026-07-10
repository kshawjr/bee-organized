// @vitest-environment node
//
// Webhook observability — unit tests for the read-side enrichment that
// powers the admin Webhooks tab + the Slack failure digest.
//
//   1) parseSyncLogMessage recovers topic / item / lead / stage / error /
//      note from the write-once message strings the webhook dispatcher
//      composes (app/api/webhooks/jobber/route.ts). The error capture
//      matters most: it's what the admin copies out of a failed row, so
//      it must survive colons, quotes, and the " — note" suffix. Also
//      covers the capture-everything rows the dispatcher now writes for
//      previously-unlogged paths (unknown account, unparseable JSON).
//
//   2) mapLandedStatus maps the RECORDED sync_log.landed_status column
//      (written by lib/webhook-landed.ts at processing time — the rules
//      themselves are pinned in beta-webhook-landed.test.ts) onto the
//      dashboard's three-state indicator: landed ✓ / stuck ▲ / null "—".
//      Pre-migration NULL rows must render "—", not amber.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {},
}))
vi.mock('@/lib/sync-log', () => ({
  writeSyncLog: async () => {},
}))

import {
  parseSyncLogMessage,
  mapLandedStatus,
  friendlyTopic,
  failureReason,
} from '@/lib/webhook-observability'

const LEAD = '97ccfc85-ecba-4bc9-8495-b13e6a9e8507'

describe('parseSyncLogMessage', () => {
  it('parses a plain success row (topic + item + lead)', () => {
    const p = parseSyncLogMessage(
      `topic=REQUEST_UPDATE item=Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzE1NTM5NzI= lead=${LEAD}`,
    )
    expect(p.topic).toBe('REQUEST_UPDATE')
    expect(p.itemRaw).toBe('Z2lkOi8vSm9iYmVyL1JlcXVlc3QvMzE1NTM5NzI=')
    expect(p.leadId).toBe(LEAD)
    expect(p.skipped).toBe(false)
    expect(p.error).toBeNull()
    expect(p.note).toBeNull()
  })

  it('parses a stage transition', () => {
    const p = parseSyncLogMessage(
      `topic=QUOTE_APPROVED item=123 lead=${LEAD} (stage Estimate Sent → Job in Progress)`,
    )
    expect(p.stageFrom).toBe('Estimate Sent')
    expect(p.stageTo).toBe('Job in Progress')
    expect(p.error).toBeNull()
  })

  it('captures a full error message including colons and quotes', () => {
    const p = parseSyncLogMessage(
      'topic=JOB_UPDATE item=Z2lkOi8vSm9iYmVyL0pvYi8xNTA0MzYxNzc= error=Job: null value in column "service_request_id" of relation "jobs" violates not-null constraint',
    )
    expect(p.topic).toBe('JOB_UPDATE')
    expect(p.error).toBe(
      'Job: null value in column "service_request_id" of relation "jobs" violates not-null constraint',
    )
  })

  it('stops the error at the " — note" separator and keeps the note', () => {
    const p = parseSyncLogMessage('topic=QUOTE_UPDATE item=9 error=quote_fetch: boom — extra context here')
    expect(p.error).toBe('quote_fetch: boom')
    expect(p.note).toBe('extra context here')
  })

  it('parses a destroy-style note without error', () => {
    const p = parseSyncLogMessage(
      `topic=REQUEST_DESTROY item=42 lead=${LEAD} — REQUEST_DESTROY: nulled jobber_request_id, jobber_assessment_id on lead "Joe Green"`,
    )
    expect(p.error).toBeNull()
    expect(p.note).toContain('Joe Green')
  })

  it('flags [skipped] unknown-topic rows', () => {
    const p = parseSyncLogMessage('[skipped] unknown topic=VISIT_COMPLETE')
    expect(p.skipped).toBe(true)
    expect(p.topic).toBe('VISIT_COMPLETE')
  })

  it('returns null topic for non-webhook rows (engagement breadcrumbs)', () => {
    const p = parseSyncLogMessage('[engagement:request] founded engagement abc for SR xyz')
    expect(p.topic).toBeNull()
  })

  it('does not treat a non-uuid lead= value as a lead id', () => {
    const p = parseSyncLogMessage('topic=JOB_UPDATE item=1 lead=not-a-uuid')
    expect(p.leadId).toBeNull()
  })

  // Capture-everything rows (previously-unlogged dispatcher paths).
  it('parses an unknown-account skip row (topic + item + note)', () => {
    const p = parseSyncLogMessage(
      'topic=JOB_COMPLETE item=555 — skipped: no connected location for account=acct-99',
    )
    expect(p.topic).toBe('JOB_COMPLETE')
    expect(p.itemRaw).toBe('555')
    expect(p.error).toBeNull()
    expect(p.note).toContain('no connected location for account=acct-99')
  })

  it('parses an unparseable-payload row (UNPARSEABLE topic + error)', () => {
    const p = parseSyncLogMessage(
      'topic=UNPARSEABLE error=bad_json — signature-valid body failed JSON.parse: this is {not json',
    )
    expect(p.topic).toBe('UNPARSEABLE')
    expect(p.error).toBe('bad_json')
    expect(p.note).toContain('failed JSON.parse')
  })

  it('parses a missing-fields row', () => {
    const p = parseSyncLogMessage('topic=UNKNOWN item=unknown error=missing_fields account=unknown')
    expect(p.topic).toBe('UNKNOWN')
    expect(p.error).toBe('missing_fields account=unknown')
  })

  // Intake rows (app/api/leads/intake) — the slug= token is the
  // diagnostic when the location never resolved (Make mapping typo).
  it('parses slug= from an intake location_not_found row', () => {
    const p = parseSyncLogMessage(
      '[intake] topic=LEAD_INTAKE error=location_not_found slug=palm-beach — no location with this slug (check the Make location mapping)',
    )
    expect(p.topic).toBe('LEAD_INTAKE')
    expect(p.slug).toBe('palm-beach')
    expect(p.error).toBe('location_not_found slug=palm-beach')
    expect(p.note).toContain('check the Make location mapping')
  })

  it('slug is null when the message has no slug= token', () => {
    const p = parseSyncLogMessage('[intake] topic=LEAD_INTAKE error=invalid_json')
    expect(p.slug).toBeNull()
    expect(p.error).toBe('invalid_json')
  })
})

describe('failureReason — inline reason for processed=false rows', () => {
  it('prefers the error= token (Phase-1 message format)', () => {
    const msg = 'topic=JOB_UPDATE item=1 error=quote_fetch: boom — extra context here'
    expect(failureReason(parseSyncLogMessage(msg), msg)).toBe('quote_fetch: boom')
  })

  it('legacy row without error= falls back to the " — " note tail', () => {
    const msg = 'topic=JOB_UPDATE item=150436177 — Job: null value in column "service_request_id" violates not-null constraint'
    expect(failureReason(parseSyncLogMessage(msg), msg)).toBe(
      'Job: null value in column "service_request_id" violates not-null constraint',
    )
  })

  it('legacy row with neither error= nor note falls back to the whole message', () => {
    const msg = 'topic=JOB_UPDATE item=150436177 failed hard'
    expect(failureReason(parseSyncLogMessage(msg), msg)).toBe(msg)
  })
})

describe('mapLandedStatus — recorded column → dashboard indicator', () => {
  it("'landed' → landed (✓)", () => {
    expect(mapLandedStatus('landed')).toBe('landed')
  })
  it("'not_landed' → stuck (▲ amber — the silent-stuck detector)", () => {
    expect(mapLandedStatus('not_landed')).toBe('stuck')
  })
  it("'na' → null ('—', processed-only)", () => {
    expect(mapLandedStatus('na')).toBeNull()
  })
  it("pre-migration NULL rows → null ('—'), never amber", () => {
    expect(mapLandedStatus(null)).toBeNull()
    expect(mapLandedStatus(undefined)).toBeNull()
  })
  it('unexpected values fail safe to null', () => {
    expect(mapLandedStatus('weird')).toBeNull()
  })
})

describe('friendlyTopic', () => {
  it('maps known topics to friendly names', () => {
    expect(friendlyTopic('INVOICE_PAID', false)).toBe('Invoice paid')
    expect(friendlyTopic('QUOTE_APPROVED', false)).toBe('Quote approved')
  })
  it('labels skipped topics as ignored and unknown rows as sync notes', () => {
    expect(friendlyTopic('VISIT_COMPLETE', true)).toBe('Ignored (VISIT_COMPLETE)')
    expect(friendlyTopic(null, false)).toBe('Sync note')
  })
  it('labels the capture-everything rows', () => {
    expect(friendlyTopic('UNPARSEABLE', false)).toBe('Unparseable event')
    expect(friendlyTopic('UNKNOWN', false)).toBe('Unknown event')
  })
})
