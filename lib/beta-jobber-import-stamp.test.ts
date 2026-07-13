// lib/beta-jobber-import-stamp.test.ts
// ─────────────────────────────────────────────────────────────
// Pins the fail-loud completion-stamp write. NW Arkansas (2026-07-09)
// finished a real import — 233/233 clients — but the tail-end write to
// locations.jobber_initial_import_completed_at failed and was swallowed,
// leaving a completed import ungated so the "Start Import" CTA kept
// showing. Supabase's .update() reports DB failures via a returned
// `{ error }` (it does NOT throw), so a naive try/catch never sees them.
//
// writeImportCompletionStamp must: inspect that returned error, retry
// once, and hand back { ok:false } on persistent failure so the caller
// surfaces it instead of reporting clean success — while a healthy write
// still sets the stamp exactly as before.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

// FIFO of results returned by .eq() (the terminal await of .update().eq()).
const results: any[] = []
// Every patch handed to .update(), in order — proves what got written.
const patches: any[] = []
// How many times .eq() actually ran — proves retry count.
let attempts = 0

function locationsBuilder() {
  const b: any = {
    update: (patch: any) => {
      patches.push(patch)
      return {
        eq: async (_col: string, _id: string) => {
          attempts++
          const next = results.shift() ?? { error: null }
          if (next.throws) throw new Error(next.throws)
          return next
        },
      }
    },
  }
  return b
}

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => locationsBuilder() },
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { writeImportCompletionStamp } from '@/lib/jobber-import'

beforeEach(() => {
  results.length = 0
  patches.length = 0
  attempts = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('writeImportCompletionStamp', () => {
  it('writes the stamp on a healthy import (one attempt, ok)', async () => {
    const out = await writeImportCompletionStamp('uuid-nwark', {
      label: 'NW Arkansas (loc_nwark) job=abc',
      stampedAt: '2026-07-09T00:00:00.000Z',
    })

    expect(out).toEqual({ ok: true })
    expect(attempts).toBe(1)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toEqual({ jobber_initial_import_completed_at: '2026-07-09T00:00:00.000Z' })
  })

  it('does NOT report clean success when the DB returns an error — retries once, then ok:false', async () => {
    // Both attempts come back with a returned error (never thrown).
    results.push({ error: { message: 'permission denied for table locations' } })
    results.push({ error: { message: 'permission denied for table locations' } })

    const out = await writeImportCompletionStamp('uuid-nwark', { label: 'NW Arkansas (loc_nwark) job=abc' })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/permission denied/)
    expect(attempts).toBe(2)                // tried, then retried once
    expect(console.error).toHaveBeenCalled()
  })

  it('recovers on the retry when the first attempt fails transiently', async () => {
    results.push({ error: { message: 'deadlock detected' } }) // attempt 1 fails
    // attempt 2 falls through to the default { error: null } → success

    const out = await writeImportCompletionStamp('uuid-nwark')

    expect(out).toEqual({ ok: true })
    expect(attempts).toBe(2)
  })

  it('treats a thrown (network) failure the same as a returned error', async () => {
    results.push({ throws: 'ECONNRESET' })
    results.push({ throws: 'ECONNRESET' })

    const out = await writeImportCompletionStamp('uuid-nwark')

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/ECONNRESET/)
    expect(attempts).toBe(2)
  })
})
