// @vitest-environment node
//
// Pure phase/park vocabulary for the sample-now / bulk-later import
// (lib/import-phase). What is pinned, and why it matters:
//
//   • LEAK 3b — the parked phase string must NEVER match phaseAutoContinues,
//     or an open onboarding/Settings tab re-POSTs and launches the bulk run
//     mid-day. This is the poller-side un-defer leak.
//   • LEAK 3c — isJobParked is the route-level guard every POST goes
//     through: NULL resume_after (all pre-existing jobs, every normal
//     import) is never parked; future = parked; past = window open.
//   • Normal imports unchanged — every phase the route actually writes
//     today keeps its exact auto-continue behavior.
//   • computeResumeAfter always lands on the NEXT 09:00 UTC, strictly in
//     the future (the off-hours window for every US territory).
import { describe, it, expect } from 'vitest'
import {
  PARKED_PHASE_PREFIX,
  PARK_RESUME_UTC_HOUR,
  DEFERRED_WRITE_PACE_MS,
  parkedPhase,
  isParkedPhase,
  phaseAutoContinues,
  isJobParked,
  computeResumeAfter,
} from '@/lib/import-phase'

describe('parkedPhase / isParkedPhase', () => {
  it('builds a parked phase carrying both counts', () => {
    const p = parkedPhase(75, 3352)
    expect(p.startsWith(PARKED_PHASE_PREFIX)).toBe(true)
    expect(p).toContain('75')
    expect(p).toContain('3277')   // remaining
  })

  it('isParkedPhase recognizes it and rejects everything else', () => {
    expect(isParkedPhase(parkedPhase(75, 3352))).toBe(true)
    expect(isParkedPhase('writing')).toBe(false)
    expect(isParkedPhase('batched — 200/1400, continuing')).toBe(false)
    expect(isParkedPhase(null)).toBe(false)
    expect(isParkedPhase(undefined)).toBe(false)
    expect(isParkedPhase('')).toBe(false)
  })

  it('remaining clamps at zero (sample covered everyone edge)', () => {
    expect(parkedPhase(80, 75)).toContain('0 resume overnight')
  })
})

describe('phaseAutoContinues — LEAK 3b (poller re-POST predicate)', () => {
  it('the parked phase NEVER auto-continues, for any counts', () => {
    expect(phaseAutoContinues(parkedPhase(75, 3352))).toBe(false)
    expect(phaseAutoContinues(parkedPhase(0, 0))).toBe(false)
    expect(phaseAutoContinues(`${PARKED_PHASE_PREFIX} — anything at all`)).toBe(false)
  })

  it('every phase the route writes today keeps its exact behavior', () => {
    // Auto-continue states (the poller drives the next segment):
    expect(phaseAutoContinues('fetching clients')).toBe(true)
    expect(phaseAutoContinues('fetching — continuing (2/4 entities)')).toBe(true)
    expect(phaseAutoContinues('writing')).toBe(true)
    expect(phaseAutoContinues('batched — 200/1400, continuing (time budget)')).toBe(true)
    // Non-continue states:
    expect(phaseAutoContinues('starting')).toBe(false)
    expect(phaseAutoContinues('incremental')).toBe(false)
    expect(phaseAutoContinues('done')).toBe(false)
    expect(phaseAutoContinues('Pausing 12s for Jobber API rate limit...')).toBe(false)
    expect(phaseAutoContinues(null)).toBe(false)
    expect(phaseAutoContinues('')).toBe(false)
  })
})

describe('isJobParked — LEAK 3c (route-level POST guard)', () => {
  const NOW = Date.parse('2026-07-23T20:00:00Z')

  it('NULL/absent resume_after is never parked — every pre-existing job and normal import', () => {
    expect(isJobParked(null, NOW)).toBe(false)
    expect(isJobParked(undefined, NOW)).toBe(false)
    expect(isJobParked('', NOW)).toBe(false)
  })

  it('future resume_after = parked; past or now = window open', () => {
    expect(isJobParked(new Date(NOW + 60_000).toISOString(), NOW)).toBe(true)
    expect(isJobParked(new Date(NOW - 1).toISOString(), NOW)).toBe(false)
    expect(isJobParked(new Date(NOW).toISOString(), NOW)).toBe(false)
  })

  it('an unparseable timestamp fails open (not parked) — never wedges a job shut', () => {
    expect(isJobParked('not-a-date', NOW)).toBe(false)
  })
})

describe('computeResumeAfter', () => {
  it('afternoon call → tonight at the resume hour (next occurrence)', () => {
    // 2026-07-23 20:00 UTC (1pm PDT onboarding call) → 2026-07-24 09:00 UTC.
    const at = computeResumeAfter(Date.parse('2026-07-23T20:00:00Z'))
    expect(at).toBe('2026-07-24T09:00:00.000Z')
  })

  it('just before the hour → later the same day; at/after → tomorrow (strictly future)', () => {
    expect(computeResumeAfter(Date.parse('2026-07-23T08:59:00Z')))
      .toBe(`2026-07-23T0${PARK_RESUME_UTC_HOUR}:00:00.000Z`)
    expect(computeResumeAfter(Date.parse('2026-07-23T09:00:00Z')))
      .toBe('2026-07-24T09:00:00.000Z')
  })

  it('always strictly in the future', () => {
    for (const iso of ['2026-07-23T00:00:00Z', '2026-07-23T08:59:59Z', '2026-07-23T09:00:01Z', '2026-07-23T23:59:59Z']) {
      const now = Date.parse(iso)
      expect(Date.parse(computeResumeAfter(now))).toBeGreaterThan(now)
    }
  })

  it('pacing constant stays in the 100–250ms band the overnight budget assumes', () => {
    expect(DEFERRED_WRITE_PACE_MS).toBeGreaterThanOrEqual(100)
    expect(DEFERRED_WRITE_PACE_MS).toBeLessThanOrEqual(250)
  })
})
