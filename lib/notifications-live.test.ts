// @vitest-environment node
// The notifications_live reader (lib/notifications-live.ts) — Step 3's gate.
//
// Split from beta-notifications-live-gate.test.ts on purpose: that file mocks
// this module to drive the two send rails, and a file cannot both mock a module
// and exercise the real one. Here the module is real and its CLIENT is mocked.
//
// Pins, all of them one claim: the gate fails CLOSED. true → live; everything
// else — false, missing column, unknown location, thrown client, a null from a
// stale schema cache — → muted. The pre-migration case (missing column) is the
// load-bearing one: it is the state production is in between deploying this
// code and running migrations/notifications_live.sql, and it must not send.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const maybeSingleMock = vi.hoisted(() => vi.fn())
const selectMock = vi.hoisted(() => vi.fn())
const eqMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase-service', () => {
  const builder: any = {
    select: (...a: any[]) => { selectMock(...a); return builder },
    eq: (...a: any[]) => { eqMock(...a); return builder },
    maybeSingle: () => maybeSingleMock(),
  }
  return { supabaseService: { from: () => builder } }
})

import { resolveNotificationsLive } from '@/lib/notifications-live'

beforeEach(() => {
  maybeSingleMock.mockReset()
  selectMock.mockClear()
  eqMock.mockClear()
  // The module logs every fail-closed path to console.error by design (while it
  // fires, locations are muted). Silenced so the suite output stays readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('resolveNotificationsLive', () => {
  it('notifications_live = true → live, no reason', async () => {
    maybeSingleMock.mockResolvedValue({ data: { notifications_live: true }, error: null })
    expect(await resolveNotificationsLive('loc-1')).toEqual({ live: true })
  })

  it('notifications_live = false → muted', async () => {
    maybeSingleMock.mockResolvedValue({ data: { notifications_live: false }, error: null })
    expect(await resolveNotificationsLive('loc-1')).toEqual({ live: false, reason: 'muted' })
  })

  // Its OWN read, keyed by uuid — never a widening of a caller's location
  // select. That isolation is what stops a missing column from 500-ing lead
  // intake, so it is pinned, not assumed.
  it('reads only its own column, by location id', async () => {
    maybeSingleMock.mockResolvedValue({ data: { notifications_live: true }, error: null })
    await resolveNotificationsLive('loc-uuid-9')
    expect(selectMock).toHaveBeenCalledWith('notifications_live')
    expect(eqMock).toHaveBeenCalledWith('id', 'loc-uuid-9')
  })

  // THE pre-migration state. Fail CLOSED: a half-migrated deploy must never
  // double-notify the 44.
  it('read error (missing column, pre-migration) → FAILS CLOSED', async () => {
    maybeSingleMock.mockResolvedValue({
      data: null,
      error: { message: 'column locations.notifications_live does not exist' },
    })
    const v = await resolveNotificationsLive('loc-1')
    expect(v.live).toBe(false)
    expect(v.reason).toBe('read_failed')
    expect(v.error).toContain('does not exist')
  })

  it('unknown location → FAILS CLOSED', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null })
    expect(await resolveNotificationsLive('nope')).toEqual({
      live: false,
      reason: 'location_not_found',
    })
  })

  it('a thrown client → FAILS CLOSED, and never propagates', async () => {
    maybeSingleMock.mockRejectedValue(new Error('network down'))
    const v = await resolveNotificationsLive('loc-1')
    expect(v.live).toBe(false)
    expect(v.reason).toBe('read_failed')
    expect(v.error).toContain('network down')
  })

  // A null can reach us from a stale PostgREST schema cache mid-migration even
  // though the column is NOT NULL. Truthiness must not let it through.
  it('a null flag reads as muted, not truthy-by-accident', async () => {
    maybeSingleMock.mockResolvedValue({ data: { notifications_live: null }, error: null })
    expect(await resolveNotificationsLive('loc-1')).toEqual({ live: false, reason: 'muted' })
  })
})
