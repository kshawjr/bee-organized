// @vitest-environment node
//
// Partner emails, slice 4 (2026-11-22): THE PARTNER SENDER, its two button
// locks, the partway count and the cron. A fake database answers each read
// the way the real one would; Resend is faked (no email leaves). What is
// compared is the real output: what Resend was handed and what was written.
// (The same sender against a real Postgres copy, with the live slice 2
// migration's triggers, is the PGlite dry run in the slice 4 report.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  const st = {
    calls: [] as any[], sent: [] as any[], rpc: [] as any[],
    partner: null as any, loc: null as any, step: null as any, path: null as any, owner: null as any,
    nextStep: null as any, block: null as any, blockError: false, token: 'a'.repeat(64) as string | null,
    claimRows: 1, claimError: null as any, resend: null as any, hubUser: { id: 'u1', role: 'owner', location_id: 'loc-1' } as any,
    routeStep: null as any, counts: { lead: 2, partner: 3 } as any, due: [] as any[], overdue: [] as any[],
  }
  const from = (table: string) => {
    const chain: any[] = []
    let op = 'select'; let sel = ''; let opts: any = {}
    const b: any = {}
    for (const m of ['eq', 'is', 'in', 'not', 'lte', 'gte', 'lt', 'order', 'limit', 'neq']) b[m] = (...a: any[]) => { chain.push([m, ...a]); return b }
    b.select = (s: string, o?: any) => { chain.push(['select', s]); if (op === 'select') { sel = s; opts = o || {} } return b }
    for (const m of ['update', 'insert', 'upsert', 'delete']) b[m] = (a: any) => { op = m; chain.push([m, a]); return b }
    const respond = (): any => {
      st.calls.push({ table, op, chain })
      const single = (row: any) => ({ data: row, error: null })
      if (op === 'update' && table === 'partner_drip_progress') {
        if (chain.some((c) => c[0] === 'select')) return st.claimError ? { data: null, error: st.claimError } : { data: Array.from({ length: st.claimRows }, () => ({ id: 'pdp-1' })), error: null }
        return { data: null, error: null }
      }
      if (op !== 'select') return { data: null, error: null }
      const late = chain.some((c) => c[0] === 'lt')
      if (opts.head) return { count: table === 'partner_drip_progress' ? (late ? st.overdue.length : st.counts.partner) : st.counts.lead, data: null, error: null }
      switch (table) {
        case 'drip_paths': return single(st.path)
        case 'partners': return single(st.partner)
        case 'locations': return single(sel === '*' ? st.loc : st.loc)
        case 'drip_path_steps':
          if (sel.includes('templates:master_template_id')) return single(st.step)
          if (sel === 'step_order, delay_days') return single(st.nextStep)
          if (sel === 'delay_days') return single({ delay_days: st.step?.delay_days ?? 0 })
          if (sel.includes('drip_paths!inner')) return single(st.routeStep)
          return single(st.routeStep)
        case 'hub_users': return single(st.owner)
        case 'subscription_seats': return sel === 'location_id' ? { data: [], error: null } : single(null)
        case 'partner_drip_progress': return { data: late ? st.overdue.slice(0, 1) : st.due, error: null }
        default: return single(null)
      }
    }
    b.maybeSingle = () => Promise.resolve(respond())
    b.single = () => Promise.resolve(respond())
    b.then = (r: any, j: any) => Promise.resolve(respond()).then(r, j)
    return b
  }
  const rpc = async (fn: string, args: any) => {
    st.rpc.push([fn, args])
    if (fn === 'partner_send_block_reason') return st.blockError ? { data: null, error: { message: 'down' } } : { data: st.block, error: null }
    if (fn === 'partner_unsubscribe_token') return { data: st.token, error: null }
    return { data: null, error: null }
  }
  return { st, from, rpc }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t), rpc: (f: string, a: any) => h.rpc(f, a) } }))
vi.mock('resend', () => ({ Resend: class { emails = { send: async (p: any) => { h.st.sent.push(p); return h.st.resend ?? { data: { id: 're_1' }, error: null } } } } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: h.st.hubUser, error: null }); return b },
}) }))

import { sendPartnerDripStepForRow, runPartnerDripBatch } from './partner-drip-send'
import { NextRequest } from 'next/server'
import { PATCH as stepPATCH } from '@/app/api/drip-path-steps/[stepId]/route'
import { GET as countGET } from '@/app/api/drip-paths/[id]/active-lead-count/route'
import { GET as cronGET } from '@/app/api/cron/send-partner-emails/route'

const ROW = { id: 'pdp-1', partner_id: 'pa-1', drip_path_id: 'pp-1', path_key: 'partner-introduction', current_step: 1, status: 'active', next_send_at: '2026-11-23T15:00:00+00:00', last_sent_at: null }
const BODY500 = 'Hi {{partner_name}},\n\nIt was such a pleasure meeting you. {{location_owner_name}} at {{location_name}}, {{service_area}}.\n\nWarmly,\n{{signature}}'
const POSTAL = '1 Hive Way, Kansas City, MO 64105'

beforeEach(() => {
  Object.assign(h.st, {
    calls: [], sent: [], rpc: [], block: null, blockError: false, token: 'a'.repeat(64), claimRows: 1, claimError: null, resend: null,
    path: { id: 'pp-1', path_key: 'partner-introduction', location_uuid: null },
    partner: { id: 'pa-1', location_id: 'loc-1', name: 'Taylor Capen', first_name: 'Taylor', network_types: ['partner'], email: ' taylor@example.com ' },
    loc: { id: 'loc-1', name: 'Test Location', phone: '8165550100', city: 'Kansas City', state: 'MO', timezone: 'America/Chicago', lifecycle_status: 'active',
      rate_per_hour: '$95', reviews_link: null, sender_name: 'Bee Organized Test', send_from_email: 'test@beeorganized.com', reply_to_email: 'test@beeorganized.com',
      email_style: 'soft', calendar_link: 'https://cal.example/x', discovery_booking_link: 'https://cal.example/d', virtual_booking_link: 'https://cal.example/v' },
    step: { id: 's1', drip_path_id: 'pp-1', step_order: 1, delay_days: 0, channel: 'email', subject: 'Great to meet you', body: BODY500, body_format: 'plain',
      is_active: true, is_paused: false, button_text: null, button_link: null, button_align: null, templates: null },
    owner: { id: 'u-own', full_name: 'Lynette Ewy', email: 'lyn@beeorganized.com', phone: '1', is_active: true, disabled_at: null, location_id: 'loc-1' },
    nextStep: { step_order: 2, delay_days: 90 },
    hubUser: { id: 'u1', role: 'owner', location_id: 'loc-1' }, counts: { lead: 2, partner: 3 }, due: [], overdue: [],
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T15:30:00.000Z'))
  process.env.MARKETING_POSTAL_ADDRESS = POSTAL
  process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
  process.env.RESEND_API_KEY = 're_placeholder'
})

const progressWrites = () => h.st.calls.filter((c) => c.table === 'partner_drip_progress' && c.op === 'update').map((c) => c.chain)

describe('a partner email goes with its footer, signed by the owner, and moves the partner on', () => {
  it('500: to the partner, footer, owner, claim conditions', async () => {
    const r = await sendPartnerDripStepForRow(ROW)
    expect(r).toEqual({ sent: true, advanced_to_step: 2 })
    expect(h.st.sent).toHaveLength(1)
    const m = h.st.sent[0]
    expect([m.to, m.from, m.subject]).toEqual(['taylor@example.com', 'Bee Organized Test <test@beeorganized.com>', 'Great to meet you'])
    expect(m.text).toContain('\n\nHi Taylor,\n\nIt was such a pleasure meeting you. Lynette Ewy at Test Location, Kansas City, MO.\n\nWarmly,\nLynette Ewy\n')
    expect(m.text).toContain(`https://hub.test/unsubscribe/${'a'.repeat(64)}`)
    expect(m.text).toContain(POSTAL)
    expect(m.html).toContain(`https://hub.test/unsubscribe/${'a'.repeat(64)}`)
    expect(m.html).toContain(POSTAL)
    // The claim: one conditional update, before Resend was called.
    const claim = progressWrites()[0]
    expect(claim).toEqual([
      ['update', { current_step: 2, next_send_at: '2027-02-21T15:00:00.000Z', last_sent_at: '2026-11-23T15:30:00.000Z' }],
      ['eq', 'id', 'pdp-1'], ['eq', 'status', 'active'], ['eq', 'current_step', 1], ['eq', 'next_send_at', '2026-11-23T15:00:00+00:00'], ['select', 'id'],
    ])
    expect(h.st.rpc.filter((x) => x[0] === 'partner_send_block_reason')).toHaveLength(2) // asked twice
    // Never the client tracking table.
    expect(h.st.calls.some((c) => c.table === 'lead_' + 'drip_progress')).toBe(false)
  })
  it('the last email completes the sequence', async () => {
    h.st.nextStep = null
    expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: true, completed: true })
    expect(progressWrites()[0][0]).toEqual(['update', { status: 'completed', completed_at: '2026-11-23T15:30:00.000Z', next_send_at: null, last_sent_at: '2026-11-23T15:30:00.000Z' }])
  })
  it('another run already claimed it: nothing is sent', async () => {
    h.st.claimRows = 0
    expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: false, error: 'already_claimed' })
    expect(h.st.sent).toEqual([])
  })
  it('the database refuses the claim (partner may not be emailed): nothing is sent', async () => {
    h.st.claimError = { message: 'partner_cannot_receive: unsubscribed' }
    expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: false, error: 'blocked_by_database' })
    expect(h.st.sent).toEqual([])
  })
  it('no owner active at the location: the location signs and {{location_owner_name}} is blank', async () => {
    h.st.owner = { ...h.st.owner, location_id: 'loc-OTHER' }
    await sendPartnerDripStepForRow(ROW)
    const m = h.st.sent[0]
    expect(m.text).not.toContain('Lynette Ewy')
    expect(m.text).toContain('It was such a pleasure meeting you.  at Test Location')
    expect(m.text).toContain('Bee Organized Test Location')
  })
  it('a refused send hands the claim back (due again), a bad address stops it', async () => {
    h.st.resend = { data: null, error: { name: 'internal_server_error', message: 'down', statusCode: 500 } }
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('send: down')
    // Handed back ONLY if the row is still exactly as the claim left it
    // (slice 5): still active, on the claimed next step, due when the claim
    // said, with the claim's own time. A row Stop has touched matches none.
    expect(progressWrites()[1]).toEqual([
      ['update', { status: 'active', current_step: 1, completed_at: null, last_sent_at: null, next_send_at: '2026-11-23T15:30:00.000Z' }],
      ['eq', 'id', 'pdp-1'], ['eq', 'last_sent_at', '2026-11-23T15:30:00.000Z'],
      ['eq', 'status', 'active'], ['eq', 'current_step', 2], ['eq', 'next_send_at', '2027-02-21T15:00:00.000Z'],
    ])
    h.st.calls = []
    h.st.resend = { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.', statusCode: 422 } }
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('invalid_recipient')
    expect(progressWrites()[1][0][1]).toMatchObject({ status: 'stopped', stopped_reason: 'invalid_recipient', current_step: 1 })
    expect(progressWrites()[1].slice(1)).toEqual([['eq', 'id', 'pdp-1'], ['eq', 'last_sent_at', '2026-11-23T15:30:00.000Z'],
      ['eq', 'status', 'active'], ['eq', 'current_step', 2], ['eq', 'next_send_at', '2027-02-21T15:00:00.000Z']])
  })
  it('the last email: handed back only if still exactly completed by this claim', async () => {
    h.st.nextStep = null
    h.st.resend = { data: null, error: { name: 'internal_server_error', message: 'down', statusCode: 500 } }
    await sendPartnerDripStepForRow(ROW)
    expect(progressWrites()[1].slice(1)).toEqual([['eq', 'id', 'pdp-1'], ['eq', 'last_sent_at', '2026-11-23T15:30:00.000Z'],
      ['eq', 'status', 'completed'], ['eq', 'completed_at', '2026-11-23T15:30:00.000Z']])
  })
})

describe('a paused sequence sends nothing (the second lock, behind Start)', () => {
  it('the sequence is switched off: held, nothing sent, nothing claimed', async () => {
    h.st.path = { ...h.st.path, is_active: false }
    expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: false, error: 'sequence_paused' })
    expect([h.st.sent, progressWrites()]).toEqual([[], []])
    const pathRead = h.st.calls.find((c) => c.table === 'drip_paths')
    expect(pathRead.chain[0]).toEqual(['select', 'id, path_key, location_uuid, is_active'])
  })
  it('counted as held by the job, not failed', async () => {
    h.st.due = [ROW]; h.st.path = { ...h.st.path, is_active: false }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runPartnerDripBatch()).toMatchObject({ considered: 1, sent: 0, held: 1, failed: 0 })
  })
})

describe('the location and the step', () => {
  it('a location that is not active: held, nothing sent, nothing claimed', async () => {
    h.st.loc = { ...h.st.loc, lifecycle_status: 'paused' }
    expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: false, error: 'location_not_active' })
    expect([h.st.sent, progressWrites()]).toEqual([[], []])
  })
  it('a removed email is passed over (claimed, not sent)', async () => {
    h.st.step = { ...h.st.step, step_order: 2, is_active: false }
    h.st.nextStep = null
    expect(await sendPartnerDripStepForRow({ ...ROW, current_step: 2 })).toEqual({ sent: false, error: 'step_removed', completed: true })
    expect(h.st.sent).toEqual([])
    expect(progressWrites()[0][0][1]).toMatchObject({ status: 'completed' })
  })
})

describe('never to a partner who may not be emailed', () => {
  for (const reason of ['unsubscribed', 'address_unsubscribed', 'no_email', 'deleted', 'not_found']) {
    it(`${reason}: nothing sent, row stopped, reason logged`, async () => {
      h.st.block = reason
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: false, error: `blocked_${reason}` })
      expect(h.st.sent).toEqual([])
      expect(warn.mock.calls.some((c) => c[1]?.reason === reason)).toBe(true)
      warn.mockRestore()
      expect(progressWrites()).toHaveLength(1)
      expect(progressWrites()[0][0][1]).toMatchObject({ status: 'stopped', stopped_reason: `blocked_${reason}` })
    })
  }
  it('the check itself failed: nothing sent, row left for the next run', async () => {
    h.st.blockError = true
    expect(await sendPartnerDripStepForRow(ROW)).toEqual({ sent: false, error: 'blocked_check_failed' })
    expect(h.st.sent).toEqual([])
    expect(progressWrites()).toEqual([])
  })
  it('the partner row is gone: nothing sent', async () => {
    h.st.partner = null
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('blocked_not_found')
    expect(h.st.sent).toEqual([])
  })
  it('not a partner sequence: refused', async () => {
    h.st.path = { ...h.st.path, path_key: 'organizing-a' }
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('not_a_partner_sequence')
    expect(h.st.sent).toEqual([])
  })
  it("another location's copy: refused", async () => {
    h.st.path = { ...h.st.path, location_uuid: 'loc-OTHER' }
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('wrong_location')
    expect(h.st.sent).toEqual([])
  })
})

describe('no partner email leaves without its footer', () => {
  it('no postal address: held, nothing claimed', async () => {
    process.env.MARKETING_POSTAL_ADDRESS = '  '
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('no_postal_address')
    expect([h.st.sent, progressWrites()]).toEqual([[], []])
  })
  it('no unsubscribe key: held, nothing claimed', async () => {
    h.st.token = null
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('no_unsubscribe_link')
    expect([h.st.sent, progressWrites()]).toEqual([[], []])
  })
  it('no app address for the link: held', async () => {
    process.env.NEXT_PUBLIC_APP_URL = ''
    process.env.NEXT_PUBLIC_SITE_URL = ''
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('no_app_url')
    expect(h.st.sent).toEqual([])
  })
})

describe('a client booking link on a partner email: refused at send', () => {
  for (const link of ['{{discovery_booking_link}}', '{{book_assessment_link}}', '{{virtual_booking_link}}']) {
    it(`button ${link}`, async () => {
      h.st.step = { ...h.st.step, button_text: 'Book', button_link: link }
      expect((await sendPartnerDripStepForRow(ROW)).error).toBe('client_booking_button')
      expect([h.st.sent, progressWrites()]).toEqual([[], []])
    })
  }
  it('in the wording', async () => {
    h.st.step = { ...h.st.step, body: 'Book here ({{discovery_booking_link}})' }
    expect((await sendPartnerDripStepForRow(ROW)).error).toBe('client_booking_tag')
    expect(h.st.sent).toEqual([])
  })
  it('a Custom button goes', async () => {
    h.st.step = { ...h.st.step, button_text: 'Our site', button_link: 'https://kc.example/p' }
    expect((await sendPartnerDripStepForRow(ROW)).sent).toBe(true)
    expect(h.st.sent[0].html).toContain('https://kc.example/p')
  })
})

describe('…and refused at save', () => {
  const patch = (body: any) => stepPATCH(new NextRequest('http://x', { method: 'PATCH', body: JSON.stringify(body) }), { params: { stepId: 's1' } })
  const partnerStep = { id: 's1', drip_path_id: 'pp-1', channel: 'email', master_template_id: null, drip_paths: { id: 'pp-1', is_master: false, location_uuid: 'loc-1', path_key: 'partner-introduction' } }
  for (const link of ['{{discovery_booking_link}}', '{{book_assessment_link}}', '{{virtual_booking_link}}', '{{booking_link}}', '{{owner_booking_link}}']) {
    it(`partner email, button ${link}: 400, nothing written`, async () => {
      h.st.routeStep = partnerStep
      const res = await patch({ subject: 'Hi', body: 'Hello', button_text: 'Book', button_link: link })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('partner_client_booking_link')
      expect(h.st.calls.filter((c) => c.op === 'update')).toEqual([])
    })
  }
  it('partner email, a booking tag in the body: 400', async () => {
    h.st.routeStep = partnerStep
    expect((await patch({ body: 'Book ({{virtual_booking_link}})' })).status).toBe(400)
  })
  it('partner email, a Custom button saves', async () => {
    h.st.routeStep = partnerStep
    const res = await patch({ subject: 'Hi', body: 'Hello', button_text: 'Our site', button_link: 'https://kc.example/p' })
    expect(res.status).toBe(200)
    expect(h.st.calls.filter((c) => c.op === 'update')[0].chain[0][1]).toMatchObject({ button_link: 'https://kc.example/p' })
  })
  it('a CLIENT email keeps its booking-link button', async () => {
    h.st.routeStep = { ...partnerStep, drip_paths: { ...partnerStep.drip_paths, path_key: 'organizing-a' } }
    const res = await patch({ subject: 'Hi', body: 'Hello', button_text: 'Book', button_link: '{{discovery_booking_link}}' })
    expect(res.status).toBe(200)
  })
})

describe('the "partway through" count', () => {
  const count = async () => (await countGET(new NextRequest('http://x'), { params: { id: 'pp-1' } })).json()
  it('a partner sequence counts its active partners too', async () => {
    h.st.path = { id: 'pp-1', location_uuid: 'loc-1', is_master: false, path_key: 'partner-introduction' }
    expect(await count()).toEqual({ count: 5 })
    const partnerQ = h.st.calls.find((c) => c.table === 'partner_drip_progress')
    expect(partnerQ.chain).toEqual([['select', 'id'], ['eq', 'drip_path_id', 'pp-1'], ['eq', 'status', 'active']])
  })
  it('a client sequence counts exactly as before, with no partner read', async () => {
    h.st.path = { id: 'pp-1', location_uuid: 'loc-1', is_master: false, path_key: 'organizing-a' }
    expect(await count()).toEqual({ count: 2 })
    expect(h.st.calls.some((c) => c.table === 'partner_drip_progress')).toBe(false)
  })
})

describe('the cron', () => {
  it('refuses without the secret, with a WRONG secret, and with no secret set', async () => {
    process.env.CRON_SECRET = 'cs'
    expect((await cronGET(new NextRequest('http://x/api/cron/send-partner-emails'))).status).toBe(401)
    // A wrong password, by header and by ?secret= — a check that took any
    // non-empty password would let these through.
    for (const bad of [{ headers: { authorization: 'Bearer wrong' } }, { headers: { authorization: 'Bearer c' } }, { headers: { authorization: 'cs' } }]) {
      expect((await cronGET(new NextRequest('http://x/api/cron/send-partner-emails', bad))).status).toBe(401)
    }
    expect((await cronGET(new NextRequest('http://x/api/cron/send-partner-emails?secret=wrong'))).status).toBe(401)
    expect((await cronGET(new NextRequest('http://x/api/cron/send-partner-emails?secret=cs'))).status).toBe(200)
    expect(h.st.sent).toEqual([])
    delete process.env.CRON_SECRET
    expect((await cronGET(new NextRequest('http://x/api/cron/send-partner-emails'))).status).toBe(500)
  })
  it('sends what is due, capped, and writes its line', async () => {
    process.env.CRON_SECRET = 'cs'
    h.st.due = [ROW]
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await cronGET(new NextRequest('http://x/api/cron/send-partner-emails', { headers: { authorization: 'Bearer cs' } }))
    expect((await res.json()).partners).toEqual({ sent: 1, skipped: 0, held: 0, failed: 0, considered: 1 })
    expect(log.mock.calls.map((c) => c[0])).toContain('[cron send-partner-emails] 1 sent / 0 skipped / 0 held / 0 failed of 1')
    expect(log.mock.calls.map((c) => c[0])).toContain('[cron send-partner-emails] 0 overdue')
    log.mockRestore()
    const due = h.st.calls.find((c) => c.table === 'partner_drip_progress' && c.op === 'select')
    expect(due.chain).toContainEqual(['limit', 100])
    expect(due.chain).toContainEqual(['eq', 'status', 'active'])
  })
  it('is its own route: the client cron is not touched by this slice', () => {
    expect(readFileSync('app/api/cron/send-drips/route.ts', 'utf8')).not.toMatch(/partner/i)
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons.map((c: any) => [c.path, c.schedule])
    expect(crons).toContainEqual(['/api/cron/send-partner-emails', '30 * * * *'])
    expect(crons).toContainEqual(['/api/cron/send-drips', '0 * * * *'])
  })
})

describe('stuck sequences are not silent', () => {
  it('a HELD email (no postal address) that is past due shows in the overdue line and the answer', async () => {
    process.env.CRON_SECRET = 'cs'
    const late = { ...ROW, next_send_at: '2026-11-23T10:00:00+00:00' } // 5h30 late
    h.st.due = [late]; h.st.overdue = [late]
    process.env.MARKETING_POSTAL_ADDRESS = ''
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const res = await cronGET(new NextRequest('http://x/api/cron/send-partner-emails', { headers: { authorization: 'Bearer cs' } }))
    const j = await res.json()
    expect(j.partners).toMatchObject({ held: 1, sent: 0 })
    expect(j.overdue).toEqual({ count: 1, oldestDue: '2026-11-23T10:00:00+00:00', marginHours: 2 })
    expect(log.mock.calls.map((c) => c[0])).toContain('[cron send-partner-emails] 1 overdue (oldest due 2026-11-23T10:00:00+00:00)')
    log.mockRestore()
    // The count asks by next_send_at alone: active and more than 2 hours late.
    const q = h.st.calls.filter((c) => c.table === 'partner_drip_progress' && c.chain.some((x: any[]) => x[0] === 'lt'))
    expect(q).toHaveLength(2)
    for (const c of q) expect(c.chain).toContainEqual(['lt', 'next_send_at', '2026-11-23T13:30:00.000Z'])
    for (const c of q) expect(c.chain).toContainEqual(['eq', 'status', 'active'])
  })
})

describe('runPartnerDripBatch', () => {
  it('counts a blocked partner as skipped, not failed', async () => {
    h.st.due = [ROW]; h.st.block = 'unsubscribed'
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await runPartnerDripBatch()).toMatchObject({ considered: 1, sent: 0, skipped: 1, failed: 0 })
  })
})
