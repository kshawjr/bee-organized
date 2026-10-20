// @vitest-environment node
//
// Posting Other's card for leads already in Other (lib/other-card-backlog.ts
// planBacklog, run by scripts/post-other-cards.mjs).
//   • only Other, not binned, oldest first
//   • already posted → skipped (no double posts); --again re-posts ONE lead
//   • --all leaves out test records; --lead posts the named one regardless
// and the script: dry run unless --commit, posts through intake's own
// notifyNewLeadSlack + logSlackNotification.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planBacklog, isTestRecord, resolvedReason, type BacklogLead } from '@/lib/other-card-backlog'

const lead = (id: string, created: string, over: Partial<BacklogLead> = {}): BacklogLead => ({
  id, first_name: 'Real', last_name: 'Person', location_id: 'loc_other', is_junk: false, created_at: created, ...over,
})
// The real shape of Other on 20 Oct 2026: seven real leads + two test records.
const OTHER = [
  lead('lyndsay', '2026-10-05T18:31:04Z'),
  lead('jessica', '2026-10-09T10:00:00Z'),
  lead('testtest', '2026-10-12T10:00:00Z', { first_name: 'test', last_name: 'test' }),
  lead('sabrina', '2026-10-13T09:00:00Z'),
  lead('zach', '2026-10-13T10:00:00Z'),
  lead('alice', '2026-10-13T21:04:05Z'),
  lead('mark', '2026-10-19T10:00:00Z'),
  lead('roza', '2026-10-20T01:00:00Z', { first_name: 'Roza', last_name: 'TEST' }),
  lead('loujean', '2026-10-20T02:40:34Z'),
]
const ids = (p: { post: BacklogLead[] }) => p.post.map((l) => l.id)

describe('--all: the backlog', () => {
  it('the seven real leads, oldest first; both test records left out', () => {
    const p = planBacklog({ leads: [...OTHER].reverse(), posted: new Set() })
    expect(ids(p)).toEqual(['lyndsay', 'jessica', 'sabrina', 'zach', 'alice', 'mark', 'loujean'])
    expect(p.skipped).toEqual([{ id: 'testtest', reason: 'test_record' }, { id: 'roza', reason: 'test_record' }])
  })

  it('a lead already posted is skipped — a second run posts nothing', () => {
    const first = planBacklog({ leads: OTHER, posted: new Set() })
    const second = planBacklog({ leads: OTHER, posted: new Set(ids(first)) })
    expect(ids(second)).toEqual([])
    expect(second.skipped.filter((s) => s.reason === 'already_posted').map((s) => s.id)).toEqual(ids(first))
  })

  it('binned leads and leads no longer in Other are skipped and say why', () => {
    const p = planBacklog({
      leads: [lead('a', '2026-10-01T00:00:00Z', { is_junk: true }), lead('b', '2026-10-02T00:00:00Z', { location_id: 'loc_reno' }), lead('c', '2026-10-03T00:00:00Z')],
      posted: new Set(),
    })
    expect(ids(p)).toEqual(['c'])
    expect(p.skipped).toEqual([{ id: 'a', reason: 'binned' }, { id: 'b', reason: 'not_in_other' }])
  })

  it('same created time → ordered by id, so the order is repeatable', () => {
    const p = planBacklog({ leads: [lead('b', '2026-10-01T00:00:00Z'), lead('a', '2026-10-01T00:00:00Z')], posted: new Set() })
    expect(ids(p)).toEqual(['a', 'b'])
  })

  it('--again with --all is refused', () => {
    expect(() => planBacklog({ leads: OTHER, posted: new Set(), again: true })).toThrow('--again needs --lead')
  })
})

// The real state of Other on 20 Oct 2026, after Leslie's work: six of the
// seven had been dismissed AND sent the no-coverage email. Only Zach is open.
const NOW = Date.parse('2026-10-20T22:00:00Z')
const handled = { inbox_dismissed_at: '2026-10-13T20:17:59Z', no_coverage_sent: true }
const REAL = [
  lead('lyndsay', '2026-10-05T18:31:04Z', handled),
  lead('jessica', '2026-10-09T10:00:00Z', handled),
  lead('testtest', '2026-10-12T10:00:00Z', { first_name: 'test', last_name: 'test' }),
  lead('sabrina', '2026-10-13T09:00:00Z', handled),
  lead('zach', '2026-10-13T10:00:00Z'),
  lead('alice', '2026-10-13T21:04:05Z', handled),
  lead('mark', '2026-10-19T10:00:00Z', handled),
  lead('loujean', '2026-10-20T02:40:34Z', handled),
]

describe('resolved leads never get a card (Bee Hub\'s Needs-transfer test, plus two)', () => {
  it('the real backlog on 20 Oct: only Zach is open', () => {
    const p = planBacklog({ leads: REAL, posted: new Set(), nowMs: NOW })
    expect(ids(p)).toEqual(['zach'])
    expect(p.skipped.filter((s) => s.reason === 'dismissed').map((s) => s.id)).toEqual(['lyndsay', 'jessica', 'sabrina', 'alice', 'mark', 'loujean'])
  })

  it.each([
    ['archived', { archived_at: '2026-10-01T00:00:00Z' }],
    ['dismissed', { inbox_dismissed_at: '2026-10-01T00:00:00Z' }],
    ['snoozed', { snoozed_until: '2026-10-25T00:00:00Z' }],
    ['no_coverage_sent', { no_coverage_sent: true }],
    ['has_engagement', { has_engagement: true }],
    ['in_jobber', { in_jobber: true }],
  ])('%s → skipped', (reason, over) => {
    const p = planBacklog({ leads: [lead('x', '2026-10-01T00:00:00Z', over as any)], posted: new Set(), nowMs: NOW })
    expect(p).toEqual({ post: [], skipped: [{ id: 'x', reason }] })
  })

  it('a no-coverage email with NO dismiss (the dismiss write failed) still means no card', () => {
    expect(resolvedReason(lead('x', '2026-10-01T00:00:00Z', { no_coverage_sent: true, inbox_dismissed_at: null }), NOW)).toBe('no_coverage_sent')
  })

  it('a snooze that has run out is open again', () => {
    const p = planBacklog({ leads: [lead('x', '2026-10-01T00:00:00Z', { snoozed_until: '2026-10-19T00:00:00Z' })], posted: new Set(), nowMs: NOW })
    expect(ids(p)).toEqual(['x'])
  })

  it('--lead and --again never revive a resolved lead', () => {
    for (const over of [{ inbox_dismissed_at: '2026-10-01T00:00:00Z' }, { no_coverage_sent: true }, { has_engagement: true }, { archived_at: '2026-10-01T00:00:00Z' }]) {
      const p = planBacklog({ leads: [lead('x', '2026-10-01T00:00:00Z', over as any)], posted: new Set(['x']), only: 'x', again: true, nowMs: NOW })
      expect(ids(p)).toEqual([])
    }
  })

  it('an open lead with every field empty is open', () => {
    expect(resolvedReason(lead('x', '2026-10-01T00:00:00Z'), NOW)).toBeNull()
  })
})

describe('--lead: one named lead (the tests use Roza TEST)', () => {
  it('posts a test record when named', () => {
    expect(ids(planBacklog({ leads: OTHER, posted: new Set(), only: 'roza' }))).toEqual(['roza'])
  })

  it('test 1 posted it → a plain re-run skips it', () => {
    const p = planBacklog({ leads: OTHER, posted: new Set(['roza']), only: 'roza' })
    expect(ids(p)).toEqual([])
    expect(p.skipped).toEqual([{ id: 'roza', reason: 'already_posted' }])
  })

  it('test 2: --again re-posts it', () => {
    expect(ids(planBacklog({ leads: OTHER, posted: new Set(['roza']), only: 'roza', again: true }))).toEqual(['roza'])
  })

  it('--again never revives a binned lead or one that has left Other', () => {
    const leads = [lead('x', '2026-10-01T00:00:00Z', { location_id: 'loc_greensboro' })]
    expect(planBacklog({ leads, posted: new Set(['x']), only: 'x', again: true }).skipped).toEqual([{ id: 'x', reason: 'not_in_other' }])
    const binned = [lead('y', '2026-10-01T00:00:00Z', { is_junk: true })]
    expect(planBacklog({ leads: binned, posted: new Set(), only: 'y', again: true }).skipped).toEqual([{ id: 'y', reason: 'binned' }])
  })

  it('a lead id that does not exist → not_found, nothing posted', () => {
    expect(planBacklog({ leads: OTHER, posted: new Set(), only: 'nope' })).toEqual({ post: [], skipped: [{ id: 'nope', reason: 'not_found' }] })
  })

  it('--lead only ever posts that one lead', () => {
    expect(ids(planBacklog({ leads: OTHER, posted: new Set(), only: 'mark' }))).toEqual(['mark'])
  })
})

describe('isTestRecord', () => {
  it.each([
    [{ first_name: 'test', last_name: 'test' }, true],
    [{ first_name: 'Roza', last_name: 'TEST' }, true],
    [{ first_name: ' Test ', last_name: null }, true],
    [{ first_name: 'Testa', last_name: 'Rossa' }, false],
    [{ first_name: 'Contest', last_name: 'Winner' }, false],
    [{ first_name: null, last_name: null }, false],
  ])('%j → %s', (l, yes) => {
    expect(isTestRecord(l as any)).toBe(yes)
  })
})

describe('the script', () => {
  const s = readFileSync(join(process.cwd(), 'scripts/post-other-cards.mjs'), 'utf8')

  it('posts nothing without --commit: the dry-run exit comes before the first post', () => {
    expect(s).toContain("const COMMIT = has('--commit')")
    const skip = s.indexOf('if (!COMMIT) continue')
    expect(skip).toBeGreaterThan(-1)
    expect(s.indexOf('await notifyNewLeadSlack(')).toBeGreaterThan(skip)
  })

  it('posts through intake\'s own path and logs each post the same way', () => {
    expect(s).toContain("/lib/slack-bot.ts")
    expect(s).toContain('await notifyNewLeadSlack({ locationId: other.id, locationName: other.name, baseUrl: BASE_URL, lead })')
    expect(s).toContain('await logSlackNotification(res, ctx)')
  })

  it('decides what to post with the tested rules, from accepted Slack rows at Other', () => {
    expect(s).toContain('/lib/other-card-backlog.ts')
    expect(s).toContain('planBacklog({ leads, posted, only: ONLY, again: AGAIN })')
    expect(s).toContain(".eq('channel', 'slack')")
    expect(s).toContain(".eq('send_status', 'accepted')")
    expect(s).toContain(".eq('location_slug', OTHER_SLUG)")
  })

  it('refuses --again without --lead, and needs exactly one of --lead / --all', () => {
    expect(s).toContain('if (AGAIN && !ONLY) {')
    expect(s).toContain('if (!!ALL === !!ONLY) {')
  })

  it('"already posted" and "no-coverage sent" each count only ACCEPTED sends — a failed one never resolves a lead', () => {
    expect(s).toContain(".eq('channel', 'slack')\n    .eq('location_slug', OTHER_SLUG)\n    .eq('send_status', 'accepted')\n    .in('lead_id', ids)")
    expect(s).toContain(".eq('email_kind', 'no_coverage_optin')\n    .eq('send_status', 'accepted')\n    .in('lead_id', ids)")
  })

  it('reads what resolves a lead: no-coverage emails, engagements, Jobber ids, the Inbox holds', () => {
    expect(s).toContain(".eq('email_kind', 'no_coverage_optin')")
    expect(s).toContain(".from('engagements').select('client_id').in('client_id', ids)")
    for (const col of ['archived_at', 'inbox_dismissed_at', 'snoozed_until', 'jobber_client_id', 'jobber_sync_status']) expect(s).toContain(col)
  })

  it('never writes to the lead — the only write is the log row', () => {
    expect(s).not.toMatch(/\.update\(|\.insert\(|\.delete\(|\.upsert\(/)
  })
})
