// @vitest-environment node
//
// Backfill of the lead source on webhook-arrived leads (30 Sept 2026) —
// scripts/backfill-lead-source.mjs and the decisions in
// lib/lead-source-backfill.ts.
//
// About 380 leads came in through the Jobber webhook with a blank source
// because Bee Hub never asked Jobber for it. Pinned here:
//   · a blank lead gets Jobber's source
//   · a lead whose source was set since is left alone — at plan time AND at
//     write time
//   · Jobber's stamp of our own app name is treated as blank
//   · unrecognised values come through as typed; "google" lands as "Google"
//   · a client that can't be read is never mistaken for "no source"
//   · --undo restores exactly, and leaves alone anything changed since
//   · the script only writes leads.source, never renews a token without
//     --refresh, and paces itself
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  planSourceBackfill,
  executeSourceBackfill,
  undoSourceBackfill,
  paceWaitMs,
  isBlankSource,
  type BackfillLead,
  type JobberAnswer,
  type SourceWriter,
} from '@/lib/lead-source-backfill'

const lead = (id: string, over: Partial<BackfillLead> = {}): BackfillLead => ({
  id, location_id: 'loc_ctshoreline', jobber_client_id: `jc-${id}`, source: null, ...over,
})
const client = (leadSource: string | null): JobberAnswer => ({ kind: 'client', leadSource })
const answers = (o: Record<string, JobberAnswer>) => new Map(Object.entries(o))

// An in-memory leads table with the SAME guard the script's PostgREST write
// uses: the row changes only if its source is currently exactly `expected`.
function table(rows: Record<string, { source: string | null; [k: string]: any }>) {
  const db = structuredClone(rows)
  const writes: Array<{ id: string; expected: string | null; next: string | null }> = []
  const write: SourceWriter = async (id, expected, next) => {
    writes.push({ id, expected, next })
    if (!(id in db) || db[id].source !== expected) return false
    db[id].source = next
    return true
  }
  return { db, write, writes }
}

describe('planSourceBackfill', () => {
  it('a blank lead gets Jobber\'s source', () => {
    const plan = planSourceBackfill([lead('a')], answers({ a: client('Referral') }))
    expect(plan.fills).toEqual([{
      id: 'a', slug: 'loc_ctshoreline', jobber_client_id: 'jc-a', jobberValue: 'Referral',
      before: { source: null }, after: { source: 'Referral' },
    }])
  })

  it('an empty-string or whitespace source counts as blank too', () => {
    const plan = planSourceBackfill(
      [lead('a', { source: '' }), lead('b', { source: '   ' })],
      answers({ a: client('Yelp'), b: client('Yelp') }),
    )
    expect(plan.fills.map(f => [f.id, f.before.source, f.after.source])).toEqual([
      ['a', '', 'Yelp'], ['b', '   ', 'Yelp'],
    ])
    expect(isBlankSource(null)).toBe(true)
    expect(isBlankSource('Website')).toBe(false)
  })

  it('a lead whose source was set since is left alone', () => {
    const plan = planSourceBackfill(
      [lead('a', { source: 'Word of Mouth' })],
      answers({ a: client('Google') }),
    )
    expect(plan.fills).toEqual([])
    expect(plan.alreadySet).toEqual(['a'])
  })

  it('the app stamp is treated as blank — whatever its capitals', () => {
    const plan = planSourceBackfill(
      [lead('a'), lead('b')],
      answers({ a: client('Bee Organized Interface'), b: client('bee organized interface') }),
    )
    expect(plan.fills).toEqual([])
    expect(plan.appStampOnly).toEqual(['a', 'b'])
    expect(plan.noSourceInJobber).toEqual([])
  })

  it('unrecognised values come through as typed', () => {
    const plan = planSourceBackfill(
      [lead('a'), lead('b')],
      answers({ a: client('Hershey Mills Ads'), b: client('Quarry Days') }),
    )
    expect(plan.fills.map(f => f.after.source)).toEqual(['Hershey Mills Ads', 'Quarry Days'])
  })

  it('uses the live path\'s mapping: "google" and "Google" land as one thing, ig → Instagram', () => {
    const plan = planSourceBackfill(
      [lead('a'), lead('b'), lead('c')],
      answers({ a: client('google'), b: client('Google'), c: client(' ig ') }),
    )
    expect(plan.fills.map(f => f.after.source)).toEqual(['Google', 'Google', 'Instagram'])
    // what Jobber actually holds is kept in the report beside what is stored
    expect(plan.fills.map(f => f.jobberValue)).toEqual(['google', 'Google', 'ig'])
  })

  it('Jobber having nothing leaves the lead blank', () => {
    const plan = planSourceBackfill(
      [lead('a'), lead('b')],
      answers({ a: client(null), b: client('  ') }),
    )
    expect(plan.fills).toEqual([])
    expect(plan.noSourceInJobber).toEqual(['a', 'b'])
  })

  it('a client that is gone or could not be read is reported, never filled and never called "no source"', () => {
    const plan = planSourceBackfill(
      [lead('a'), lead('b'), lead('c')],
      answers({ a: { kind: 'gone' }, b: { kind: 'unreadable', error: '401 — token not accepted' } }),
    )
    expect(plan.fills).toEqual([])
    expect(plan.goneFromJobber).toEqual(['a'])
    expect(plan.unreadable).toEqual([
      { id: 'b', error: '401 — token not accepted' },
      { id: 'c', error: 'not asked' },
    ])
    expect(plan.noSourceInJobber).toEqual([])
  })
})

describe('executeSourceBackfill', () => {
  it('writes the source on a blank lead — and only the source', async () => {
    const t = table({ a: { source: null, stage: 'New', paused: true } })
    const plan = planSourceBackfill([lead('a')], answers({ a: client('Referral') }))
    const out = await executeSourceBackfill(t.write, plan.fills)
    expect(out).toEqual({ written: ['a'], skipped: [] })
    expect(t.db.a).toEqual({ source: 'Referral', stage: 'New', paused: true })
  })

  it('a source set BETWEEN the read and the write is never overwritten', async () => {
    const t = table({ a: { source: null }, b: { source: null } })
    const plan = planSourceBackfill(
      [lead('a'), lead('b')],
      answers({ a: client('Google'), b: client('Google') }),
    )
    t.db.a.source = 'Word of Mouth' // the owner picks one while the script is running
    const out = await executeSourceBackfill(t.write, plan.fills)
    expect(out.written).toEqual(['b'])
    expect(out.skipped).toEqual([{ id: 'a', why: 'source was set since the plan was read — left alone' }])
    expect(t.db.a.source).toBe('Word of Mouth')
    expect(t.db.b.source).toBe('Google')
  })

  it('one failed write does not stop the rest', async () => {
    const t = table({ a: { source: null }, b: { source: null } })
    const plan = planSourceBackfill([lead('a'), lead('b')], answers({ a: client('Yelp'), b: client('Yelp') }))
    const flaky: SourceWriter = async (id, e, n) => { if (id === 'a') throw new Error('PostgREST 503'); return t.write(id, e, n) }
    const out = await executeSourceBackfill(flaky, plan.fills)
    expect(out.written).toEqual(['b'])
    expect(out.skipped).toEqual([{ id: 'a', why: 'PostgREST 503' }])
  })
})

describe('undoSourceBackfill', () => {
  it('--undo restores exactly: every lead back to what it was, nothing else touched', async () => {
    const start = {
      a: { source: null, stage: 'New' },
      b: { source: '', stage: 'Request' },
      c: { source: 'Website', stage: 'New' }, // never in the run
    }
    const t = table(start)
    const plan = planSourceBackfill(
      [lead('a'), lead('b', { source: '' })],
      answers({ a: client('google'), b: client('Hershey Mills Ads') }),
    )
    await executeSourceBackfill(t.write, plan.fills)
    expect(t.db.a.source).toBe('Google')
    expect(t.db.b.source).toBe('Hershey Mills Ads')

    const out = await undoSourceBackfill(t.write, plan.fills)
    expect(out).toEqual({ reverted: ['a', 'b'], skipped: [] })
    expect(t.db).toEqual(start) // byte-for-byte: null stays null, '' stays ''
  })

  it('--undo leaves alone a source an owner has changed since the run', async () => {
    const t = table({ a: { source: null }, b: { source: null } })
    const plan = planSourceBackfill([lead('a'), lead('b')], answers({ a: client('Google'), b: client('Google') }))
    await executeSourceBackfill(t.write, plan.fills)
    t.db.a.source = 'Referral' // owner corrected it after the run
    const out = await undoSourceBackfill(t.write, plan.fills)
    expect(out.reverted).toEqual(['b'])
    expect(out.skipped).toEqual([{ id: 'a', why: 'no longer as the run left it — left alone' }])
    expect(t.db.a.source).toBe('Referral')
    expect(t.db.b.source).toBeNull()
  })
})

describe('pace — never take a Jobber account below half its budget', () => {
  it('no wait while the budget is at or above half', () => {
    expect(paceWaitMs({ maximumAvailable: 10000, currentlyAvailable: 10000, restoreRate: 500 })).toBe(0)
    expect(paceWaitMs({ maximumAvailable: 10000, currentlyAvailable: 5000, restoreRate: 500 })).toBe(0)
  })
  it('below half, waits exactly long enough to refill to half', () => {
    // 1,000 short of the 5,000 floor at 500 points a second = 2 seconds
    expect(paceWaitMs({ maximumAvailable: 10000, currentlyAvailable: 4000, restoreRate: 500 })).toBe(2000)
  })
  it('no budget information → no extra wait (the fixed pause between calls still applies)', () => {
    expect(paceWaitMs(null)).toBe(0)
    expect(paceWaitMs({})).toBe(0)
  })
})

describe('the script (source pins)', () => {
  const src = readFileSync('scripts/backfill-lead-source.mjs', 'utf8')
  const code = src.slice(src.indexOf('import { readFileSync'))

  it('is a dry run unless --execute is passed, and can --undo from a run report', () => {
    expect(code).toContain("const EXECUTE = argv.includes('--execute')")
    expect(code).toContain("const UNDO = val('--undo')")
    expect(code).toContain("if (run.mode !== 'execute')")
    // every write sits behind EXECUTE or UNDO
    expect(code.indexOf('bf.executeSourceBackfill(')).toBeGreaterThan(code.indexOf('if (EXECUTE) {'))
  })

  it('never renews a token without --refresh', () => {
    expect(code).toContain("const REFRESH = argv.includes('--refresh')")
    expect(code).toContain("const jobber = REFRESH ? await import(pathToFileURL(ROOT + '/lib/jobber.ts').href) : null")
    expect(code).toContain('if (REFRESH) return jobber.refreshJobberToken(slug)')
    // the ONLY use of the app's Jobber module is that guarded renewal
    expect(code.match(/jobber\.\w+\(/g)).toEqual(['jobber.refreshJobberToken('])
    expect(code).not.toContain('oauth/token')
  })

  it('only looks at webhook-arrived leads that are blank and still linked', () => {
    expect(code).toContain('import_source=eq.jobber_webhook')
    expect(code).not.toContain('jobber_initial')
    expect(code).toContain('bf.isBlankSource(l.source)')
  })

  it('writes leads.source and nothing else on the lead, guarded on its current value', () => {
    expect(code).toContain("body: JSON.stringify({ source: next })")
    expect(code).toContain("eqGuard('source', expected)")
    // exactly one PATCH in the whole script, and it is that one
    expect(code.match(/method: 'PATCH'/g)).toHaveLength(1)
    expect(code).not.toMatch(/\bstage\s*:|updated_at|paused|drip_path/)
    expect(code).toContain('assertNoDrift(before, await sideEffectSnapshot(')
  })

  it('uses the shared plan (so the live mapping and the app-stamp rule cannot drift)', () => {
    expect(code).toContain('bf.planSourceBackfill(asked, answers)')
    expect(readFileSync('lib/lead-source-backfill.ts', 'utf8')).toContain("import { leadSourceFromJobber, JOBBER_APP_SOURCE_STAMP } from './lead-source'")
  })

  it('paces itself: small batches, a pause between calls, and the budget floor', () => {
    expect(code).toContain('const BATCH = 10')
    expect(code).toContain('const wait = BETWEEN_CALLS_MS + bf.paceWaitMs(r.throttle)')
    expect(code).toContain('await sleep(wait)')
  })
})
