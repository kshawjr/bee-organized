// @vitest-environment node
//
// Partner emails, slice 2 (2026-11-22):
//
//   OPENING THE UNSUBSCRIBE LINK SENDS NOBODY AN UNSUBSCRIBE; PRESSING THE
//   BUTTON DOES. AN OWNER'S MARK IS REVERSIBLE BY A SUPER ADMIN ONLY; A
//   PARTNER'S OWN IS NOT; THE TWO ARE TOLD APART.
//
//   A PARTNER WHO UNSUBSCRIBES IS NEVER SENT ANOTHER PARTNER EMAIL, BY ANY PATH.
//     · partnerCanReceive is the one gate, for every kind of partner send
//       (start, next step, a one-off 502, a test sent to a partner). It asks
//       the database, and says NO for every reason the database gives and
//       whenever the database cannot be asked.
//     · the public unsubscribe page only READS a partner's link and asks; only
//       the button's POST records it; a client's link works exactly as before.
//     · (the database side — an unsubscribed partner cannot be started,
//       advanced or restarted; unsubscribing stops active sequences — is
//       proven on a running copy by the dry run, 97 checks)
//
//   THE UNSUBSCRIBE CANNOT BE UNDONE BY A SYNC, AN IMPORT OR AN OWNER.
//     · no route, import, sync or screen can write the two columns: every
//       partners write goes through an allowlist, and none lists them
//     · no app code names them at all (only the database functions do)
//     · and the database refuses to clear or change them anyway (dry run)
//
//   NOTHING IN THIS SLICE CAN SEND AN EMAIL (fingerprint, as in slice 1).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  PARTNER_SEND_KINDS, PARTNER_BLOCK_REASONS, partnerCanReceive, partnerSendBlockReason, partnerBlockReasonFromFacts,
} from './partner-email-eligibility'

const ROOT = process.cwd()

// ── the gate ────────────────────────────────────────────────────────────────
const dbSaying = (data: unknown, error: unknown = null) => {
  const calls: [string, Record<string, unknown>][] = []
  return { calls, rpc: (fn: string, args: Record<string, unknown>) => { calls.push([fn, args]); return Promise.resolve({ data, error }) } }
}

describe('partnerCanReceive: the one gate every partner email must pass', () => {
  it('covers every way a partner email can go: start, step, manual, test', () => {
    expect([...PARTNER_SEND_KINDS]).toEqual(['start', 'step', 'manual', 'test'])
  })
  for (const kind of PARTNER_SEND_KINDS) {
    it(`${kind}: an unsubscribed partner is refused`, async () => {
      expect(await partnerCanReceive(dbSaying('unsubscribed'), 'p1', kind)).toBe(false)
    })
    it(`${kind}: the same address unsubscribed elsewhere (or before a purge) is refused`, async () => {
      expect(await partnerCanReceive(dbSaying('address_unsubscribed'), 'p1', kind)).toBe(false)
    })
    it(`${kind}: refused when the database cannot be asked (error, or the migration not run)`, async () => {
      expect(await partnerCanReceive(dbSaying(null, { message: 'function partner_send_block_reason does not exist' }), 'p1', kind)).toBe(false)
      expect(await partnerCanReceive({ rpc: () => { throw new Error('network') } }, 'p1', kind)).toBe(false)
      expect(await partnerCanReceive({ rpc: () => Promise.reject(new Error('network')) }, 'p1', kind)).toBe(false)
    })
    it(`${kind}: refused for an answer it does not recognise`, async () => {
      expect(await partnerCanReceive(dbSaying('something_new'), 'p1', kind)).toBe(false)
      expect(await partnerCanReceive(dbSaying(undefined), 'p1', kind)).toBe(false)
      expect(await partnerCanReceive(dbSaying(false), 'p1', kind)).toBe(false)
    })
    it(`${kind}: allowed only when the database says nothing stands in the way`, async () => {
      const db = dbSaying(null)
      expect(await partnerCanReceive(db, 'p1', kind)).toBe(true)
      expect(db.calls).toEqual([['partner_send_block_reason', { p_partner_id: 'p1' }]])
    })
  }
  it('every reason the database can give is a refusal', async () => {
    for (const r of PARTNER_BLOCK_REASONS) expect(await partnerCanReceive(dbSaying(r), 'p1', 'step'), r).toBe(false)
  })
  it('no partner id, or a kind that is not one of the four: refused without asking', async () => {
    const db = dbSaying(null)
    expect(await partnerCanReceive(db, '', 'start')).toBe(false)
    expect(await partnerCanReceive(db, 'p1', 'bypass' as any)).toBe(false)
    expect(db.calls).toEqual([])
  })
  it('partnerSendBlockReason reports the reason, and "check_failed" when it cannot ask', async () => {
    expect(await partnerSendBlockReason(dbSaying('unsubscribed'), 'p1')).toBe('unsubscribed')
    expect(await partnerSendBlockReason(dbSaying(null, { message: 'x' }), 'p1')).toBe('check_failed')
  })
  it('the TypeScript reading of the rule (for screens) blocks an unsubscribed partner whatever else is true', () => {
    for (const deletedAt of [null, 'x']) for (const email of [null, '', 'a@b.c']) for (const addressUnsubscribed of [false, true]) {
      expect(partnerBlockReasonFromFacts({ exists: true, unsubscribedAt: '2026-11-22', deletedAt, email, addressUnsubscribed })).toBe('unsubscribed')
    }
    expect(partnerBlockReasonFromFacts({ exists: true, unsubscribedAt: null, deletedAt: null, email: 'a@b.c', addressUnsubscribed: true })).toBe('address_unsubscribed')
    expect(partnerBlockReasonFromFacts({ exists: true, unsubscribedAt: null, deletedAt: null, email: 'a@b.c', addressUnsubscribed: false })).toBe(null)
  })
})

// ── the page, the button, and lib/network/partner-unsubscribe.ts ───────────
const h = vi.hoisted(() => {
  const state = {
    queue: [] as { table: string; resp: any }[],
    rpc: [] as { fn: string; args: any }[],
    rpcByFn: {} as Record<string, any>,
    updates: [] as any[], inserts: [] as any[], cascades: [] as any[],
    caller: { id: 'u-owner', role: 'owner', location_id: 'loc-1' } as any,
  }
  const builder = (table: string) => {
    const i = state.queue.findIndex(q => q.table === table)
    const resp = i >= 0 ? state.queue.splice(i, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    b.select = () => b; b.eq = () => b; b.is = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.upsert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.delete = () => { state.updates.push({ table, arg: 'DELETE' }); return b }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, builder }
})
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (t: string) => h.builder(t),
    rpc: (fn: string, args: any) => { h.state.rpc.push({ fn, args }); return Promise.resolve(h.state.rpcByFn[fn] ?? { data: null, error: null }) },
  },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.caller ? { id: h.state.caller.id } : null } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: h.state.caller, error: null }); b.maybeSingle = b.single; return b },
  }),
}))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: (a: any) => { h.state.cascades.push(a); return Promise.resolve() } }))

import { NextRequest } from 'next/server'
import UnsubscribePage from '@/app/unsubscribe/[token]/page'
import * as ConfirmRoute from '@/app/unsubscribe/[token]/confirm/route'
import { POST as markPOST } from '@/app/api/partners/[id]/unsubscribe/route'
import { POST as reversePOST } from '@/app/api/partners/[id]/unsubscribe/reverse/route'
import { ensurePartnerUnsubscribeToken, consumePartnerUnsubscribeToken, partnerUnsubscribeStatus } from './partner-unsubscribe'

const PTOKEN = 'ab'.repeat(32)          // a partner's key: 64 hex
const CTOKEN = 'cd'.repeat(24)          // a client's key: 48 hex
const render = async (token: string, searchParams: any = {}) => renderToString((await UnsubscribePage({ params: { token }, searchParams } as any)) as any)
const statusSays = (outcome: string, first = 'Taylor', name = 'Taylor Capen', types: any = ['partner']) =>
  (h.state.rpcByFn.partner_unsubscribe_status = { data: [{ outcome, partner_name: name, partner_first_name: first, partner_network_types: types }], error: null })
const consumeSays = (outcome: string) =>
  (h.state.rpcByFn.partner_unsubscribe = { data: [{ outcome, partner_name: 'Taylor Capen', partner_first_name: 'Taylor', partner_network_types: ['partner'] }], error: null })
const press = (token: string, body: string | null, method = 'POST') => (ConfirmRoute as any).POST(
  new NextRequest(`http://hub.test/unsubscribe/${token}/confirm`, { method, body, headers: { 'content-type': 'application/x-www-form-urlencoded' } }), { params: { token } })
const writesToUnsubscribe = () => h.state.rpc.filter(r => r.fn !== 'partner_unsubscribe_status')
const noWritesAtAll = () => { expect(writesToUnsubscribe()).toEqual([]); expect(h.state.updates).toEqual([]); expect(h.state.inserts).toEqual([]); expect(h.state.cascades).toEqual([]) }
beforeEach(() => { h.state.queue = []; h.state.rpc = []; h.state.rpcByFn = {}; h.state.updates = []; h.state.inserts = []; h.state.cascades = []; h.state.caller = { id: 'u-owner', role: 'owner', location_id: 'loc-1' } })

describe('OPENING a partner\'s unsubscribe link sends nobody an unsubscribe (mail scanners, previews, prefetch, HEAD)', () => {
  it('the page asks "Stop receiving these emails?" with a button, and only LOOKS', async () => {
    statusSays('pending')
    const html = await render(PTOKEN)
    expect(html).toContain('Stop receiving these emails?')
    expect(html).toContain(`<form method="post" action="/unsubscribe/${PTOKEN}/confirm"`)
    expect(html).toContain('name="confirm" value="yes"')
    expect(html).toContain('Unsubscribe me')
    expect(h.state.rpc).toEqual([{ fn: 'partner_unsubscribe_status', args: { p_token: PTOKEN } }])
    noWritesAtAll()
  })
  it('opened ten times (a scanner, then a preview, then the person): still nothing recorded', async () => {
    statusSays('pending')
    for (let i = 0; i < 10; i++) await render(PTOKEN)
    expect(h.state.rpc.map(r => r.fn)).toEqual(Array(10).fill('partner_unsubscribe_status'))
    noWritesAtAll()
  })
  it('a query string can not turn the open into an unsubscribe (no ?confirm shortcut)', async () => {
    statusSays('pending')
    const html = await render(PTOKEN, { confirm: 'yes', 'List-Unsubscribe': 'One-Click', error: '0' })
    expect(html).toContain('Stop receiving these emails?')
    noWritesAtAll()
  })
  it('the button route answers POST only: no GET or HEAD handler exists, so Next returns 405 and runs nothing', () => {
    expect(Object.keys(ConfirmRoute).filter(k => /^(GET|HEAD|PUT|PATCH|DELETE|OPTIONS)$/.test(k))).toEqual([])
    expect(typeof (ConfirmRoute as any).POST).toBe('function')
  })
  it('an empty or stray POST (no button press) changes nothing', async () => {
    for (const body of [null, '', 'confirm=no', 'foo=bar', 'List-Unsubscribe=Maybe']) {
      const res = await press(PTOKEN, body)
      expect(res.status, String(body)).toBe(400)
    }
    noWritesAtAll()
  })
  it('junk posted to the button changes nothing', async () => {
    for (const t of ['nope', 'AB'.repeat(32), 'ab'.repeat(31)]) expect((await press(t, 'confirm=yes')).status).toBe(404)
    noWritesAtAll()
  })
  it("a client's key posted to the button goes to the CLIENT path only — never a partner function (FL-75 slice 2)", async () => {
    // unknown client key: looked up on leads, nothing found, nothing written
    const res = await press(CTOKEN, 'confirm=yes')
    expect(res.status).toBe(303)
    expect(h.state.rpc).toEqual([])
    noWritesAtAll()
  })
  it('once used, the page shows the confirmation (no button), still without writing', async () => {
    statusSays('already')
    const html = await render(PTOKEN)
    expect(html).toContain('unsubscribed, Taylor')
    expect(html).not.toContain('<form')
    noWritesAtAll()
  })
  it('an organization is greeted by its whole name (slice 1 rule)', async () => {
    statusSays('already', 'Little', 'Little Guys Movers', ['partner', 'organization'])
    expect(await render(PTOKEN)).toContain('unsubscribed, Little Guys Movers')
  })
  it('an unknown key, or the migration not run yet: the clean "no longer active" state', async () => {
    statusSays('not_found')
    expect(await render(PTOKEN)).toContain('no longer active')
    h.state.rpcByFn.partner_unsubscribe_status = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    expect(await render(PTOKEN)).toContain('no longer active')
    noWritesAtAll()
  })
  it('a database failure on open is never shown as "you\'re unsubscribed"', async () => {
    h.state.rpcByFn.partner_unsubscribe_status = { data: null, error: { code: '57014', message: 'canceling statement' } }
    const html = await render(PTOKEN)
    expect(html).toContain('Something went wrong')
    expect(html).not.toContain('re unsubscribed')
  })
})

describe('PRESSING the button does unsubscribe', () => {
  it('the button (confirm=yes) records it in one database call and sends the browser back to the page (303)', async () => {
    consumeSays('unsubscribed')
    const res = await press(PTOKEN, 'confirm=yes')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`http://hub.test/unsubscribe/${PTOKEN}`)
    expect(h.state.rpc).toEqual([{ fn: 'partner_unsubscribe', args: { p_token: PTOKEN } }])
  })
  it('pressing again is harmless ("already") and lands on the same confirmation', async () => {
    consumeSays('already')
    const res = await press(PTOKEN, 'confirm=yes')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`http://hub.test/unsubscribe/${PTOKEN}`)
  })
  it('a failure goes back to the question with an honest message, never a false confirmation', async () => {
    h.state.rpcByFn.partner_unsubscribe = { data: null, error: { code: '57014', message: 'x' } }
    const res = await press(PTOKEN, 'confirm=yes')
    expect(res.headers.get('location')).toBe(`http://hub.test/unsubscribe/${PTOKEN}?error=1`)
    statusSays('pending')
    const html = await render(PTOKEN, { error: '1' })
    expect(html).toContain('couldn')
    expect(html).toContain('Unsubscribe me')
    expect(html).not.toContain('re unsubscribed')
  })
  it("a mail provider's RFC 8058 one-click POST (List-Unsubscribe=One-Click) is a deliberate press too", async () => {
    consumeSays('unsubscribed')
    const res = await press(PTOKEN, 'List-Unsubscribe=One-Click')
    expect(res.status).toBe(200)
    expect(h.state.rpc).toEqual([{ fn: 'partner_unsubscribe', args: { p_token: PTOKEN } }])
  })
  it('the partner confirmation does not offer to add them back (their own unsubscribe is permanent)', async () => {
    statusSays('already')
    const html = await render(PTOKEN)
    expect(html).toContain("You won&#x27;t get any more of these emails from Bee Organized.")
    expect(html).not.toContain('add you back')
  })
})

describe("a client's link (FL-75 slice 2: it asks too now; the partner list stays separate)", () => {
  const sarah = () => h.state.queue.push({ table: 'leads', resp: { data: { id: 'lead-1', first_name: 'Sarah', name: 'Sarah M', location_uuid: 'loc-1', marketing_unsubscribed_at: null, marketing_opt_out: false }, error: null } })
  it("opening a client's link asks, writes nothing, and asks no partner function", async () => {
    sarah()
    const html = await render(CTOKEN)
    expect(html).toContain('Stop receiving marketing emails?')
    expect(html).toContain(`<form method="post" action="/unsubscribe/${CTOKEN}/confirm"`)
    expect(h.state.rpc).toEqual([])
    noWritesAtAll()
  })
  it("pressing a client's button writes the CLIENT record only — never a partner function", async () => {
    sarah()
    const res = await press(CTOKEN, 'confirm=yes')
    expect(res.status).toBe(303)
    expect(h.state.rpc).toEqual([])
    expect(h.state.updates.map(u => u.table)).toEqual(['leads'])
    expect(h.state.updates[0].arg.marketing_opt_out).toBe(true)
    expect(h.state.cascades).toHaveLength(1)
  })
  it('an unknown client key: inactive, and no partner function is asked (not a partner key)', async () => {
    expect(await render(CTOKEN)).toContain('no longer active')
    expect(h.state.rpc).toEqual([])
  })
  it("the client token mint, consent gate and opt-in page are byte for byte main's (f115e0ee)", () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const sha = (f: string) => createHash('sha256').update(readFileSync(join(ROOT, f))).digest('hex').slice(0, 16)
    expect({
      'lib/marketing-unsubscribe.ts': sha('lib/marketing-unsubscribe.ts'),
      'lib/marketing-consent.ts': sha('lib/marketing-consent.ts'),
      'app/mailing-list/[token]/page.tsx': sha('app/mailing-list/[token]/page.tsx'),
    }).toEqual({
      'lib/marketing-unsubscribe.ts': '70df2b79338a6972',
      'lib/marketing-consent.ts': '5f63f5b6bc50f8e2',
      'app/mailing-list/[token]/page.tsx': '4d8ae8b2a4a359d5',
    })
    // lib/beta-unsubscribe-page.test.tsx was pinned here too ('e1fb4f34beb7b6b1')
    // until FL-75 slice 2 (2026-11-23) rewrote it: Kevin's ruling that opening
    // a client's link must only read, like a partner's.
  })
  it('the client withdrawal is the same write it always was, now behind the button', () => {
    const src = readFileSync(join(ROOT, 'lib/client-unsubscribe.ts'), 'utf8')
    expect(src).toContain(`.from('leads')
      .select('id, first_name, name, location_uuid, marketing_unsubscribed_at, marketing_opt_out')
      .eq('unsubscribe_token', token)`)
    expect(src).toContain(`.update({ marketing_opt_out: true, marketing_unsubscribed_at: now, updated_at: now })
    .eq('id', lead.id)
    .is('marketing_unsubscribed_at', null)`)
    const page = readFileSync(join(ROOT, 'app/unsubscribe/[token]/page.tsx'), 'utf8')
    expect(page).toContain(`body="You won't get any more marketing emails from Bee Organized. If you change your mind, just reply to any email we've sent you and we'll happily add you back."`)
  })
  it('the client list and the partner list never name each other', () => {
    for (const f of ['lib/client-unsubscribe.ts', 'lib/marketing-no-list.ts', 'migrations/marketing_unsubscribes.sql']) {
      const code = readFileSync(join(ROOT, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|--)/.test(l)).join('\n')
      expect(code, f).not.toMatch(/partner_unsubscribe|partner-unsubscribe/)
    }
    for (const f of ['lib/network/partner-unsubscribe.ts', 'migrations/partner_emails.sql']) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/marketing_unsubscribes|marketing-no-list|marketing_address_said_no/)
    }
  })
})

describe('lib/network/partner-unsubscribe.ts: partner keys', () => {
  it('a partner key is made by the database, and only a 64-hex answer is accepted', async () => {
    h.state.rpcByFn.partner_unsubscribe_token = { data: PTOKEN, error: null }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(PTOKEN)
    expect(h.state.rpc).toEqual([{ fn: 'partner_unsubscribe_token', args: { p_partner_id: 'p1' } }])
    h.state.rpcByFn.partner_unsubscribe_token = { data: null, error: null }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(null)       // no email → no key → no send
    h.state.rpcByFn.partner_unsubscribe_token = { data: 'short', error: null }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(null)
    h.state.rpcByFn.partner_unsubscribe_token = { data: null, error: { message: 'x' } }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(null)
    expect(await ensurePartnerUnsubscribeToken('')).toBe(null)
  })
  it('status and consume refuse anything that is not a partner key without asking', async () => {
    for (const t of ['', CTOKEN, 'ZZ'.repeat(32), PTOKEN + 'a']) {
      expect(await consumePartnerUnsubscribeToken(t)).toEqual({ outcome: 'not_found' })
      expect(await partnerUnsubscribeStatus(t)).toEqual({ outcome: 'not_found' })
    }
    expect(h.state.rpc).toEqual([])
  })
  it('the client token library (lib/marketing-unsubscribe.ts) is not touched: no partner code in it', () => {
    expect(readFileSync(join(ROOT, 'lib/marketing-unsubscribe.ts'), 'utf8')).not.toMatch(/partner/i)
  })
})

describe("an owner's mark is reversible by a super admin; a partner's own is not; the two are told apart", () => {
  const post = (fn: any, id: string) => fn(new NextRequest('http://hub.test/x', { method: 'POST' }), { params: Promise.resolve({ id }) })
  it("an owner's mark goes through the database function, with who did it", async () => {
    h.state.queue.push({ table: 'partners', resp: { data: { id: 'p1', location_id: 'loc-1' }, error: null } })
    h.state.rpcByFn.partner_mark_unsubscribed = { data: 'unsubscribed', error: null }
    const res = await post(markPOST, 'p1')
    expect(res.status).toBe(200)
    expect(h.state.rpc).toEqual([{ fn: 'partner_mark_unsubscribed', args: { p_partner_id: 'p1', p_by: 'u-owner' } }])
    expect(h.state.updates).toEqual([])           // never a direct write to the contact
  })
  it("an owner at another location, or a read-only user, can not mark (and gets 'not found')", async () => {
    for (const caller of [{ id: 'u2', role: 'owner', location_id: 'loc-2' }, { id: 'u3', role: 'lite_user', location_id: 'loc-1' }]) {
      h.state.caller = caller
      h.state.queue.push({ table: 'partners', resp: { data: { id: 'p1', location_id: 'loc-1' }, error: null } })
      expect((await post(markPOST, 'p1')).status).toBe(404)
    }
    expect(h.state.rpc).toEqual([])
  })
  for (const role of ['owner', 'manager', 'admin', 'lite_user']) {
    it(`a ${role} can NOT reverse (super admin only), and the database is not even asked`, async () => {
      h.state.caller = { id: 'u', role, location_id: 'loc-1' }
      const res = await post(reversePOST, 'p1')
      expect(res.status).toBe(403)
      expect(h.state.rpc).toEqual([])
    })
  }
  it("a super admin reverses an owner's mark through the database function", async () => {
    h.state.caller = { id: 'u-super', role: 'super_admin', location_id: null }
    h.state.rpcByFn.partner_reverse_unsubscribe = { data: [{ outcome: 'reversed', still_blocked: null }], error: null }
    const res = await post(reversePOST, 'p1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, outcome: 'reversed', still_blocked: null })
    expect(h.state.rpc).toEqual([{ fn: 'partner_reverse_unsubscribe', args: { p_partner_id: 'p1', p_by: 'u-super' } }])
    expect(h.state.updates).toEqual([])
  })
  it("a super admin can NOT reverse a partner's own unsubscribe: 409, nothing changed", async () => {
    h.state.caller = { id: 'u-super', role: 'super_admin', location_id: null }
    h.state.rpcByFn.partner_reverse_unsubscribe = { data: [{ outcome: 'partner_unsubscribed_themselves', still_blocked: 'unsubscribed' }], error: null }
    const res = await post(reversePOST, 'p1')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('partner_unsubscribed_themselves')
  })
  it('the database decides, and refuses a non-super-admin too (proven live in the dry run)', () => {
    const mig = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8')
    expect(mig).toMatch(/IF NOT EXISTS \(SELECT 1 FROM public\.hub_users h WHERE h\.id = p_by AND h\.role = 'super_admin'\) THEN\s+RETURN QUERY SELECT 'not_super_admin'/)
    expect(mig).toMatch(/IF v_partner\.unsubscribe_source = 'link' THEN\s+RETURN QUERY SELECT 'partner_unsubscribed_themselves'/)
  })
})

// ── cannot be undone ────────────────────────────────────────────────────────
import { partnerPatchToRow } from '../crm'
import { NEW_CONTACT_COLUMNS } from './contact-create'
import { WRITABLE_COLUMNS, planContactSave } from './contact-edit'
import { ADD_COLUMNS } from './contact-adds'
import { BULK_ACTIONS } from './bulk'
import { leadToPartnerRow, fillEmptyPartnerPatch } from '../lead-to-network'

const UNSUB_COLS = ['unsubscribed_at', 'unsubscribe_source']
const ATTEMPT = { unsubscribed_at: null, unsubscribedAt: null, unsubscribe_source: null, unsubscribeSource: null, isUnsubscribed: false, unsubscribed: false }

describe('no sync, import, route or owner can write the unsubscribe', () => {
  it('Network edit / partner PATCH + POST ("Referred by" › Create) drop it (lib/crm partnerPatchToRow)', () => {
    expect(Object.keys(partnerPatchToRow({ ...ATTEMPT, name: 'x' }))).toEqual(['name'])
  })
  it('Add contact and CSV import write only NEW_CONTACT_COLUMNS, which do not include it', () => {
    for (const c of UNSUB_COLS) expect(NEW_CONTACT_COLUMNS as readonly string[]).not.toContain(c)
  })
  it('the contact sheet save writes only WRITABLE_COLUMNS and ADD_COLUMNS, which do not include it', () => {
    for (const c of UNSUB_COLS) {
      expect(WRITABLE_COLUMNS).not.toContain(c)
      expect(Object.values(ADD_COLUMNS) as string[]).not.toContain(c)
    }
    // asked to change it, the save is refused outright, and writes nothing
    const plan = planContactSave({ id: 'p1', name: 'A', unsubscribed_at: '2026-11-22' } as any, { unsubscribed_at: null } as any) as any
    expect(plan.ok).toBe(false)
    expect(plan.update).toBeUndefined()
  })
  it('bulk changes only level and stage (and tags)', () => {
    expect([...BULK_ACTIONS]).toEqual(['tag_add', 'tag_remove', 'level', 'stage'])
  })
  it('Add to Network (from a client) builds its row and patch without it', () => {
    expect(Object.keys(leadToPartnerRow({ ...ATTEMPT, name: 'A', location_uuid: 'l' }))).not.toEqual(expect.arrayContaining(UNSUB_COLS))
    for (const k of Object.keys(leadToPartnerRow({ ...ATTEMPT, name: 'A', location_uuid: 'l' }))) expect(k).not.toMatch(/unsub/)
    for (const k of Object.keys(fillEmptyPartnerPatch({}, { ...ATTEMPT, email: 'a@b.c' }))) expect(k).not.toMatch(/unsub/)
  })
  it('no app code names the two columns at all: only the database writes them', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        const rel = join(dir, name)
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue
        // \bunsubscribed_at\b does not match leads.marketing_unsubscribed_at
        const code = readFileSync(join(ROOT, rel), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
        if (/\bunsubscribed_at\b|\bunsubscribe_source\b/.test(code)) offenders.push(rel)
      }
    }
    for (const d of ['app', 'lib', 'components', 'scripts']) walk(d)
    expect(offenders).toEqual([])
    expect(readFileSync(join(ROOT, 'middleware.ts'), 'utf8')).not.toMatch(/\bunsubscribed_at\b/)
  })
  it('an owner writing straight to the database is refused by it: a partner\'s own is final, and anything else must go through the functions (proven live in the dry run)', () => {
    const mig = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8')
    expect(mig).toMatch(/IF OLD\.unsubscribe_source = 'link' THEN\s+RAISE EXCEPTION 'partner_unsubscribe_is_final/)
    expect(mig).toMatch(/IF NOT public\.partner_unsubscribe_writer\(\) THEN\s+RAISE EXCEPTION 'partner_unsubscribe_via_function_only/)
  })
})

// ── nothing in this slice can send ──────────────────────────────────────────
describe('nothing in this slice can send an email (fingerprint)', () => {
  const files = ['lib/partner-sequences.ts', 'lib/network/partner-email-eligibility.ts']
  for (const f of files) {
    const code = readFileSync(join(ROOT, f), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    it(`${f}: imports nothing at all`, () => {
      expect(code).not.toMatch(/^\s*import\s/m)
      expect(code).not.toMatch(/\brequire\(|\bimport\(/)
    })
    it(`${f}: calls no send function and talks to no email provider`, () => {
      expect(code).not.toMatch(/\bsendEmail\w*\s*\(|\bsendDrip\w*\s*\(|new\s+Resend\b|\.emails\.send\b|\bfetch\s*\(|api\.resend\.com|XMLHttpRequest/)
    })
  }
  it('lib/network/partner-unsubscribe.ts sends nothing and imports only the database client', () => {
    const src = readFileSync(join(ROOT, 'lib/network/partner-unsubscribe.ts'), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/\bsendEmail\w*\s*\(|\bsendDrip\w*\s*\(|new\s+Resend\b|\.emails\.send\b|\bfetch\s*\(/)
    const imports = Array.from(code.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)).map(m => m[2])
    expect(imports).toEqual(['@/lib/supabase-service'])
  })
  it('the migration schedules nothing and calls out to nothing', () => {
    const mig = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(mig).not.toMatch(/\bcron\.|pg_net|net\.http|http_post|pg_notify|NOTIFY\b/i)
  })
  it('no file outside this slice uses the new partner modules, so no sender, job or screen reads them yet', () => {
    const users: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue
        const rel = join(dir, name)
        if (statSync(join(ROOT, rel)).isDirectory()) { walk(rel); continue }
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue
        const s = readFileSync(join(ROOT, rel), 'utf8')
        if (/partner-email-eligibility|ensurePartnerUnsubscribeToken|partner_drip_progress/.test(s)) users.push(rel)
      }
    }
    for (const d of ['app', 'lib', 'components', 'scripts']) walk(d)
    // Slice 4 (2026-11-22) is the sender: it, its cron and the partway count are the
    // only new readers.
    // Slice 5 (2026-11-23): Start / Stop (lib/network/partner-sequence-start.ts).
    expect(users.sort()).toEqual(['app/api/cron/send-partner-emails/route.ts', 'app/api/drip-paths/[id]/active-lead-count/route.ts', 'lib/network/partner-drip-send.ts', 'lib/network/partner-email-eligibility.ts', 'lib/network/partner-sequence-start.ts', 'lib/network/partner-unsubscribe.ts'])
  })
})
