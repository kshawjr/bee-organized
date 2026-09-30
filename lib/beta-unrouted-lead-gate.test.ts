// @vitest-environment node
// Unrouted leads (loc_other) always reach a person — the gate half.
//
// loc_other is corporate's queue: leads whose zip no franchise holds. Zip
// routing makes it ~150 leads a month. The 2026-07 notifications_live seed
// left it MUTED ("Leslie is covered by Zoho"); it was switched on by hand in
// the database, and nothing stopped a hand switching it off again. These pins
// make that impossible from the database alone.
//
// The reader is REAL here and its client is mocked (the same split as
// notifications-live.test.ts); the send rail is pinned in
// beta-unrouted-lead-email.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const maybeSingleMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase-service', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => maybeSingleMock(),
  }
  return { supabaseService: { from: () => builder } }
})

import { resolveNotificationsLive } from '@/lib/notifications-live'

beforeEach(() => {
  maybeSingleMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('loc_other can never be muted', () => {
  // THE regression pin: if someone sets loc_other's notifications_live back to
  // false — or the rule in lib/notifications-live.ts is removed — this fails.
  it('loc_other with notifications_live = FALSE is still live', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { notifications_live: false, location_id: 'loc_other' },
      error: null,
    })
    expect(await resolveNotificationsLive('uuid-other')).toEqual({ live: true, unroutedQueue: true })
  })

  it('loc_other with a null flag (stale schema cache) is still live', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { notifications_live: null, location_id: 'loc_other' },
      error: null,
    })
    expect((await resolveNotificationsLive('uuid-other')).live).toBe(true)
  })

  it('loc_other with the flag on is live and marked as the unrouted queue', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { notifications_live: true, location_id: 'loc_other' },
      error: null,
    })
    expect(await resolveNotificationsLive('uuid-other')).toEqual({ live: true, unroutedQueue: true })
  })

  // The exception is loc_other ONLY. A franchise location switched off stays
  // off — the flag still protects owners from a double notification.
  it('any other location with the flag off stays muted', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { notifications_live: false, location_id: 'loc_omaha' },
      error: null,
    })
    expect(await resolveNotificationsLive('uuid-omaha')).toEqual({ live: false, reason: 'muted' })
  })

  it('a live franchise location is not marked as the unrouted queue', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { notifications_live: true, location_id: 'loc_portland' },
      error: null,
    })
    expect(await resolveNotificationsLive('uuid-portland')).toEqual({ live: true })
  })
})
