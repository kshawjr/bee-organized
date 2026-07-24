// @vitest-environment node
//
// The public unsubscribe page (app/unsubscribe/[token]) — the inverse of the
// mailing-list opt-in page, tested the same way: call the server component,
// render the returned tree to a string, assert on the surface + the writes.
// Pins:
//   • First consume records the withdrawal — marketing_opt_out=true AND
//     marketing_unsubscribed_at, guarded .is(marketing_unsubscribed_at, null)
//     so it's first-consume-wins — fires the opt-out cascade, and shows the
//     confirmation. marketing_consented_at is NEVER cleared.
//   • IDEMPOTENT: a second visit (withdrawal already recorded) shows the SAME
//     confirmation and writes NOTHING.
//   • NO expiry state exists — unsubscribe links must keep working (CAN-SPAM).
//   • An unknown token (or a lookup error, e.g. columns missing pre-migration)
//     → a clean "inactive" state, NOT a thrown error.
//   • INVERTED failure posture vs opt-in: a failed withdrawal WRITE renders an
//     honest "something went wrong" state, never a false "you're unsubscribed".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any; filters: Record<string, any> }[],
    inserts: [] as { table: string; arg: any }[],
    cascades: [] as any[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = []; state.cascades = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const b: any = {}
    const rec: any = { table, arg: null, filters: {} }
    b.select = () => b
    b.eq = (col: string, val: any) => { rec.filters[col] = val; return b }
    b.is = (col: string, val: any) => { rec.filters[col] = val; return b }
    b.update = (arg: any) => { rec.arg = arg; state.updates.push(rec); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

// The cascade is drip-lifecycle's job, pinned by its own tests — here we only
// pin that the page invokes it with the opt-out patch after a successful
// withdrawal write, and NOT on idempotent revisits or failed writes.
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: (args: any) => { h.state.cascades.push(args); return Promise.resolve() },
}))

import UnsubscribePage from '@/app/unsubscribe/[token]/page'

const render = async (token: string) => {
  const el = await UnsubscribePage({ params: { token } } as any)
  return renderToString(el as any)
}

beforeEach(() => { h.reset() })

describe('unsubscribe page — first consume', () => {
  it('records the withdrawal (opt_out + when, guarded first-consume-wins), fires the cascade, shows the confirmation', async () => {
    h.enqueue('leads', {
      id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell',
      location_uuid: 'loc-1', marketing_unsubscribed_at: null, marketing_opt_out: false,
    })
    h.enqueue('leads', {}, null)          // withdrawal update
    h.enqueue('touchpoints', { id: 'tp' })

    const html = await render('tok-abc')
    expect(html).toContain('unsubscribed')
    expect(html).toContain('Sarah')

    const upd = h.state.updates.find(u => u.table === 'leads')
    expect(upd).toBeTruthy()
    expect(upd!.arg.marketing_opt_out).toBe(true)
    expect(upd!.arg.marketing_unsubscribed_at).toBeTruthy()
    // consent history is retained — the withdrawal write must not touch it
    expect('marketing_consented_at' in upd!.arg).toBe(false)
    // first-consume-wins is enforced at the DB: WHERE marketing_unsubscribed_at IS NULL
    expect(upd!.filters.marketing_unsubscribed_at).toBeNull()
    expect(upd!.filters.id).toBe('lead-1')

    // the same immediate-silence cascade a staff-set opt-out gets
    expect(h.state.cascades).toHaveLength(1)
    expect(h.state.cascades[0].leadId).toBe('lead-1')
    expect(h.state.cascades[0].patch).toEqual({ marketing_opt_out: true })

    expect(h.state.inserts.find(i => i.table === 'touchpoints')).toBeTruthy()
  })

  it('a staff-set opt_out WITHOUT unsubscribed_at still records the person’s own act', async () => {
    h.enqueue('leads', {
      id: 'lead-2', first_name: null, name: 'Lee Ono',
      location_uuid: null, marketing_unsubscribed_at: null, marketing_opt_out: true,
    })
    h.enqueue('leads', {}, null)

    const html = await render('tok-def')
    expect(html).toContain('unsubscribed')
    const upd = h.state.updates.find(u => u.table === 'leads')
    expect(upd!.arg.marketing_unsubscribed_at).toBeTruthy()
  })
})

describe('unsubscribe page — idempotent', () => {
  it('a second visit (withdrawal already recorded) shows the confirmation and writes NOTHING', async () => {
    h.enqueue('leads', {
      id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell',
      location_uuid: 'loc-1',
      marketing_unsubscribed_at: new Date().toISOString(), marketing_opt_out: true,
    })

    const html = await render('tok-abc')
    expect(html).toContain('unsubscribed')
    expect(h.state.updates).toHaveLength(0)
    expect(h.state.inserts).toHaveLength(0)
    expect(h.state.cascades).toHaveLength(0)
  })
})

describe('unsubscribe page — clean states, never an error', () => {
  it('unknown token → inactive state (row is null), no writes', async () => {
    h.enqueue('leads', null)
    const html = await render('tok-nope')
    expect(html).toContain('no longer active')
    expect(h.state.updates).toHaveLength(0)
  })

  it('lookup error (e.g. columns missing pre-migration) → inactive state, not a throw', async () => {
    h.enqueue('leads', null, { message: 'column leads.unsubscribe_token does not exist', code: '42703' })
    const html = await render('tok-any')
    expect(html).toContain('no longer active')
    expect(h.state.updates).toHaveLength(0)
  })

  it('empty token → inactive state without touching the DB', async () => {
    const html = await render('')
    expect(html).toContain('no longer active')
  })
})

describe('unsubscribe page — inverted failure posture', () => {
  it('a failed withdrawal write renders the honest error state, NEVER a false confirmation, and no cascade', async () => {
    h.enqueue('leads', {
      id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell',
      location_uuid: 'loc-1', marketing_unsubscribed_at: null, marketing_opt_out: false,
    })
    h.enqueue('leads', null, { message: 'write failed' })   // withdrawal update fails

    const html = await render('tok-abc')
    expect(html).not.toContain("You're unsubscribed")
    expect(html).toContain('went wrong')
    expect(h.state.cascades).toHaveLength(0)
    expect(h.state.inserts).toHaveLength(0)
  })
})
