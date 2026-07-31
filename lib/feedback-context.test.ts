// Feedback record-context helpers (lib/feedback-context.ts) — the PII boundary
// and the held-migration soft-fallback. Behavior tests, not source pins.
import { describe, it, expect, vi } from 'vitest'
import {
  buildSafeContext,
  isMissingContextColumn,
  insertFeedbackRow,
  FEEDBACK_CONTEXT_KEYS,
} from '@/lib/feedback-context'

describe('buildSafeContext — id-only whitelist (issue 110a)', () => {
  it('keeps exactly the whitelisted keys and nothing else', () => {
    const ctx = buildSafeContext({
      kind: 'client',
      lead_id: 'lead-9',
      location_id: 'loc-uuid-1',
      screen: 'Clients',
      path: '/clients/lead-9',
      origin: 'client_profile_menu',
    })
    expect(ctx).toEqual({
      kind: 'client',
      lead_id: 'lead-9',
      location_id: 'loc-uuid-1',
      screen: 'Clients',
      path: '/clients/lead-9',
      origin: 'client_profile_menu',
    })
    // Every key it kept is on the whitelist (a subset — client reports don't
    // carry the engagement keys).
    expect([...FEEDBACK_CONTEXT_KEYS]).toEqual(expect.arrayContaining(Object.keys(ctx!)))
  })

  it('carries the engagement fields (kind/engagement_id/stage) for a deal report', () => {
    const ctx = buildSafeContext({
      kind: 'engagement',
      engagement_id: 'eng-1',
      lead_id: 'lead-9',
      location_id: 'loc-uuid-1',
      stage: 'Estimate',
      screen: 'Clients',
      path: '/clients/lead-9?e=eng-1',
      origin: 'engagement_panel_menu',
      // PII / deal specifics that must NOT survive:
      title: 'Garage organization',
      client_name: 'Pat Tester',
      total_paid: 900,
    })
    expect(ctx).toEqual({
      kind: 'engagement',
      engagement_id: 'eng-1',
      lead_id: 'lead-9',
      location_id: 'loc-uuid-1',
      stage: 'Estimate',
      screen: 'Clients',
      path: '/clients/lead-9?e=eng-1',
      origin: 'engagement_panel_menu',
    })
    const s = JSON.stringify(ctx)
    expect(s).not.toContain('Garage')       // no deal title
    expect(s).not.toContain('Pat Tester')   // no client name
    expect(s).not.toContain('900')          // no financials
  })

  it('DROPS PII / arbitrary keys — a tampered body cannot smuggle name/email/phone', () => {
    const ctx = buildSafeContext({
      lead_id: 'lead-9',
      name: 'Dana Client',
      email: 'dana@x.com',
      phone: '(561) 555-0100',
      address: '1 Main St',
      note: 'anything',
    })
    expect(ctx).toEqual({ lead_id: 'lead-9' })
    expect(JSON.stringify(ctx)).not.toContain('Dana')
    expect(JSON.stringify(ctx)).not.toContain('dana@x.com')
    expect(JSON.stringify(ctx)).not.toContain('555')
  })

  it('coerces to strings, trims, and caps length (path longer than the rest)', () => {
    const ctx = buildSafeContext({
      lead_id: 12345,
      screen: '  Clients  ',
      path: '/clients/' + 'a'.repeat(500),
    })
    expect(ctx!.lead_id).toBe('12345')
    expect(ctx!.screen).toBe('Clients')
    expect(ctx!.path.length).toBe(300)
  })

  it('returns null for empty / non-object / all-empty input (nothing to write)', () => {
    expect(buildSafeContext(null)).toBeNull()
    expect(buildSafeContext(undefined)).toBeNull()
    expect(buildSafeContext('lead-9')).toBeNull()
    expect(buildSafeContext({})).toBeNull()
    expect(buildSafeContext({ name: 'only PII here' })).toBeNull()
    expect(buildSafeContext({ lead_id: '   ' })).toBeNull()
  })
})

describe('isMissingContextColumn — recognizes the pre-migration error', () => {
  it('true for PostgREST schema-cache (PGRST204) and Postgres undefined_column (42703)', () => {
    expect(isMissingContextColumn({ code: 'PGRST204', message: "Could not find the 'context' column of 'feedback_items' in the schema cache" })).toBe(true)
    expect(isMissingContextColumn({ code: '42703', message: 'column "context" does not exist' })).toBe(true)
  })
  it('true when the message names the context column even without a known code', () => {
    expect(isMissingContextColumn({ message: "column feedback_items.context does not exist" })).toBe(true)
  })
  it('false for unrelated errors (real failures must still surface)', () => {
    expect(isMissingContextColumn({ code: '23505', message: 'duplicate key value' })).toBe(false)
    expect(isMissingContextColumn({ message: 'network error' })).toBe(false)
    expect(isMissingContextColumn(null)).toBe(false)
    expect(isMissingContextColumn(undefined)).toBe(false)
  })
})

describe('insertFeedbackRow — soft-fallback while the migration is HELD', () => {
  const OK = { data: { id: 'row-1' }, error: null }

  it('no context → single insert with the base row, contextDropped false', async () => {
    const runInsert = vi.fn(async () => OK)
    const res = await insertFeedbackRow(runInsert, { title: 't' }, null)
    expect(runInsert).toHaveBeenCalledTimes(1)
    expect(runInsert).toHaveBeenCalledWith({ title: 't' })
    expect(res.contextDropped).toBe(false)
    expect(res.data).toEqual({ id: 'row-1' })
  })

  it('column present → inserts WITH context in one call, contextDropped false', async () => {
    const runInsert = vi.fn(async () => OK)
    const ctx = { kind: 'client', lead_id: 'lead-9' }
    const res = await insertFeedbackRow(runInsert, { title: 't' }, ctx)
    expect(runInsert).toHaveBeenCalledTimes(1)
    expect(runInsert).toHaveBeenCalledWith({ title: 't', context: ctx })
    expect(res.contextDropped).toBe(false)
  })

  it('column MISSING → retries WITHOUT context; the report still files (contextDropped true)', async () => {
    const missing = { data: null, error: { code: 'PGRST204', message: "Could not find the 'context' column of 'feedback_items' in the schema cache" } }
    const runInsert = vi.fn()
      .mockResolvedValueOnce(missing) // first: with context → missing-column error
      .mockResolvedValueOnce(OK)      // retry: without context → succeeds
    const res = await insertFeedbackRow(runInsert as any, { title: 't' }, { lead_id: 'lead-9' })
    expect(runInsert).toHaveBeenCalledTimes(2)
    expect(runInsert.mock.calls[0][0]).toEqual({ title: 't', context: { lead_id: 'lead-9' } })
    expect(runInsert.mock.calls[1][0]).toEqual({ title: 't' }) // NO context on the retry
    expect(res.error).toBeNull()
    expect(res.data).toEqual({ id: 'row-1' })
    expect(res.contextDropped).toBe(true)
  })

  it('a REAL insert error (not missing-column) is returned as-is, no retry', async () => {
    const realErr = { data: null, error: { code: '23505', message: 'duplicate key value' } }
    const runInsert = vi.fn(async () => realErr)
    const res = await insertFeedbackRow(runInsert, { title: 't' }, { lead_id: 'lead-9' })
    expect(runInsert).toHaveBeenCalledTimes(1) // no retry
    expect(res.error).toEqual(realErr.error)
    expect(res.contextDropped).toBe(false)
  })
})
