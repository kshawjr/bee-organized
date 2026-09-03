// @vitest-environment node
//
// The returning-client sequence follows the location's two Settings answers
// by VARIANT, the way the ordinary drips do. components/hive/shared/
// returningVariant.js is the one resolver both the intake (enrolment) and
// Settings › Emails (what the owner sees) read, so this pins the mapping and
// the fallback, and pins that the digest classifiers see the new keys through
// the same suffix rule as organizing-a..d (no special-casing).
import { describe, it, expect, vi } from 'vitest'

// The two health modules create the Supabase service client at import time;
// nothing here touches it.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('not used') } } }))

import {
  RETURNING_PATH_KEYS,
  RETURNING_FALLBACK_KEY,
  returningPathKeyFor,
  isReturningPathKey,
} from '@/components/hive/shared/returningVariant'
import { isRateQuotingPathKey } from '@/lib/rate-health'
import { isBookingPathKey } from '@/lib/booking-link-health'

describe('returningPathKeyFor — the letter follows the organizing default', () => {
  it('maps each organizing variant to the matching returning variant', () => {
    expect(returningPathKeyFor('organizing-a')).toBe('returning-a')
    expect(returningPathKeyFor('organizing-b')).toBe('returning-b')
    expect(returningPathKeyFor('organizing-c')).toBe('returning-c')
    expect(returningPathKeyFor('organizing-d')).toBe('returning-d')
  })

  it('no default (custom, or the two questions never answered) → returning-c, the variant with nothing to hold', () => {
    expect(RETURNING_FALLBACK_KEY).toBe('returning-c')
    expect(returningPathKeyFor(null)).toBe('returning-c')
    expect(returningPathKeyFor(undefined)).toBe('returning-c')
    expect(returningPathKeyFor('')).toBe('returning-c')
    expect(returningPathKeyFor('custom')).toBe('returning-c')
  })

  it('the four keys are exactly a..d, and only those count as returning', () => {
    expect(RETURNING_PATH_KEYS).toEqual(['returning-a', 'returning-b', 'returning-c', 'returning-d'])
    for (const k of RETURNING_PATH_KEYS) expect(isReturningPathKey(k)).toBe(true)
    // The pre-variant single key is retired; a stray row with it is inert.
    expect(isReturningPathKey('returning')).toBe(false)
    expect(isReturningPathKey('organizing-b')).toBe(false)
  })
})

describe('the ops digest sees the variants through the ordinary suffix rule', () => {
  it('rate: returning-a / -b quote it, -c / -d do not — same as organizing', () => {
    expect(RETURNING_PATH_KEYS.filter(isRateQuotingPathKey)).toEqual(['returning-a', 'returning-b'])
    expect(['organizing-a', 'organizing-b', 'organizing-c', 'organizing-d'].filter(isRateQuotingPathKey))
      .toEqual(['organizing-a', 'organizing-b'])
  })

  it('booking: returning-b / -d carry the link, -a / -c do not — same as organizing', () => {
    expect(RETURNING_PATH_KEYS.filter(isBookingPathKey)).toEqual(['returning-b', 'returning-d'])
    expect(['organizing-a', 'organizing-b', 'organizing-c', 'organizing-d'].filter(isBookingPathKey))
      .toEqual(['organizing-b', 'organizing-d'])
  })
})
