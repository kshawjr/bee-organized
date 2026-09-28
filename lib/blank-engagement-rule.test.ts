// @vitest-environment node
//
// THE BLANK RULE (2026-09-28) — an engagement with nothing on it cannot be
// created by any path.
//
// The removed "+ New engagement" button founded 47 engagements that carried
// nothing: an auto title ("Engagement – Sep 2026"), no words, no Jobber
// record. Every one sat at Request forever, looking like every other card.
// Starting a job in Bee Hub is back (NewJobWizard), so the rule that keeps
// that from repeating is pinned here at the bottom of the stack:
//
//   · foundManualEngagement — the ONE function that inserts a hand-made
//     engagement — refuses a title that doesn't describe the work, and
//     refuses BEFORE touching the database (no lead read, no insert).
//   · every caller of it passes a title (the route, the Close flow via the
//     route, the webform resubmission).
//   · nothing else in app/ or lib/ inserts an open manual engagement.
//
// The route's own gate and the wizard's gate are pinned in
// blank-engagement-route.test.ts and beta-new-job-wizard.test.tsx — three
// locks, so a regression has to break all three to ship a blank card.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'is', 'limit', 'order', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { foundManualEngagement, BLANK_ENGAGEMENT_ERROR, isFallbackTitle } from '@/lib/engagements'
import { describesTheWork, WORK_MIN_CHARS, displayTitle } from '@/components/hive/shared/engagementStatus'

const inserts = () => h.state.calls
  .filter(c => c.table === 'engagements')
  .flatMap(c => c.ops.filter(o => o[0] === 'insert').map(o => o[1][0]))

beforeEach(() => h.reset())

describe('foundManualEngagement refuses an engagement with nothing on it', () => {
  const BLANKS: Array<[string, any]> = [
    ['no title at all', undefined],
    ['null', null],
    ['an empty string', ''],
    ['only spaces and newlines', '   \n\t  '],
    ['three characters — short enough that the card would show "Engagement – Sep 2026" anyway', 'Tub'],
    ['three characters padded with spaces', '  Tub  '],
    ['not a string', 12345],
  ]
  for (const [what, title] of BLANKS) {
    it(`${what} → refused, and the database is never touched`, async () => {
      h.enqueue('leads', { id: 'lead1', location_uuid: 'loc-1', location_id: 'loc_x', name: 'Pat', is_junk: false })
      h.enqueue('engagements', { id: 'SHOULD-NOT-EXIST', stage: 'Request' })
      const res = await foundManualEngagement({ clientId: 'lead1', title, description: 'they called about the attic' } as any)
      expect('error' in res, 'a blank founding must be an error').toBe(true)
      expect((res as any).error.startsWith(BLANK_ENGAGEMENT_ERROR)).toBe(true)
      expect(inserts(), 'no engagement row may be written').toHaveLength(0)
      expect(h.state.calls, 'refused before any read or write').toHaveLength(0)
    })
  }

  it('words in the description do NOT rescue a missing title — the work itself must be named', async () => {
    const res = await foundManualEngagement({ clientId: 'lead1', title: '', description: 'Long call, wants the garage done in spring' })
    expect('error' in res).toBe(true)
    expect(inserts()).toHaveLength(0)
  })

  it('a described job is founded with exactly what was typed — title and what they said', async () => {
    h.enqueue('leads', { id: 'lead1', location_uuid: 'loc-1', location_id: 'loc_x', name: 'Pat', is_junk: false })
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request' })
    const res = await foundManualEngagement({
      clientId: 'lead1',
      title: '  Primary bedroom closet  ',
      description: '  Wants it before the holidays. Told her we can assess next week.  ',
    })
    expect('engagement' in res && res.engagement.id).toBe('eng-1')
    const row = inserts()[0]
    expect(row.title).toBe('Primary bedroom closet')
    expect(row.description).toBe('Wants it before the holidays. Told her we can assess next week.')
    expect(row.founded_by).toBe('manual')
    expect(row.stage).toBe('Request')
  })

  it('there is no fallback title any more — the auto "Engagement – Mon YYYY" is never written by a manual founding', async () => {
    h.enqueue('leads', { id: 'lead1', location_uuid: 'loc-1', location_id: 'loc_x', name: 'Pat', is_junk: false })
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request' })
    await foundManualEngagement({ clientId: 'lead1', title: 'Garage shelving' })
    expect(isFallbackTitle(inserts()[0].title)).toBe(false)
    const src = readFileSync(join(process.cwd(), 'lib/engagements.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function foundManualEngagement'), src.indexOf('// ── assignment carry-forward'))
    expect(body).not.toContain('fallbackTitle(')
  })

  it('a blank description is simply not written (no empty-string column)', async () => {
    h.enqueue('leads', { id: 'lead1', location_uuid: 'loc-1', location_id: 'loc_x', name: 'Pat', is_junk: false })
    h.enqueue('engagements', { id: 'eng-1', stage: 'Request' })
    await foundManualEngagement({ clientId: 'lead1', title: 'Garage shelving', description: '   ' })
    expect('description' in inserts()[0]).toBe(false)
  })
})

describe('the threshold is the one the card uses to show a title', () => {
  it('anything describesTheWork accepts is shown as typed; anything it refuses would show the auto title', () => {
    for (const t of ['Tubs', 'Attic', 'Primary bedroom closet']) {
      expect(describesTheWork(t)).toBe(true)
      expect(displayTitle({ title: t, created_at: null })).toBe(t)
    }
    for (const t of ['', '   ', 'Tub', 'ab']) {
      expect(describesTheWork(t)).toBe(false)
      expect(displayTitle({ title: t, created_at: null })).toMatch(/^Engagement – /)
    }
    expect(WORK_MIN_CHARS).toBe(4)
  })
})

// ── every path, by source ──────────────────────────────────────────────────
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  if (n === 'node_modules' || n.startsWith('.')) return []
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const codeFiles = [...walk(join(process.cwd(), 'app')), ...walk(join(process.cwd(), 'lib')), ...walk(join(process.cwd(), 'components'))]
  .filter(f => /\.(ts|tsx|js|jsx)$/.test(f) && !/\.test\./.test(f))

describe('no path around the rule', () => {
  it('every call to foundManualEngagement passes a title', () => {
    const sites: string[] = []
    for (const f of codeFiles) {
      const src = readFileSync(f, 'utf8')
      let at = src.indexOf('foundManualEngagement({')
      while (at >= 0) {
        const call = src.slice(at, src.indexOf('})', at))
        sites.push(f)
        expect(call, `${f} calls foundManualEngagement without a title`).toMatch(/\btitle:/)
        at = src.indexOf('foundManualEngagement({', at + 1)
      }
    }
    // The route and the webform resubmission — if a new caller appears, it
    // is checked by the loop above; if one vanishes, look at why.
    expect(sites.some(f => f.endsWith(join('app', 'api', 'engagements', 'route.ts')))).toBe(true)
    expect(sites.some(f => f.endsWith(join('app', 'api', 'leads', 'intake', 'route.ts')))).toBe(true)
  })

  it('the webform resubmission names its card and carries the message', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/leads/intake/route.ts'), 'utf8')
    const at = src.indexOf('foundManualEngagement({')
    const call = src.slice(at, src.indexOf('})', at))
    expect(call).toContain("title: 'Website enquiry'")
    expect(call).toContain('description: submission.message?.trim() || null')
  })

  it('every screen that POSTs /api/engagements sends a title', () => {
    const posters = codeFiles.filter(f => /fetch\('\/api\/engagements',\s*\{/.test(readFileSync(f, 'utf8')))
    expect(posters.map(f => f.split('/components/')[1]).sort()).toEqual(['hive/NewJobWizard.jsx', 'hive/shared/CloseLostWizard.jsx'])
    for (const f of posters) {
      const src = readFileSync(f, 'utf8')
      const at = src.indexOf("fetch('/api/engagements'")
      expect(src.slice(at, at + 900), `${f} must send a title`).toMatch(/title:/)
    }
  })

  it("the only other insert of a manual engagement is auto-close's — and it is born CLOSED, with its note", () => {
    const inserting = codeFiles.filter(f => /founded_by:\s*'manual'/.test(readFileSync(f, 'utf8')))
      .map(f => f.split(process.cwd() + '/')[1]).sort()
    expect(inserting).toEqual(['lib/auto-close.ts', 'lib/engagements.ts'])
    const auto = readFileSync(join(process.cwd(), 'lib/auto-close.ts'), 'utf8')
    const ins = auto.slice(auto.indexOf(".insert({", auto.indexOf("founded_by: 'manual'") - 400), auto.indexOf("founded_by: 'manual'") + 400)
    expect(ins).toContain("stage: 'Closed Lost'")
    expect(ins).toContain('closed_note: note')
  })
})
