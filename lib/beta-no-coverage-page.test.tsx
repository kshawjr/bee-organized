// @vitest-environment node
//
// The public mailing-list opt-in page (app/mailing-list/[token]). It is a
// server component: call it, render the returned tree to a string, assert on
// the surface + the write it performed. Pins:
//   • First consume records consent (marketing_consented_at + source, guarded
//     .is(null) so it's first-consume-wins) and shows the confirmation.
//   • IDEMPOTENT: a second visit with consent already recorded shows the SAME
//     confirmation and writes NOTHING.
//   • An expired token → a clean "expired" state, no consent write.
//   • An unknown token (or a lookup error, e.g. columns missing pre-migration)
//     → a clean "inactive" state, NOT a thrown error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any; filters: Record<string, any> }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = [] }
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

import MailingListOptInPage from '@/app/mailing-list/[token]/page'

const render = async (token: string) => {
  const el = await MailingListOptInPage({ params: { token } } as any)
  return renderToString(el as any)
}

const future = () => new Date(Date.now() + 10 * 86400000).toISOString()
const past = () => new Date(Date.now() - 10 * 86400000).toISOString()

beforeEach(() => { h.reset() })

describe('mailing-list page — first consume', () => {
  it('records consent (when + how, guarded first-consume-wins) and shows the confirmation', async () => {
    h.enqueue('leads', {
      id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell',
      optin_token_expires_at: future(), marketing_consented_at: null,
    })
    h.enqueue('leads', {}, null)          // consent update
    h.enqueue('touchpoints', { id: 'tp' })

    const html = await render('tok-abc')
    expect(html).toContain('on the list')
    expect(html).toContain('Sarah')

    const upd = h.state.updates.find(u => u.table === 'leads')
    expect(upd).toBeTruthy()
    expect(upd!.arg.marketing_consented_at).toBeTruthy()
    expect(upd!.arg.marketing_consent_source).toBe('no_coverage_optin_email')
    // first-consume-wins is enforced at the DB: WHERE marketing_consented_at IS NULL
    expect(upd!.filters.marketing_consented_at).toBeNull()
    expect(upd!.filters.id).toBe('lead-1')
  })
})

describe('mailing-list page — idempotent', () => {
  it('a second visit (already consented) shows the confirmation and writes NOTHING', async () => {
    h.enqueue('leads', {
      id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell',
      // expiry already past — proves a returning subscriber is never told the
      // link expired once they're on the list.
      optin_token_expires_at: past(), marketing_consented_at: new Date().toISOString(),
    })

    const html = await render('tok-abc')
    expect(html).toContain('on the list')
    expect(h.state.updates).toHaveLength(0)
    expect(h.state.inserts).toHaveLength(0)
  })
})

describe('mailing-list page — clean states, never an error', () => {
  it('expired token → expired state, no consent write', async () => {
    h.enqueue('leads', {
      id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell',
      optin_token_expires_at: past(), marketing_consented_at: null,
    })
    const html = await render('tok-abc')
    expect(html).toContain('expired')
    expect(html).not.toContain('on the list')
    expect(h.state.updates).toHaveLength(0)
  })

  it('unknown token → inactive state (row is null)', async () => {
    h.enqueue('leads', null)
    const html = await render('tok-nope')
    expect(html).toContain('no longer active')
    expect(h.state.updates).toHaveLength(0)
  })

  it('lookup error (e.g. columns missing pre-migration) → inactive state, not a throw', async () => {
    h.enqueue('leads', null, { message: 'column leads.optin_token does not exist', code: '42703' })
    const html = await render('tok-any')
    expect(html).toContain('no longer active')
    expect(h.state.updates).toHaveLength(0)
  })

  it('empty token → inactive state without touching the DB', async () => {
    const html = await render('')
    expect(html).toContain('no longer active')
  })
})
