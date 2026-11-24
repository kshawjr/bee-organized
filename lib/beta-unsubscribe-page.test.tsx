// @vitest-environment node
//
// The public unsubscribe page (app/unsubscribe/[token]) for a CLIENT, and its
// button (app/unsubscribe/[token]/confirm). FL-75 slice 2 (2026-11-23),
// Kevin's ruling: a client's no now stops marketing at all 54 locations by
// address, so OPENING THE LINK MUST ONLY READ — mail scanners, link previews
// and prefetches open every link. Only pressing the button unsubscribes.
// (Until this slice, opening the link unsubscribed on the spot; this file
// pinned that, and is rewritten to the new rule.)
//
// Pins:
//   • Opening — once or ten times, with any query string — writes nothing,
//     cascades nothing, and shows the question with one button (a POST form).
//   • The page itself cannot write: it imports no database client and no
//     write appears in it; the button route has no GET or HEAD handler.
//   • Pressing the button records the withdrawal — marketing_opt_out=true
//     AND marketing_unsubscribed_at, first-press-wins (.is(null)) — fires the
//     opt-out cascade and the timeline note; marketing_consented_at is never
//     cleared. Back to the page with a 303.
//   • Already unsubscribed → the confirmation, no button, no writes.
//   • A failed write → back to the question with an honest message, never a
//     false confirmation, no cascade.
//   • Unknown token / lookup error / empty token → the clean inactive state.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { readFileSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any; filters: Record<string, any> }[],
    inserts: [] as { table: string; arg: any }[],
    cascades: [] as any[],
    rpc: [] as any[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = []; state.cascades = []; state.rpc = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
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
  supabaseService: {
    from: (t: string) => h.makeBuilder(t),
    rpc: (fn: string, args: any) => { h.state.rpc.push({ fn, args }); return Promise.resolve({ data: null, error: null }) },
  },
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: (args: any) => { h.state.cascades.push(args); return Promise.resolve() },
}))

import { NextRequest } from 'next/server'
import UnsubscribePage from '@/app/unsubscribe/[token]/page'
import * as ConfirmRoute from '@/app/unsubscribe/[token]/confirm/route'

const TOKEN = 'cd'.repeat(24)   // a client's key: 48 hex, the shape all 781 minted keys have
const render = async (token: string, searchParams: any = {}) =>
  renderToString((await UnsubscribePage({ params: { token }, searchParams } as any)) as any)
const press = (token: string, body: string | null) => (ConfirmRoute as any).POST(
  new NextRequest(`http://hub.test/unsubscribe/${token}/confirm`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
  { params: { token } })
const sarah = (over: any = {}) => h.enqueue('leads', {
  id: 'lead-1', first_name: 'Sarah', name: 'Sarah Mitchell', location_uuid: 'loc-1',
  marketing_unsubscribed_at: null, marketing_opt_out: false, ...over,
})
// Opening tests answer EVERY read with the person (as the real database
// would), so a page that tried to unsubscribe on open would get far enough
// to write — and the test would see it.
const sarahEveryRead = (over: any = {}) => { for (let i = 0; i < 5; i++) sarah(over) }
const nothingWritten = () => {
  expect(h.state.updates).toEqual([])
  expect(h.state.inserts).toEqual([])
  expect(h.state.cascades).toEqual([])
  expect(h.state.rpc).toEqual([])
}

beforeEach(() => { h.reset() })

describe('OPENING a client\'s unsubscribe link sends nobody an unsubscribe (scanners, previews, prefetch)', () => {
  it('asks "Stop receiving marketing emails?" with one button, and writes nothing', async () => {
    sarahEveryRead()
    const html = await render(TOKEN)
    expect(html).toContain('Stop receiving marketing emails?')
    expect(html).toContain('Sarah, press the button')
    expect(html).toContain(`<form method="post" action="/unsubscribe/${TOKEN}/confirm"`)
    expect(html).toContain('name="confirm" value="yes"')
    expect(html).not.toContain("re unsubscribed")
    nothingWritten()
  })

  it('opened ten times — a scanner, a preview, a prefetch, then the person — still nothing recorded', async () => {
    for (let i = 0; i < 10; i++) { h.state.queue = []; sarahEveryRead(); await render(TOKEN) }
    nothingWritten()
  })

  it('a query string cannot turn the open into an unsubscribe (no ?confirm shortcut)', async () => {
    sarahEveryRead()
    const html = await render(TOKEN, { confirm: 'yes', 'List-Unsubscribe': 'One-Click', error: '0' })
    expect(html).toContain('Stop receiving marketing emails?')
    nothingWritten()
  })

  it('a record already marked No marketing emails (but never unsubscribed) still gets the button, and opening writes nothing', async () => {
    sarah({ marketing_opt_out: true })
    expect(await render(TOKEN)).toContain('Unsubscribe me')
    nothingWritten()
  })

  it('the page cannot write: no database client, no write, in the page itself', () => {
    const src = readFileSync(join(process.cwd(), 'app/unsubscribe/[token]/page.tsx'), 'utf8')
    expect(src).not.toMatch(/supabase-service|supabaseService|\.update\(|\.insert\(|\.upsert\(|\.delete\(|applyDripSideEffects|consumeClientUnsubscribe|consumePartnerUnsubscribeToken/)
  })

  it('the button route answers POST only: no GET or HEAD handler, so Next returns 405 and runs nothing', () => {
    expect(typeof (ConfirmRoute as any).POST).toBe('function')
    expect((ConfirmRoute as any).GET).toBeUndefined()
    expect((ConfirmRoute as any).HEAD).toBeUndefined()
  })
})

describe('PRESSING the button unsubscribes', () => {
  it('records the withdrawal (opt-out + when, first-press-wins), fires the cascade and the note, then 303 back to the page', async () => {
    sarah()
    h.enqueue('leads', {}, null)           // the withdrawal write
    const res = await press(TOKEN, 'confirm=yes')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`http://hub.test/unsubscribe/${TOKEN}`)

    const upd = h.state.updates.find(u => u.table === 'leads')!
    expect(upd.arg.marketing_opt_out).toBe(true)
    expect(upd.arg.marketing_unsubscribed_at).toBeTruthy()
    expect('marketing_consented_at' in upd.arg).toBe(false)   // consent history kept
    expect(upd.filters.marketing_unsubscribed_at).toBeNull()  // first press wins at the database
    expect(upd.filters.id).toBe('lead-1')
    expect(h.state.cascades).toHaveLength(1)
    expect(h.state.cascades[0]).toMatchObject({ leadId: 'lead-1', patch: { marketing_opt_out: true } })
    // the timeline note carries the location the table requires (it was left
    // out before this slice, so the note was never written)
    expect(h.state.inserts.find(i => i.table === 'touchpoints')!.arg).toMatchObject({ lead_id: 'lead-1', location_uuid: 'loc-1', label: 'Unsubscribed from marketing emails' })
    // a client's press never asks a partner function
    expect(h.state.rpc).toEqual([])
  })

  it('a POST without the button (empty, confirm=no, stray fields) is refused with 400 and changes nothing', async () => {
    for (const body of [null, '', 'confirm=no', 'foo=bar', 'List-Unsubscribe=Maybe']) {
      sarah()
      expect((await press(TOKEN, body)).status, String(body)).toBe(400)
    }
    nothingWritten()
  })

  it("a mail provider's RFC 8058 one-click POST counts as a press (plain OK, no page)", async () => {
    sarah()
    h.enqueue('leads', {}, null)
    const res = await press(TOKEN, 'List-Unsubscribe=One-Click')
    expect(res.status).toBe(200)
    expect(h.state.updates.find(u => u.table === 'leads')!.arg.marketing_opt_out).toBe(true)
  })

  it('pressing again after it worked writes nothing and lands on the same confirmation', async () => {
    sarah({ marketing_unsubscribed_at: '2026-11-23T10:00:00Z', marketing_opt_out: true })
    const res = await press(TOKEN, 'confirm=yes')
    expect(res.status).toBe(303)
    nothingWritten()
    sarah({ marketing_unsubscribed_at: '2026-11-23T10:00:00Z', marketing_opt_out: true })
    const html = await render(TOKEN)
    expect(html).toContain("unsubscribed, Sarah")
    expect(html).not.toContain('<form')
  })

  it('a failed write goes back to the question with an honest message — never a false confirmation, no cascade', async () => {
    sarah()
    h.enqueue('leads', null, { message: 'write failed' })
    const res = await press(TOKEN, 'confirm=yes')
    expect(res.headers.get('location')).toBe(`http://hub.test/unsubscribe/${TOKEN}?error=1`)
    expect(h.state.cascades).toHaveLength(0)
    expect(h.state.inserts).toHaveLength(0)
    sarah()
    const html = await render(TOKEN, { error: '1' })
    expect(html).toContain('couldn')
    expect(html).toContain('Unsubscribe me')
    expect(html).not.toContain("re unsubscribed")
  })
})

describe('clean states, never an error', () => {
  it('unknown token → inactive, no writes', async () => {
    h.enqueue('leads', null)
    expect(await render(TOKEN)).toContain('no longer active')
    nothingWritten()
  })
  it('lookup error (e.g. columns missing) → inactive, not a throw', async () => {
    h.enqueue('leads', null, { message: 'column leads.unsubscribe_token does not exist', code: '42703' })
    expect(await render(TOKEN)).toContain('no longer active')
    expect(h.state.updates).toHaveLength(0)
  })
  it('empty token → inactive without touching the database', async () => {
    expect(await render('')).toContain('no longer active')
  })
  it('junk posted to the button → 404, nothing written', async () => {
    for (const t of ['nope', 'CD'.repeat(24), 'cd'.repeat(23)]) expect((await press(t, 'confirm=yes')).status).toBe(404)
    nothingWritten()
  })
})
