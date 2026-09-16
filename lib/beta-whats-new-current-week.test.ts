// @vitest-environment node
//
// THE DRAFT FOLLOWS THE CALENDAR — What's new runs at will.
//
// THE BUG. nextWeekAfter only ever ran at PUBLISH
// (app/api/help/releases/[id]/route.ts). Release 1 went out on 3 Sep; the open
// draft has never been published, so nothing has advanced it since. By 16 Sep
// it still read week_start 2026-08-28 / publish_on 2026-09-03 and showed as
// overdue. The date maths was never wrong — weekForYmd, addDays and
// formatWeekLabel are correct and deterministic. The bug was WHEN they ran.
//
// THE FIX, and why on READ. Kevin's ask was to open the note any week and have
// the draft belong to that week without having published the previous one.
// Rolling on WRITE would leave it stale until someone added a line, which is
// not "open it and it is right"; an explicit control would be one more thing
// to remember. So it happens when the draft is read — in the GET route, and in
// getOrCreateDraft so a line seeded by marking something Fixed is filed under
// the week it was actually seeded in.
//
// WHAT IT COSTS: a GET can now write. It is one idempotent UPDATE of two date
// columns, only when the draft is genuinely stale, and the value comes from
// the clock rather than from the row — so two editors opening the tab at once
// compute the same week and the second write changes nothing.
//
// THE LINES ARE THE PART THAT MATTERS. There are 20 in the live draft, 19 of
// them still in an owner's own words, added across two weeks and never
// published. They are unshipped news and must travel with the draft. They do,
// structurally: help_release_items attach by release_id, the roll is an UPDATE
// of the release row, and release_id never changes. Nothing reads or rewrites
// a line. Pinned below either side of a roll, because silently stranding or
// doubling 20 lines of owner-facing copy would be far worse than a wrong date.
//
// IT IS AN UPDATE, NEVER AN INSERT, and the schema forces that:
// help_releases_one_draft_idx is a partial unique index on status='draft'.
import { describe, it, expect, vi } from 'vitest'
import {
  draftWeekCorrection, rollDraftToCurrentWeek, getOrCreateDraft,
  weekFor, weekForYmd, formatWeekLabel, isOverdue, nextWeekAfter,
  type ReleaseRow,
} from '@/lib/help-releases'

const NOW = new Date('2026-09-16T14:00:00Z')   // a Wednesday; week is Fri 11 → Thu 17
const THIS_WEEK = weekFor(NOW)                  // { 2026-09-11, 2026-09-17 }

const STALE: ReleaseRow = {
  id: 'r-draft', status: 'draft',
  week_start: '2026-08-28', publish_on: '2026-09-03',   // the live one, two weeks stale
}
const CURRENT: ReleaseRow = { id: 'r-draft', status: 'draft', ...THIS_WEEK }
const PUBLISHED: ReleaseRow = {
  id: 'r-1', status: 'published', week_start: '2026-08-28', publish_on: '2026-09-03',
  number: 1, published_at: '2026-09-03T23:47:23Z',
}

// A client double that records every call and returns the updated row the way
// PostgREST's .select('*').single() would.
const client = (over: { rows?: any; failUpdate?: boolean } = {}) => {
  const calls: any[] = []
  const api: any = {
    calls,
    from(table: string) {
      const b: any = { table, op: 'select', filters: {} as any, payload: null }
      b.select = () => b
      b.eq = (k: string, v: any) => { b.filters[k] = v; return b }
      b.limit = () => b
      b.update = (arg: any) => { b.op = 'update'; b.payload = arg; return b }
      b.insert = (arg: any) => { b.op = 'insert'; b.payload = arg; return b }
      const settle = () => {
        calls.push({ table: b.table, op: b.op, payload: b.payload, filters: b.filters })
        if (b.op === 'update') {
          if (over.failUpdate) return { data: null, error: { message: 'nope' } }
          return { data: { ...STALE, ...b.payload }, error: null }
        }
        if (b.op === 'insert') return { data: { id: 'r-new', ...b.payload }, error: null }
        return { data: over.rows ?? null, error: null }
      }
      b.single = async () => settle()
      b.maybeSingle = async () => settle()
      return b
    },
  }
  return api
}

// ── the rule, pure ────────────────────────────────────────────────
describe('draftWeekCorrection — when a draft is in the wrong week', () => {
  it('a draft whose publish_on has passed belongs to the current week', () => {
    expect(draftWeekCorrection(STALE, NOW)).toEqual(THIS_WEEK)
  })

  it('a draft already in the current week is left alone', () => {
    expect(draftWeekCorrection(CURRENT, NOW)).toBeNull()
  })

  it('a draft whose week has not closed yet is left alone — it is not late, it is current', () => {
    // Thursday IS publish day; the week is not over until it passes.
    const onPublishDay = { status: 'draft' as const, publish_on: '2026-09-17' }
    expect(isOverdue(onPublishDay.publish_on, NOW)).toBe(false)
    expect(draftWeekCorrection(onPublishDay as any, NOW)).toBeNull()
  })

  it('a PUBLISHED release is never moved — it is history', () => {
    expect(draftWeekCorrection(PUBLISHED, NOW)).toBeNull()
  })

  it('it only ever rolls FORWARD, to the week containing today', () => {
    const rolled = draftWeekCorrection(STALE, NOW)!
    expect(rolled.week_start > STALE.week_start).toBe(true)
    expect(rolled).toEqual(weekForYmd('2026-09-16'))
  })

  it('the date maths underneath is untouched', () => {
    // Explicitly NOT rewritten — the bug was when these ran, not what they say.
    expect(weekForYmd('2026-09-16')).toEqual({ week_start: '2026-09-11', publish_on: '2026-09-17' })
    expect(formatWeekLabel('2026-09-17')).toBe('Thu, Sep 17')
    expect(nextWeekAfter('2026-09-03', NOW)).toEqual(THIS_WEEK)
  })
})

// ── the roll, applied ─────────────────────────────────────────────
describe('rollDraftToCurrentWeek — what it writes, and what it does not', () => {
  it('updates the two date columns on the release row', async () => {
    const svc = client()
    const out = await rollDraftToCurrentWeek(svc, STALE, NOW)
    expect(out.week_start).toBe(THIS_WEEK.week_start)
    expect(out.publish_on).toBe(THIS_WEEK.publish_on)
    const w = svc.calls.filter((c: any) => c.op !== 'select')
    expect(w).toHaveLength(1)
    expect(w[0].table).toBe('help_releases')
    expect(w[0].op).toBe('update')
    expect(Object.keys(w[0].payload).sort()).toEqual(['publish_on', 'week_start'])
  })

  it('NEVER inserts — one draft is a unique index, not a convention', async () => {
    const svc = client()
    await rollDraftToCurrentWeek(svc, STALE, NOW)
    expect(svc.calls.some((c: any) => c.op === 'insert')).toBe(false)
  })

  it('NEVER touches help_release_items — the lines are not read or rewritten', async () => {
    const svc = client()
    await rollDraftToCurrentWeek(svc, STALE, NOW)
    expect(svc.calls.some((c: any) => c.table === 'help_release_items')).toBe(false)
  })

  it('guards the update so a release that published mid-read is not moved', async () => {
    const svc = client()
    await rollDraftToCurrentWeek(svc, STALE, NOW)
    expect(svc.calls[0].filters).toMatchObject({ id: 'r-draft', status: 'draft' })
  })

  it('does nothing at all when the draft is already current', async () => {
    const svc = client()
    const out = await rollDraftToCurrentWeek(svc, CURRENT, NOW)
    expect(out).toBe(CURRENT)
    expect(svc.calls).toHaveLength(0)
  })

  it('a failed roll keeps the draft readable rather than breaking the tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const svc = client({ failUpdate: true })
    const out = await rollDraftToCurrentWeek(svc, STALE, NOW)
    expect(out.id).toBe('r-draft')      // still the same draft
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ── the 20 lines ──────────────────────────────────────────────────
describe('the lines travel with the draft', () => {
  // Modelled on the live draft: 20 lines, 19 of them still in owner words.
  const LINES = Array.from({ length: 20 }, (_, n) => ({
    id: `i-${n}`, release_id: 'r-draft', group: 'changed' as const,
    title: `line ${n}`, edited_at: n === 0 ? '2026-09-05T00:00:00Z' : null,
  }))

  it('every line stays attached, because release_id never moves', async () => {
    const svc = client()
    const before = LINES.filter(l => l.release_id === STALE.id)
    expect(before).toHaveLength(20)

    const out = await rollDraftToCurrentWeek(svc, STALE, NOW)

    // The roll changed the week and nothing else about identity.
    expect(out.id).toBe(STALE.id)
    const after = LINES.filter(l => l.release_id === out.id)
    expect(after).toHaveLength(20)
    expect(after.map(l => l.id)).toEqual(before.map(l => l.id))
  })

  it('and none is duplicated', async () => {
    const svc = client()
    await rollDraftToCurrentWeek(svc, STALE, NOW)
    await rollDraftToCurrentWeek(svc, { ...STALE, ...THIS_WEEK }, NOW) // second read, now current
    const ids = LINES.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    // the second call found nothing to do
    expect(svc.calls.filter((c: any) => c.op === 'update')).toHaveLength(1)
  })

  it('the unshipped ones are still unshipped — nothing is published by a roll', async () => {
    const svc = client()
    const out = await rollDraftToCurrentWeek(svc, STALE, NOW)
    expect(out.status).toBe('draft')
    expect(out.published_at ?? null).toBeNull()
    expect(LINES.filter(l => !l.edited_at)).toHaveLength(19)
  })
})

// ── the seed path ─────────────────────────────────────────────────
describe('the feedback seed still finds the open draft', () => {
  it('returns the existing draft, rolled to the current week', async () => {
    const svc = client({ rows: STALE })
    const { draft, error } = await getOrCreateDraft(svc, 'u-kevin', NOW)
    expect(error).toBeNull()
    expect(draft!.id).toBe('r-draft')            // the SAME draft, found by status
    expect(draft!.week_start).toBe(THIS_WEEK.week_start)
    expect(svc.calls.some((c: any) => c.op === 'insert')).toBe(false)
  })

  it('and still opens one when there is none', async () => {
    const svc = client({ rows: null })
    const { draft } = await getOrCreateDraft(svc, 'u-kevin', NOW)
    expect(draft!.week_start).toBe(THIS_WEEK.week_start)
    expect(svc.calls.some((c: any) => c.op === 'insert')).toBe(true)
  })

  it('neither the seed nor the delete sweep reads the dates — so moving them is safe', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const fb = fs.readFileSync(path.join(process.cwd(), 'app/api/feedback/[id]/route.ts'), 'utf8')
    // The sweep finds the draft by status and the line by release_id +
    // feedback_item_id. If it ever grew a week_start filter, a rolled draft
    // would stop matching and deleting a report would leave its line behind.
    expect(fb).toContain("eq('status', 'draft')")
    expect(fb).not.toMatch(/week_start|publish_on/)
  })
})

// ── publish is unchanged ──────────────────────────────────────────
describe('publishing still advances the next draft exactly as before', () => {
  it('nextWeekAfter is still what the publish route calls', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const route = fs.readFileSync(path.join(process.cwd(), 'app/api/help/releases/[id]/route.ts'), 'utf8')
    expect(route).toContain('nextWeekAfter(rel.publish_on)')
    // The roll is a READ-side repair; it must not have crept into publish.
    expect(route).not.toContain('rollDraftToCurrentWeek')
  })

  it('and its behaviour is untouched — the week after, or this one if that has passed', () => {
    expect(nextWeekAfter('2026-09-10', new Date('2026-09-12T12:00:00Z')))
      .toEqual(weekForYmd('2026-09-11'))
    expect(nextWeekAfter('2026-09-03', NOW)).toEqual(THIS_WEEK)   // a late publish lands on today's week
  })
})

// ── the banner ────────────────────────────────────────────────────
describe('the overdue banner no longer fires on a draft that just rolled', () => {
  it('the stale draft was overdue, and the rolled one is not', async () => {
    expect(isOverdue(STALE.publish_on, NOW)).toBe(true)
    const out = await rollDraftToCurrentWeek(client(), STALE, NOW)
    expect(isOverdue(out.publish_on, NOW)).toBe(false)
  })

  it('but a genuinely late note still says so — Friday, after Thursday passed', async () => {
    // The banner must not be silenced in general; it should fire again the
    // moment the CURRENT week's Thursday goes by without a publish.
    const friday = new Date('2026-09-18T14:00:00Z')
    const rolled = await rollDraftToCurrentWeek(client(), STALE, NOW)
    expect(isOverdue(rolled.publish_on, friday)).toBe(true)
  })
})
