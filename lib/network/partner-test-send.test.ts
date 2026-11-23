// @vitest-environment node
//
// Partner emails, slice 3: "SEND ME A TEST" FOR A PARTNER EMAIL
// (app/api/emails/test-send-partner).
//   · it only ever goes to the signed-in person's own login address; a "to"
//     in the request is ignored; no partner row is read, so no partner address
//     can be reached
//   · sample partner "Taylor"; the signature with NO assignee; the location's
//     primary owner as {{location_owner_name}}; the partner footer always,
//     with MARKETING_POSTAL_ADDRESS and a link to /unsubscribe/test-email
//   · no partner_unsubscribe_links row (no rpc, no write but the send log)
//   · a client step, or another location's copy, is refused
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    queue: [] as { table: string; resp: any }[], tables: [] as string[], rpc: [] as any[], writes: [] as any[],
    sent: [] as any[], sigArgs: [] as any[], user: { id: 'u-owner', email: 'owner@beeorganized.com' } as any,
  }
  const builder = (table: string) => {
    state.tables.push(table)
    const i = state.queue.findIndex(q => q.table === table)
    const resp = i >= 0 ? state.queue.splice(i, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = () => b
    for (const op of ['update', 'insert', 'upsert', 'delete']) b[op] = (a: any) => { state.writes.push({ table, op, a }); return b }
    b.single = () => Promise.resolve(resp); b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, builder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.builder(t), rpc: (...a: any[]) => { h.state.rpc.push(a); return Promise.resolve({ data: null, error: null }) } } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.user } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'u-owner', role: 'owner', location_id: 'loc-1' }, error: null }); return b },
  }),
}))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: async () => ({ id: 'u-primary', full_name: 'Lynette Ewy', phone: null }) }))
vi.mock('@/lib/email-signature-resolve', () => ({ resolveEmailSignature: async (a: any) => { h.state.sigArgs.push(a); return { name: 'Signing Person', title: 'Owner', email: 'kc@beeorganized.com', mobile: null, photoUrl: null, locationName: 'Kansas City' } } }))
vi.mock('@/lib/resend', async (orig) => ({ ...(await orig() as any), sendEmail: async (a: any) => { h.state.sent.push(a); return { success: true } } }))

import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POST } from '@/app/api/emails/test-send-partner/route'

const LOC = { id: 'loc-1', name: 'Kansas City', phone: '8165550100', city: 'Kansas City', state: 'MO', rate_per_hour: '$95', reviews_link: null, email_style: 'soft' }
const partnerStep = (over: any = {}) => ({ id: 'st1', subject: 'Great to meet you', body: 'Hi {{partner_name}},\n\nIt was such a pleasure meeting you. {{first_name}}\n\nWarmly,\n{{location_owner_name}}\n{{signature}}', body_format: 'plain', drip_paths: { id: 'p1', location_uuid: null, is_master: true, path_key: 'partner-introduction' }, ...over })
const post = (body: any) => POST(new NextRequest('http://hub.test/api/emails/test-send-partner', { method: 'POST', body: JSON.stringify(body) }))
const queue = (step: any) => { h.state.queue.push({ table: 'locations', resp: { data: LOC, error: null } }, { table: 'drip_path_steps', resp: { data: step, error: null } }) }

beforeEach(() => {
  Object.assign(h.state, { queue: [], tables: [], rpc: [], writes: [], sent: [], sigArgs: [], user: { id: 'u-owner', email: 'owner@beeorganized.com' } })
  process.env.MARKETING_POSTAL_ADDRESS = '1 Hive Way, Kansas City, MO 64105'
  process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
})

describe('a partner test goes only to the signed-in person', () => {
  it('to the login address; a "to" in the request is ignored', async () => {
    queue(partnerStep())
    const res = await post({ locationId: 'loc-1', stepId: 'st1', to: 'partner@elsewhere.com' })
    expect(res.status).toBe(200)
    expect(h.state.sent).toHaveLength(1)
    expect(h.state.sent[0].to).toBe('owner@beeorganized.com')
    expect(JSON.stringify(h.state.sent)).not.toContain('partner@elsewhere.com')
  })
  it('never reads the partners table or any partner key, and writes nothing (but the send log inside sendEmail)', async () => {
    queue(partnerStep())
    await post({ locationId: 'loc-1', stepId: 'st1' })
    expect(h.state.tables.sort()).toEqual(['drip_path_steps', 'locations'])
    expect(h.state.rpc).toEqual([])
    expect(h.state.writes).toEqual([])
  })
})

describe('what the test contains', () => {
  it('sample partner Taylor, the owner name, no client tag, the subject', async () => {
    queue(partnerStep())
    await post({ locationId: 'loc-1', stepId: 'st1' })
    const m = h.state.sent[0]
    expect(m.subject).toBe('[Test] Great to meet you')
    expect(m.html).toContain('Hi Taylor,')
    expect(m.text).toContain('Hi Taylor,')
    expect(m.text).toContain('Lynette Ewy')        // {{location_owner_name}} = primary owner
    expect(m.text).not.toContain('{{first_name}}')  // a client tag renders blank
    expect(m.email_kind).toBe('test')
  })
  it('the signature with no assignee (owner → location)', async () => {
    queue(partnerStep())
    await post({ locationId: 'loc-1', stepId: 'st1' })
    expect(h.state.sigArgs).toEqual([{ locationId: 'loc-1', locationName: 'Kansas City', assigneeUserId: null }])
  })
  it('the unsubscribe footer, always: partner reason, the company postal address, a link that is no one\'s key', async () => {
    queue(partnerStep())
    await post({ locationId: 'loc-1', stepId: 'st1' })
    const m = h.state.sent[0]
    for (const part of [m.html, m.text]) {
      expect(part).toContain('referral partners')
      expect(part).toContain('1 Hive Way, Kansas City, MO 64105')
      expect(part).toContain('https://hub.test/unsubscribe/test-email')
      expect(part).not.toContain('a Bee Organized client')
    }
  })
  it('a blank subject is held, not sent', async () => {
    queue(partnerStep({ subject: null }))
    const res = await post({ locationId: 'loc-1', stepId: 'st1' })
    expect(res.status).toBe(409)
    expect(h.state.sent).toEqual([])
  })
})

describe('only a partner sequence of this location', () => {
  it('a client step is refused', async () => {
    queue(partnerStep({ drip_paths: { id: 'p', location_uuid: null, is_master: true, path_key: 'organizing-a' } }))
    expect((await post({ locationId: 'loc-1', stepId: 'st1' })).status).toBe(404)
    expect(h.state.sent).toEqual([])
  })
  it("another location's copy is refused", async () => {
    queue(partnerStep({ drip_paths: { id: 'p', location_uuid: 'loc-2', is_master: false, path_key: 'partner-introduction' } }))
    expect((await post({ locationId: 'loc-1', stepId: 'st1' })).status).toBe(404)
  })
  it("this location's own copy works", async () => {
    queue(partnerStep({ drip_paths: { id: 'p', location_uuid: 'loc-1', is_master: false, path_key: 'partner-introduction' } }))
    expect((await post({ locationId: 'loc-1', stepId: 'st1' })).status).toBe(200)
  })
  it('signed out: nothing sent', async () => {
    h.state.user = null
    expect((await post({ locationId: 'loc-1', stepId: 'st1' })).status).toBe(401)
    expect(h.state.sent).toEqual([])
  })
})

describe('source: the address comes from the session, nowhere else', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/emails/test-send-partner/route.ts'), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  it('one sendEmail, to = the session user', () => {
    expect(src.match(/sendEmail\(/g)).toHaveLength(1)
    expect(src).toContain("const to = (user.email ?? '').trim()")
    expect(src).toMatch(/sendEmail\(\{\s+locationId,\s+to,/)
    expect(src).not.toMatch(/body\.to|from\('partners'\)|partner_unsubscribe/)
  })
})

// ── the client senders, the client tags and the client test send are main's ──
import { createHash } from 'node:crypto'
import { withoutFooterIntent } from './footer-intent-footprint'
describe('client emails are untouched by slice 3 (fingerprint against origin/main f115e0ee)', () => {
  // The footer-intent edits (2026-11-22) taken back out, exactly (footer-intent-footprint.ts).
  const sha = (f: string) => createHash('sha256').update(withoutFooterIntent(f, readFileSync(join(process.cwd(), f), 'utf8'))).digest('hex').slice(0, 16)
  const MAIN: [string, string][] = [
    ['lib/drip-send.ts', 'abc8ee5ebb0319ef'],   // was a8a833d4e2fae092 until partner emails slice 4 (2026-11-22): its shareable parts moved to lib/drip-send-shared.ts for the partner sender. What it does is pinned byte for byte by OUTPUT instead: lib/network/client-drip-send-bytes.test.ts (44 scenarios — Resend payloads, every database call incl. the tracking writes, results — equal to af902cb and f115e0e)
    ['app/api/cron/send-drips/route.ts', '578c105a680e7a82'],
    ['app/api/emails/test-send/route.ts', 'b9a621dce5327f45'],
    ['lib/merge-tags.ts', '4740d372d4eecc71'],
    ['lib/resend.ts', '87416e6398e3e10c'],   // was 54a3332a2fa7fc36 until partner emails slice 4 (2026-11-22): ONE comment changed — the {{partner_name}} line no longer says it does nothing. No code changed (git diff af902cb -- lib/resend.ts)
    ['lib/marketing-consent.ts', '5f63f5b6bc50f8e2'],
    ['lib/welcome-email.ts', '54f7f0fe8ed1f1ca'],
    ['lib/stage-emails.ts', 'f599a27fb53be364'],
    ['lib/drip-lifecycle.ts', '925f6146f4b30a72'],
    ['lib/partner-merge-tags.ts', '16fa3436d6632bae'],
  ]
  for (const [f, h] of MAIN) it(`${f} is byte for byte main's`, () => expect(sha(f)).toBe(h))
})

describe('nothing in slice 3 can email a real partner', () => {
  const code = (f: string) => readFileSync(join(process.cwd(), f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  const NEW = ['app/api/emails/test-send-partner/route.ts', 'lib/network/partner-footer.ts', 'components/settings/EmailsScreen.jsx', 'components/settings/EmailBodyEditor.jsx']
  for (const f of NEW) it(`${f} reads no partner row and no partner address`, () => {
    expect(code(f)).not.toMatch(/from\(['"`]partners['"`]\)|partner_drip_progress|partner_unsubscribe_token|partner_unsubscribe_links/)
  })
  it('the only new code that sends is the test route, and it sends to the session user', () => {
    for (const f of NEW.slice(1)) expect(code(f), f).not.toMatch(/\bsendEmail\w*\s*\(|new\s+Resend\b|\.emails\.send\b/)
    expect(code('app/api/emails/test-send-partner/route.ts').match(/sendEmail\(/g)).toHaveLength(1)
  })
  it("BeeHub's slice 3 lines read no partner row and send nothing (only fetch our own routes)", async () => {
    const { PARTNER_EMAILS_SLICE3_HUB_PIECES } = await import('./partner-emails-hub-footprint')
    const added = PARTNER_EMAILS_SLICE3_HUB_PIECES.map(([now]) => now).join('\n')
    expect(added).not.toMatch(/from\(['"`]partners['"`]\)|partner_drip_progress|sendEmail|\/api\/partners/)
    const urls = Array.from(added.matchAll(/fetch\(([`'][^`']+[`'])/g)).map(m => m[1])
    expect(urls.sort()).toEqual(["'/api/drip-paths/masters'", "'/api/drip-paths/masters'", "'/api/drip-paths/masters?audience=partner'", "'/api/drip-paths/masters?audience=partner'", '`/api/locations/${realLocId}/drip-paths?audience=partner`', '`/api/locations/${realLocId}/drip-paths`'].sort())
  })
})
