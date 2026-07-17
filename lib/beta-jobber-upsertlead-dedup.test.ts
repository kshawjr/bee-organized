// lib/beta-jobber-upsertlead-dedup.test.ts
// ─────────────────────────────────────────────────────────────
// Pins the insert–insert race recovery in upsertLead: when two webhooks
// for the same NEW Jobber client land together (REQUEST_CREATE +
// REQUEST_UPDATE), the loser's INSERT trips leads_jobber_client_id_location_idx
// (23505). Instead of throwing, it must resolve to the winner's row and
// update it — idempotent, no duplicate-key surfaced.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

// FIFO of responses for terminal reads (.maybeSingle / .single).
const reads: any[] = []
const updates: Array<{ patch: any; id: string }> = []
const inserts: any[] = []

function leadsBuilder() {
  let lastInsert: any = null
  const b: any = {
    select: () => b,
    eq: () => b,
    // The adoption pass (upsertLead → findAdoptionCandidate) runs between
    // the existence SELECT and the INSERT, so this builder must speak the
    // lead-match vocabulary too: queryLeadMatches chains .or/.not/.range
    // and awaits the builder directly, and the name probe adds .is/.ilike.
    // Without these the chain throws a TypeError that upsertLead's
    // fall-back-to-insert catch swallows — these tests would still pass,
    // but via the degrade path, silently covering nothing.
    or: () => b,
    not: () => b,
    range: () => b,
    is: () => b,
    ilike: () => b,
    // Awaiting the builder = a non-terminal list read (the match queries).
    // Resolves to "no matches" WITHOUT touching `reads`, which belongs to
    // the .maybeSingle()/.single() FIFO above. So the adoption pass runs
    // for real, finds nothing, and hands off to the insert path under test.
    then: (res: any, rej: any) =>
      Promise.resolve({ data: [], error: null }).then(res, rej),
    maybeSingle: async () => reads.shift() ?? { data: null, error: null },
    single: async () => reads.shift() ?? { data: null, error: null },
    insert: (payload: any) => { lastInsert = payload; inserts.push(payload); return b },
    update: (patch: any) => ({
      eq: async (_col: string, id: string) => { updates.push({ patch, id }); return { error: null } },
    }),
  }
  void lastInsert
  return b
}
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => leadsBuilder() },
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'owner-1' })),
}))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { upsertLead } from '@/lib/jobber-import'

const CLIENT = {
  id: 'gid://Jobber/Client/999',
  firstName: 'Sarah', lastName: 'Gokhale',
  emails: [{ address: 's@x.com', primary: true }],
  phones: [], createdAt: '2026-07-13T00:00:00Z',
}

beforeEach(() => {
  reads.length = 0
  updates.length = 0
  inserts.length = 0
})

describe('upsertLead insert–insert race', () => {
  it('recovers from a 23505 dup-key by updating the winner row instead of throwing', async () => {
    // 1) initial existence SELECT → miss; 2) INSERT → dup-key; 3) winner re-SELECT.
    reads.push({ data: null, error: null })
    reads.push({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "leads_jobber_client_id_location_idx"' },
    })
    reads.push({ data: { id: 'winner-lead', stage: 'Request' }, error: null })

    const out = await upsertLead(CLIENT, 'loc_portland', 'uuid-portland')

    expect(out).toEqual({ id: 'winner-lead', created: false, stage: 'Request' })
    expect(inserts).toHaveLength(1)                 // attempted the insert once
    expect(updates.at(-1)?.id).toBe('winner-lead')  // then updated the winner
  })

  it('still throws on a non-dup-key insert error', async () => {
    reads.push({ data: null, error: null })
    reads.push({ data: null, error: { code: '23503', message: 'fk violation' } })

    await expect(upsertLead(CLIENT, 'loc_portland', 'uuid-portland')).rejects.toThrow(/fk violation/)
  })
})
