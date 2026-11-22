// @vitest-environment node
//
// Partner emails, slice 2 (2026-11-22):
//
//   A PARTNER WHO UNSUBSCRIBES IS NEVER SENT ANOTHER PARTNER EMAIL, BY ANY PATH.
//     · partnerCanReceive is the one gate, for every kind of partner send
//       (start, next step, a one-off 502, a test sent to a partner). It asks
//       the database, and says NO for every reason the database gives and
//       whenever the database cannot be asked.
//     · the public unsubscribe page takes a partner's link and records it in
//       one database call; a client's link works exactly as before.
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

// ── the page and lib/marketing-unsubscribe.ts ───────────────────────────────
const h = vi.hoisted(() => {
  const state = {
    queue: [] as { table: string; resp: any }[],
    rpc: [] as { fn: string; args: any }[],
    rpcResp: { data: null, error: null } as any,
    updates: [] as any[], inserts: [] as any[], cascades: [] as any[],
  }
  const builder = (table: string) => {
    const i = state.queue.findIndex(q => q.table === table)
    const resp = i >= 0 ? state.queue.splice(i, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    b.select = () => b; b.eq = () => b; b.is = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
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
    rpc: (fn: string, args: any) => { h.state.rpc.push({ fn, args }); return Promise.resolve(h.state.rpcResp) },
  },
}))
vi.mock('@/lib/drip-lifecycle', () => ({ applyDripSideEffects: (a: any) => { h.state.cascades.push(a); return Promise.resolve() } }))

import UnsubscribePage from '@/app/unsubscribe/[token]/page'
import { ensurePartnerUnsubscribeToken, consumePartnerUnsubscribeToken } from './partner-unsubscribe'

const PTOKEN = 'ab'.repeat(32)          // a partner's key: 64 hex
const CTOKEN = 'cd'.repeat(24)          // a client's key: 48 hex
const render = async (token: string) => renderToString((await UnsubscribePage({ params: { token } } as any)) as any)
beforeEach(() => { h.state.queue = []; h.state.rpc = []; h.state.rpcResp = { data: null, error: null }; h.state.updates = []; h.state.inserts = []; h.state.cascades = [] })

describe("the unsubscribe page takes a partner's link", () => {
  it('first click: one database call records it, and the confirmation greets them', async () => {
    h.state.queue.push({ table: 'leads', resp: { data: null, error: null } })
    h.state.rpcResp = { data: [{ outcome: 'unsubscribed', partner_name: 'Taylor Capen', partner_first_name: 'Taylor', partner_network_types: ['partner'] }], error: null }
    const html = await render(PTOKEN)
    expect(h.state.rpc).toEqual([{ fn: 'partner_unsubscribe', args: { p_token: PTOKEN } }])
    expect(html).toContain('unsubscribed, Taylor')
    // nothing about a client was written
    expect(h.state.updates).toEqual([]); expect(h.state.inserts).toEqual([]); expect(h.state.cascades).toEqual([])
  })
  it('an organization is greeted by its whole name (slice 1 rule)', async () => {
    h.state.rpcResp = { data: [{ outcome: 'unsubscribed', partner_name: 'Little Guys Movers', partner_first_name: 'Little', partner_network_types: ['partner', 'organization'] }], error: null }
    expect(await render(PTOKEN)).toContain('unsubscribed, Little Guys Movers')
  })
  it('a second click shows the same confirmation', async () => {
    h.state.rpcResp = { data: [{ outcome: 'already', partner_name: 'Taylor Capen', partner_first_name: 'Taylor', partner_network_types: null }], error: null }
    expect(await render(PTOKEN)).toContain('unsubscribed, Taylor')
  })
  it('a partner whose contact was purged still gets a plain confirmation', async () => {
    h.state.rpcResp = { data: [{ outcome: 'already', partner_name: null, partner_first_name: null, partner_network_types: null }], error: null }
    const html = await render(PTOKEN)
    expect(html).toContain('unsubscribed')
    expect(html).not.toContain('unsubscribed,')
  })
  it('a database failure is NEVER shown as "you\'re unsubscribed"', async () => {
    h.state.rpcResp = { data: null, error: { code: '57014', message: 'canceling statement' } }
    const html = await render(PTOKEN)
    expect(html).toContain('Something went wrong')
    expect(html).not.toContain('re unsubscribed')
  })
  it('an unknown partner key, or the migration not run yet: the clean "no longer active" state', async () => {
    h.state.rpcResp = { data: [{ outcome: 'not_found' }], error: null }
    expect(await render(PTOKEN)).toContain('no longer active')
    h.state.rpcResp = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    expect(await render(PTOKEN)).toContain('no longer active')
  })
})

describe("a client's link works exactly as before", () => {
  it("a client's key never reaches the partner function", async () => {
    h.state.queue.push({ table: 'leads', resp: { data: { id: 'lead-1', first_name: 'Sarah', name: 'Sarah M', location_uuid: 'loc-1', marketing_unsubscribed_at: null, marketing_opt_out: false }, error: null } })
    const html = await render(CTOKEN)
    expect(html).toContain('unsubscribed, Sarah')
    expect(h.state.rpc).toEqual([])
    expect(h.state.updates[0].arg.marketing_opt_out).toBe(true)
    expect(h.state.cascades).toHaveLength(1)
  })
  it('an unknown client key: inactive, and the partner function is not asked (not a partner key)', async () => {
    expect(await render(CTOKEN)).toContain('no longer active')
    expect(h.state.rpc).toEqual([])
  })
  it("the client part of the page is main's, line for line (only the partner block and one shared message were added)", () => {
    const src = readFileSync(join(ROOT, 'app/unsubscribe/[token]/page.tsx'), 'utf8')
    expect(src).toContain(`.from('leads')
      .select('id, first_name, name, location_uuid, marketing_unsubscribed_at, marketing_opt_out')
      .eq('unsubscribe_token', token)`)
    expect(src).toContain(`.update({
      marketing_opt_out: true,
      marketing_unsubscribed_at: now,
      updated_at: now,
    })
    .eq('id', lead.id)
    .is('marketing_unsubscribed_at', null)`)
  })
})

describe('lib/network/partner-unsubscribe.ts: partner keys', () => {
  it('a partner key is made by the database, and only a 64-hex answer is accepted', async () => {
    h.state.rpcResp = { data: PTOKEN, error: null }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(PTOKEN)
    expect(h.state.rpc).toEqual([{ fn: 'partner_unsubscribe_token', args: { p_partner_id: 'p1' } }])
    h.state.rpcResp = { data: null, error: null }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(null)       // no email → no key → no send
    h.state.rpcResp = { data: 'short', error: null }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(null)
    h.state.rpcResp = { data: null, error: { message: 'x' } }
    expect(await ensurePartnerUnsubscribeToken('p1')).toBe(null)
    expect(await ensurePartnerUnsubscribeToken('')).toBe(null)
  })
  it('consume refuses anything that is not a partner key without asking', async () => {
    for (const t of ['', CTOKEN, 'ZZ'.repeat(32), PTOKEN + 'a']) expect(await consumePartnerUnsubscribeToken(t)).toEqual({ outcome: 'not_found' })
    expect(h.state.rpc).toEqual([])
  })
  it('the client token library (lib/marketing-unsubscribe.ts) is not touched: no partner code in it', () => {
    expect(readFileSync(join(ROOT, 'lib/marketing-unsubscribe.ts'), 'utf8')).not.toMatch(/partner/i)
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
  it('an owner writing straight to the database is refused by it (triggers in the migration; proven live in the dry run)', () => {
    const mig = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8')
    expect(mig).toMatch(/IF TG_OP = 'UPDATE' AND OLD\.unsubscribed_at IS NOT NULL\s+AND \(NEW\.unsubscribed_at IS DISTINCT FROM OLD\.unsubscribed_at\s+OR NEW\.unsubscribe_source IS DISTINCT FROM OLD\.unsubscribe_source\) THEN\s+RAISE EXCEPTION 'partner_unsubscribe_is_final/)
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
    expect(users.sort()).toEqual(['lib/network/partner-email-eligibility.ts', 'lib/network/partner-unsubscribe.ts'])
  })
})
