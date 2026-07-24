// @vitest-environment node
//
// Missing-booking-link digest visibility — fetchBookingLinkHealth (which
// active locations are on booking default paths with no calendar_link) and
// the webhook-digest section it feeds. Like the blank-rate rollup it is a
// STANDING problem: it un-suppresses quiet windows and stays in the headline
// until a link is set, because the alternative is a client email that says
// "click here" and links nowhere.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = { rows: [] as any[], error: null as any }
  const builder = () => {
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'order', 'limit']) {
      b[m] = () => b
    }
    b.then = (res: any, rej: any) => Promise.resolve({ data: state.rows, error: state.error }).then(res, rej)
    return b
  }
  return { state, builder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => h.builder() },
}))

import { fetchBookingLinkHealth, isBookingPathKey } from '@/lib/booking-link-health'
import { buildBookingLinkHealthSection, buildWebhookDigest } from '@/lib/webhook-digest'

beforeEach(() => { h.state.rows = []; h.state.error = null })

describe('isBookingPathKey', () => {
  it('-b and -d point the client at a calendar; -a and -c do not', () => {
    expect(isBookingPathKey('organizing-b')).toBe(true)
    expect(isBookingPathKey('organizing-d')).toBe(true)
    expect(isBookingPathKey('moving-b')).toBe(true)
    expect(isBookingPathKey('moving-d')).toBe(true)
    expect(isBookingPathKey('organizing-a')).toBe(false)
    expect(isBookingPathKey('moving-c')).toBe(false)
    expect(isBookingPathKey(null)).toBe(false)
    expect(isBookingPathKey(undefined)).toBe(false)
  })
})

describe('fetchBookingLinkHealth', () => {
  it('flags active locations on -b/-d defaults with a blank calendar_link; link set or A/C-only pass clean', async () => {
    h.state.rows = [
      // Actively broken: booking default, no link.
      { location_id: 'loc_seattle', name: 'Seattle', default_drip_path: 'organizing-b', default_move_drip_path: 'moving-b', calendar_link: null },
      // Link set → healthy even on a booking path.
      { location_id: 'loc_portland', name: 'Portland', default_drip_path: 'organizing-d', default_move_drip_path: 'moving-d', calendar_link: 'https://cal.example/portland' },
      // Not a booking path → never asked for a link.
      { location_id: 'loc_omaha', name: 'Omaha', default_drip_path: 'organizing-c', default_move_drip_path: 'moving-c', calendar_link: null },
      // Whitespace is blank.
      { location_id: 'loc_kc', name: 'Kansas City', default_drip_path: 'organizing-d', default_move_drip_path: 'moving-a', calendar_link: '   ' },
    ]

    const { missingLink } = await fetchBookingLinkHealth()

    expect(missingLink.map(r => r.location_id)).toEqual(['loc_seattle', 'loc_kc'])
    // Only the booking-path halves are named — moving-a isn't a booking path.
    expect(missingLink[0].paths).toEqual(['organizing-b', 'moving-b'])
    expect(missingLink[1].paths).toEqual(['organizing-d'])
  })

  it('a read error degrades to an empty rollup rather than killing the digest', async () => {
    h.state.error = { message: 'boom' }
    await expect(fetchBookingLinkHealth()).resolves.toEqual({ missingLink: [] })
  })
})

describe('buildBookingLinkHealthSection', () => {
  it('healthy → no lines, no un-suppress', () => {
    expect(buildBookingLinkHealthSection({ missingLink: [] }))
      .toEqual({ lines: [], missingCount: 0, hasProblems: false })
    expect(buildBookingLinkHealthSection(undefined).hasProblems).toBe(false)
  })

  it('names each location, its booking paths, and where to fix it', () => {
    const s = buildBookingLinkHealthSection({
      missingLink: [{ location_id: 'loc_seattle', name: 'Seattle', paths: ['organizing-b'] }],
    })
    expect(s.hasProblems).toBe(true)
    expect(s.missingCount).toBe(1)
    expect(s.lines.join('\n')).toContain('Seattle')
    expect(s.lines.join('\n')).toContain('organizing-b')
    expect(s.lines.join('\n')).toMatch(/Settings/)
  })
})

describe('webhook digest integration', () => {
  it('a missing link un-suppresses an otherwise silent window and reaches the headline + body', () => {
    const digest = buildWebhookDigest({
      events: [],
      appUrl: 'https://app.test',
      bookingLinkHealth: {
        missingLink: [{ location_id: 'loc_seattle', name: 'Seattle', paths: ['organizing-b', 'moving-b'] }],
      },
    })

    expect(digest.suppressed).toBe(false)
    expect(digest.allClear).toBe(false)
    expect(digest.bookingLinkMissing).toBe(1)
    expect(digest.headline).toContain('NO LINK')
    expect(digest.text).toContain('Booking link missing')
  })

  it('healthy input keeps a quiet window suppressed and the section invisible', () => {
    const quiet = buildWebhookDigest({ events: [], appUrl: 'https://app.test', bookingLinkHealth: { missingLink: [] } })
    expect(quiet.suppressed).toBe(true)
    expect(quiet.bookingLinkMissing).toBe(0)
    expect(quiet.text).not.toContain('Booking link missing')
  })

  it('an omitted rollup changes nothing (pre-wiring callers keep working)', () => {
    const d = buildWebhookDigest({ events: [], appUrl: 'https://app.test' })
    expect(d.bookingLinkMissing).toBe(0)
    expect(d.suppressed).toBe(true)
  })
})
