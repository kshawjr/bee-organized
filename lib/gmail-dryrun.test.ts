// @vitest-environment node
//
// Gmail dry-run matching (step 3) — pins:
//   • parseAddresses across every header format we must survive
//   • dryRunMailbox issues ZERO write calls (mock supabase records any
//     insert/update/upsert/delete; the run must end with none)
//   • the lead query is batched (leads table queried once), never per message
//   • matching is case-insensitive against mixed-case DB emails — 941 of
//     15646 prod leads have them, so this is load-bearing, not cosmetic
//   • the classification counts and the loud zero-rows join failure
// All addresses below are mock @example.com data — no real mailbox contents.
import { describe, it, expect, vi } from 'vitest'

// gmail-dryrun imports supabaseService at module load (createClient needs
// env we don't set here). Every test injects its own supabase via deps.
vi.mock('./supabase-service', () => ({
  supabaseService: { from: () => { throw new Error('unused — tests inject supabase') } },
}))

import { parseAddresses } from './gmail'
import { dryRunMailbox } from './gmail-dryrun'

const MAILBOX = 'agent@beeorganized.com'

describe('parseAddresses', () => {
  it('parses a bare address', () => {
    expect(parseAddresses('a@b.com')).toEqual(['a@b.com'])
  })

  it('parses name-addr form and lowercases', () => {
    expect(parseAddresses('John Doe <John@B.com>')).toEqual(['john@b.com'])
  })

  it('parses comma-separated lists mixing forms', () => {
    expect(parseAddresses('a@b.com, Jane Roe <c@d.com>')).toEqual(['a@b.com', 'c@d.com'])
  })

  it('survives a quoted display name containing a comma', () => {
    expect(parseAddresses('"Doe, John" <j@x.com>')).toEqual(['j@x.com'])
  })

  it('dedupes case-variant repeats', () => {
    expect(parseAddresses('a@b.com, A@B.COM')).toEqual(['a@b.com'])
  })

  it('handles plus tags, underscores, dotted locals, hyphenated multi-label domains', () => {
    expect(parseAddresses('x_y.z+tag@ex-ample.co.uk')).toEqual(['x_y.z+tag@ex-ample.co.uk'])
  })

  it('returns [] for empty, null, undefined, and address-free values', () => {
    expect(parseAddresses('')).toEqual([])
    expect(parseAddresses(null)).toEqual([])
    expect(parseAddresses(undefined)).toEqual([])
    expect(parseAddresses('undisclosed-recipients:;')).toEqual([])
  })
})

// ---- mock supabase ---------------------------------------------------------
// Chainable read builder per table; any write method call is recorded and
// the assertion that `writes` stays empty is the point of the exercise.
function mockSupabase(tableRows: Record<string, any[]>) {
  const writes: string[] = []
  const tableQueries: Record<string, number> = {}
  const from = (table: string) => {
    tableQueries[table] = (tableQueries[table] ?? 0) + 1
    const rows = tableRows[table] ?? []
    const builder: any = {
      then: (resolve: any) => resolve({ data: rows, error: null }),
    }
    for (const m of ['select', 'eq', 'not', 'order', 'range', 'limit']) {
      builder[m] = () => builder
    }
    for (const m of ['insert', 'update', 'upsert', 'delete']) {
      builder[m] = () => {
        writes.push(`${table}.${m}`)
        return builder
      }
    }
    return builder
  }
  return { client: { from }, writes, tableQueries }
}

function mockGmail(messages: { id: string; threadId: string; headers: Record<string, string> }[]) {
  const listMessageIds = vi.fn(async () => ({
    messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })),
    nextPageToken: undefined,
  }))
  const getMessageMetadata = vi.fn(async (_mailbox: string, id: string) => {
    const m = messages.find((x) => x.id === id)!
    return { id: m.id, threadId: m.threadId, internalDate: '0', headers: m.headers }
  })
  return { listMessageIds, getMessageMetadata }
}

describe('dryRunMailbox', () => {
  const scopedTables = {
    hub_users: [{ location_id: 'uuid-1' }],
    locations: [{ slug: 'loc_test' }],
    leads: [
      { id: 'L1', email: 'lead1@example.com', location_id: 'loc_test' },
      { id: 'L2', email: 'shared@example.com', location_id: 'loc_test' },
      { id: 'L3', email: 'shared@example.com', location_id: 'loc_test' },
      { id: 'L4', email: 'CasEy@Example.com', location_id: 'loc_test' },
    ],
  }
  const scopedMessages = [
    { id: 'm1', threadId: 't1', headers: { from: 'Lead One <lead1@example.com>', to: MAILBOX } },
    { id: 'm2', threadId: 't1', headers: { from: MAILBOX, to: '"Doe, John" <shared@example.com>' } },
    { id: 'm3', threadId: 't2', headers: { from: 'unknown@example.com', to: MAILBOX } },
    { id: 'm4', threadId: 't3', headers: { from: MAILBOX, to: MAILBOX } },
    { id: 'm5', threadId: 't4', headers: { from: 'CASEY@EXAMPLE.COM', to: MAILBOX } },
  ]

  it('classifies messages, matches case-insensitively, and issues zero writes', async () => {
    const { client, writes, tableQueries } = mockSupabase(scopedTables)
    const gmail = mockGmail(scopedMessages)
    const result = await dryRunMailbox(MAILBOX, { deps: { supabase: client, ...gmail } })

    expect(writes).toEqual([])
    expect(tableQueries.leads).toBe(1) // batched — one leads query, not per-message

    expect(result.mailbox).toBe(MAILBOX)
    expect(result.locationScoped).toBe(true)
    expect(result.locationSlug).toBe('loc_test')
    expect(result.daysScanned).toBe(7)
    expect(result.capHit).toBe(false)
    expect(result.messagesScanned).toBe(5)
    expect(result.messagesWithExternalParticipants).toBe(4) // m4 is mailbox-only
    expect(result.messagesMatchedExactlyOneLead).toBe(2) // m1; m5 via mixed-case L4
    expect(result.messagesMatchedMultipleLeadsSameLocation).toBe(1) // m2 → L2+L3
    expect(result.messagesMatchedLeadsInMultipleLocations).toBe(0)
    expect(result.messagesUnmatched).toBe(1) // m3
    expect(result.distinctAddressesSeen).toBe(4)
    expect(result.distinctAddressesMatched).toBe(3)
    expect(result.distinctThreadsSeen).toBe(4)
    expect(result.matchesByLocationSlug).toEqual({ loc_test: 3 })
    expect(typeof result.elapsedMs).toBe('number')
  })

  it('falls back to fleet-wide matching when the mailbox has no location', async () => {
    const { client, writes } = mockSupabase({
      hub_users: [],
      locations: [],
      leads: [
        { id: 'L1', email: 'lead1@example.com', location_id: 'loc_a' },
        { id: 'L2', email: 'lead2@example.com', location_id: 'loc_b' },
      ],
    })
    const gmail = mockGmail([
      {
        id: 'm1',
        threadId: 't1',
        headers: { from: 'lead1@example.com', to: `${MAILBOX}, lead2@example.com` },
      },
    ])
    const result = await dryRunMailbox(MAILBOX, { deps: { supabase: client, ...gmail } })

    expect(writes).toEqual([])
    expect(result.locationScoped).toBe(false)
    expect(result.locationSlug).toBeNull()
    expect(result.messagesMatchedLeadsInMultipleLocations).toBe(1)
    expect(result.matchesByLocationSlug).toEqual({ loc_a: 1, loc_b: 1 })
  })

  it('fails loudly when hub_users.location_id joins zero locations rows', async () => {
    const { client } = mockSupabase({
      hub_users: [{ location_id: 'uuid-orphan' }],
      locations: [],
      leads: [],
    })
    const gmail = mockGmail([])
    await expect(
      dryRunMailbox(MAILBOX, { deps: { supabase: client, ...gmail } })
    ).rejects.toThrow(/zero rows/)
  })
})
