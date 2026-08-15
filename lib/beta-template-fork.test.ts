// @vitest-environment node
//
// Issue 240 step 8 — ONE definition of "which wording does this location send?"
//
// The rule was implemented four times: lib/stage-emails.ts,
// lib/welcome-email.ts (private, unexported), inline in the lead timeline
// route, and client-side in buildEmailList. Step 8 adds the first WRITES on
// top of it, so it was extracted FIRST, as its own commit, before any write
// path existed to build on the drift.
//
// This suite pins the rule itself and — the part that matters — pins the
// client-side mirror in components/BeeHub.jsx against it. That mirror cannot
// import this module (it runs in the browser against an already-fetched array,
// not against supabaseService), so it is the one copy that can still drift.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  const state = { rows: [] as any[], error: null as any, calls: [] as any[] }
  const reset = () => { state.rows = []; state.error = null; state.calls = [] }
  const makeBuilder = (table: string) => {
    const call: any = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.then = (res: any, rej: any) =>
      Promise.resolve({ data: state.error ? null : state.rows, error: state.error }).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))

import {
  resolveLocationTemplateFork,
  resolveLocationTemplateForks,
  mergeForkOverMaster,
} from '@/lib/template-fork'

const LOC = 'loc-uuid-1'
const MASTER = 'master-1'
const opsOf = (i = 0) => h.state.calls[i]?.ops ?? []
const eqPairs = (i = 0) => opsOf(i).filter(([m]: any) => m === 'eq').map(([, a]: any) => a)

beforeEach(() => h.reset())

describe('the rule', () => {
  it('returns the location fork when one is active', async () => {
    h.state.rows = [{ subject: 'Ours', body: 'Our body' }]
    expect(await resolveLocationTemplateFork(MASTER, LOC)).toEqual({ subject: 'Ours', body: 'Our body' })
  })

  it('scopes to this master, this location, and active rows only', async () => {
    h.state.rows = []
    await resolveLocationTemplateFork(MASTER, LOC)
    const pairs = eqPairs()
    expect(pairs).toContainEqual(['cloned_from_id', MASTER])
    expect(pairs).toContainEqual(['location_uuid', LOC])
    expect(pairs).toContainEqual(['is_active', true])
    // Newest wins — Duplicate can be pressed more than once.
    expect(opsOf().some(([m, a]: any) => m === 'order' && a[0] === 'updated_at' && a[1]?.ascending === false)).toBe(true)
  })

  it('no fork → null, which every caller reads as "use the master"', async () => {
    h.state.rows = []
    expect(await resolveLocationTemplateFork(MASTER, LOC)).toBeNull()
  })

  it('a read error falls back to the master rather than throwing', async () => {
    // A template lookup failing must not stop a send that has a good default.
    h.state.error = { message: 'boom' }
    expect(await resolveLocationTemplateFork(MASTER, LOC)).toBeNull()
  })

  it('no location (a master-only context) short-circuits without querying', async () => {
    expect(await resolveLocationTemplateFork(MASTER, null)).toBeNull()
    expect(h.state.calls.length).toBe(0)
  })
})

describe('the batch form, for the timeline route', () => {
  it('keys each fork to its master and keeps the newest per master', async () => {
    h.state.rows = [
      { subject: 'A new', body: 'x', cloned_from_id: 'm-a', updated_at: '2026-06-01' },
      { subject: 'A old', body: 'x', cloned_from_id: 'm-a', updated_at: '2026-01-01' },
      { subject: 'B',     body: 'y', cloned_from_id: 'm-b', updated_at: '2026-03-01' },
    ]
    const map = await resolveLocationTemplateForks(['m-a', 'm-b'], LOC)
    expect(map.get('m-a')!.subject).toBe('A new')
    expect(map.get('m-b')!.subject).toBe('B')
  })

  it('masters with no fork are simply absent', async () => {
    h.state.rows = [{ subject: 'B', body: 'y', cloned_from_id: 'm-b', updated_at: '2026-03-01' }]
    const map = await resolveLocationTemplateForks(['m-a', 'm-b'], LOC)
    expect(map.has('m-a')).toBe(false)
  })

  it('an error yields an empty map — every master keeps its own wording', async () => {
    h.state.error = { message: 'boom' }
    expect((await resolveLocationTemplateForks(['m-a'], LOC)).size).toBe(0)
  })

  it('empty inputs never query', async () => {
    await resolveLocationTemplateForks([], LOC)
    await resolveLocationTemplateForks(['m-a'], null)
    expect(h.state.calls.length).toBe(0)
  })
})

describe('the merge states which fields fork', () => {
  const master = { subject: 'Master subj', body: 'Master body', name: 'Master name' }

  it('fork wins field by field', () => {
    expect(mergeForkOverMaster(master, { subject: 'Ours', body: 'Our body' }))
      .toEqual({ subject: 'Ours', body: 'Our body' })
  })

  it('null fork fields fall back to the master', () => {
    expect(mergeForkOverMaster(master, { subject: null, body: null }))
      .toEqual({ subject: 'Master subj', body: 'Master body' })
  })

  it('only subject and body are returned — name never forks', () => {
    // name is the touchpoint/timeline label and stays the master's; the
    // CAN-SPAM and branded-wrapper decisions stay keyed on stage_email_key,
    // so an edited body can neither restyle a commercial email nor strip a
    // footer.
    const merged = mergeForkOverMaster(master, { subject: 'Ours', body: 'Our body' })
    expect(Object.keys(merged).sort()).toEqual(['body', 'subject'])
  })
})

describe('the four copies are down to one, plus a pinned mirror', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('both send paths call the shared helper and keep no private copy', () => {
    for (const p of ['lib/stage-emails.ts', 'lib/welcome-email.ts']) {
      const s = read(p)
      expect(s, `${p} imports the helper`).toContain("from './template-fork'")
      expect(s, `${p} has no private copy`).not.toContain('.eq(\'cloned_from_id\'')
    }
  })

  it('the timeline route no longer inlines it', () => {
    const s = read('app/api/leads/[id]/timeline/route.ts')
    expect(s).toContain('resolveLocationTemplateForks')
    expect(s).not.toContain(".in('cloned_from_id', masterIds)")
  })

  it('the client mirror still implements the same three conditions', () => {
    // buildEmailList runs in the browser over an already-fetched array, so it
    // cannot import the helper. If this fails, the mirror has drifted and the
    // Emails list is showing an owner something other than what sends.
    const s = read('components/BeeHub.jsx')
    const fn = s.slice(s.indexOf('function resolveFork('), s.indexOf('function templateRow('))
    expect(fn.length).toBeGreaterThan(100)
    expect(fn, 'own fork of this master').toContain('clonedFromId === master.dbId')
    expect(fn, 'this location').toContain('isOwnCustom')
    expect(fn, 'active only').toContain('isActive')
    expect(fn, 'newest wins').toContain('updatedAt')
  })
})
