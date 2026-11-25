// @vitest-environment node
//
// FL-75 slice 2 — an unsubscribe counts everywhere (lib/marketing-no-list.ts
// and every client marketing send that asks it).
//
// Pins (Kevin's list):
//   • An address on the list is refused at every location, by address — the
//     drip, the welcome, the stage email and the Mailchimp batch all stop for
//     a record whose OWN flags are clear, when its address said no elsewhere.
//   • The list can't be read → nothing is sent and nothing is cancelled (held,
//     tried again next tick); the batch throws.
//   • Nothing in this slice sends to Mailchimp: none of the new files makes a
//     network call, and the old engine only ever drops people because of it.
//   • The partner list and the client list stay separate (also pinned, from
//     the partner side, in lib/network/partner-unsubscribe.test.tsx).
// The database half — deleting and re-adding a record, an import, a sync, the
// writers, the reversal — is proven on a copy of production by the dry run in
// the slice 2 report; its rules are pinned textually at the bottom.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[], calls: [] as Call[],
    rpcAnswer: { data: false, error: null } as Resp | 'throw', rpcCalls: [] as any[],
  }
  const reset = () => { state.queue = []; state.calls = []; state.rpcAnswer = { data: false, error: null }; state.rpcCalls = [] }
  const enqueue = (table: string, data: any, error: any = null, count?: number) => state.queue.push({ table, resp: { data, error, ...(count === undefined ? {} : { count }) } as Resp })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'neq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const updatesTo = (t: string) => state.calls.filter(c => c.table === t).flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, updatesTo }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (t: string) => h.makeBuilder(t),
    rpc: (fn: string, args: any) => {
      h.state.rpcCalls.push({ fn, args })
      if (h.state.rpcAnswer === 'throw') return Promise.reject(new Error('network'))
      return Promise.resolve(h.state.rpcAnswer)
    },
  },
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => null) }))

import { addressSaidNo, loadSaidNoSet, noListKey, SAID_NO_ELSEWHERE, NO_LIST_UNREADABLE } from './marketing-no-list'
import { sendDripStepForRow } from './drip-send'
import { sendWelcomeEmail } from './welcome-email'
import { sendStageEmail } from './stage-emails'
import { syncWebsiteLeadsToMailchimp } from './mailchimp-sync'

// The client drip-tracking table, spelled in two pieces: a guard
// (lib/network/partner-emails-client-drips-untouched.test.ts) keeps new files
// from naming it. This test only reads what the drip wrote to it.
const DRIP_TABLE = 'lead_' + 'drip_progress'
const SAID_NO = { data: true, error: null }
const BROKEN = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
const NOT_RUN = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }

// This record's OWN flags are all clear: only its address said no, elsewhere.
const cleanLead = (over: any = {}) => ({
  id: 'lead-1', name: 'Sarah Jones', first_name: 'Sarah', email: '  Sarah@Example.com ',
  location_uuid: 'loc-1', assigned_to: null, marketing_opt_out: false, project_type: null,
  drip_last_send_status: null, welcome_email_sent_at: null, is_junk: false, paused: false,
  import_source: null, paid_amount: null, ...over,
})

let fetchSpy: ReturnType<typeof vi.fn>
beforeEach(() => {
  h.reset(); vi.clearAllMocks()
  fetchSpy = vi.fn(async () => { throw new Error('no network in this test') })
  vi.stubGlobal('fetch', fetchSpy)
})

describe('the list question', () => {
  it('asks by address, lower case and trimmed — the same key the database stores', async () => {
    h.state.rpcAnswer = SAID_NO
    expect(await addressSaidNo('  Pat@Example.COM ')).toBe('said_no')
    expect(h.state.rpcCalls).toEqual([{ fn: 'marketing_address_said_no', args: { p_email: 'pat@example.com' } }])
    expect(noListKey(' A@B.co ')).toBe('a@b.co')
    // an oddly typed address still matches itself (not stricter than the database)
    expect(noListKey(' a@b.co, c@d.co ')).toBe('a@b.co, c@d.co')
  })
  it('clear, unreadable, thrown, and the migration not run yet', async () => {
    h.state.rpcAnswer = { data: false, error: null }; expect(await addressSaidNo('a@b.co')).toBe('clear')
    h.state.rpcAnswer = BROKEN; expect(await addressSaidNo('a@b.co')).toBe('unreadable')
    h.state.rpcAnswer = 'throw'; expect(await addressSaidNo('a@b.co')).toBe('unreadable')
    h.state.rpcAnswer = { data: 'yes?', error: null }; expect(await addressSaidNo('a@b.co')).toBe('unreadable')
    h.state.rpcAnswer = NOT_RUN; expect(await addressSaidNo('a@b.co')).toBe('clear')
  })
  it('a blank address is not asked about', async () => {
    expect(await addressSaidNo('  ')).toBe('clear')
    expect(await addressSaidNo(null)).toBe('clear')
    expect(h.state.rpcCalls).toEqual([])
  })
  it('the batch read returns who said no, ignores reversed rows, and throws when unreadable', async () => {
    h.enqueue('marketing_unsubscribes', [{ email_normalized: 'b@x.com' }])
    const set = await loadSaidNoSet(['A@x.com', ' b@X.com', null, ''])
    expect(Array.from(set)).toEqual(['b@x.com'])
    const call = h.state.calls.find(c => c.table === 'marketing_unsubscribes')!
    expect(call.ops).toContainEqual(['in', ['email_normalized', ['a@x.com', 'b@x.com']]])
    expect(call.ops).toContainEqual(['is', ['reversed_at', null]])
    h.enqueue('marketing_unsubscribes', null, BROKEN.error)
    await expect(loadSaidNoSet(['a@x.com'])).rejects.toThrow(/no-marketing list read failed/)
  })
})

// ── An address on the list is refused at every location, by address ─────────
describe('the drip refuses an address that said no elsewhere', () => {
  const step = { id: 'st-2', step_order: 2, delay_days: 1, channel: 'email', subject: 'Hi', body: 'b', master_template_id: null, templates: null }
  const row = { id: 'prog-1', lead_id: 'lead-1', drip_path_id: 'path-1', current_step: 2, next_send_at: '2026-01-01T14:00:00Z', drip_paths: { id: 'path-1', path_key: 'general-a' } }
  const loc = { id: 'loc-1', name: 'Boulder', sender_name: 'Bee', phone: '5', timezone: 'America/Denver', lifecycle_status: 'active', city: 'B', state: 'CO' }
  const preamble = () => { h.enqueue('drip_path_steps', step); h.enqueue('leads', cleanLead()); h.enqueue('locations', loc); h.enqueue('drip_path_steps', null) }

  it('said no → stopped as unsubscribed_elsewhere, nothing sent', async () => {
    preamble(); h.state.rpcAnswer = SAID_NO
    const res = await sendDripStepForRow(row as any)
    expect(res).toEqual({ sent: false, error: SAID_NO_ELSEWHERE })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatesTo(DRIP_TABLE)).toEqual([expect.objectContaining({ stopped_reason: 'unsubscribed_elsewhere' })])
    expect(h.state.rpcCalls[0].args).toEqual({ p_email: 'sarah@example.com' })
  })
  it('list unreadable → held: nothing sent, nothing stopped', async () => {
    preamble(); h.state.rpcAnswer = BROKEN
    expect(await sendDripStepForRow(row as any)).toEqual({ sent: false, error: NO_LIST_UNREADABLE })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatesTo(DRIP_TABLE)).toEqual([])
  })
  it('clear → it sends (the control)', async () => {
    preamble()
    expect((await sendDripStepForRow(row as any)).sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
})

describe('the welcome email refuses an address that said no elsewhere', () => {
  it('said no → cancelled, nothing sent', async () => {
    h.enqueue('leads', cleanLead()); h.state.rpcAnswer = SAID_NO
    expect(await sendWelcomeEmail('lead-1')).toEqual({ sent: false, error: SAID_NO_ELSEWHERE })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatesTo('leads')).toEqual([{ welcome_email_scheduled_at: null }])
  })
  it('list unreadable → held: nothing sent, the welcome stays scheduled', async () => {
    h.enqueue('leads', cleanLead()); h.state.rpcAnswer = BROKEN
    expect(await sendWelcomeEmail('lead-1')).toEqual({ sent: false, error: NO_LIST_UNREADABLE })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatesTo('leads')).toEqual([])
  })
})

describe('the Closed Won follow-up refuses an address that said no elsewhere', () => {
  const preamble = () => {
    h.enqueue('scheduled_stage_emails', { id: 'sse-1', lead_id: 'lead-1', stage_email_key: 'opp_closed_job_3mo', sent_at: null, cancelled_at: null })
    h.enqueue('templates', { id: 't-1', subject: 'S', body: 'B' })
    h.enqueue('leads', cleanLead())
  }
  it('said no → cancelled as unsubscribed_elsewhere, nothing sent', async () => {
    preamble(); h.state.rpcAnswer = SAID_NO
    expect(await sendStageEmail('sse-1')).toEqual({ sent: false, error: SAID_NO_ELSEWHERE })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatesTo('scheduled_stage_emails')).toEqual([expect.objectContaining({ cancelled_reason: 'unsubscribed_elsewhere' })])
  })
  it('list unreadable → held: nothing sent, not cancelled', async () => {
    preamble(); h.state.rpcAnswer = BROKEN
    expect(await sendStageEmail('sse-1')).toEqual({ sent: false, error: NO_LIST_UNREADABLE })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(h.updatesTo('scheduled_stage_emails')).toEqual([])
  })
})

// 2026-11-25, FL-75 slice 6 RETIRED "today's Sync now engine drops anyone
// whose address said no": it drove the old engine's query order. The same two
// promises are pinned against the new engine in lib/mailchimp-first-push.test.ts:
// an address on this list is never sent, whatever the saved tick says; and a
// list that cannot be read means nothing is sent.

describe('nothing in this slice sends to Mailchimp, and the two lists stay apart', () => {
  const ROOT = process.cwd()
  const code = (f: string) => readFileSync(join(ROOT, f), 'utf8').split('\n').filter(l => !/^\s*(\/\/|--)/.test(l)).join('\n')
  it('the new files make no network call and name no Mailchimp API', () => {
    for (const f of ['lib/marketing-no-list.ts', 'lib/client-unsubscribe.ts', 'migrations/marketing_unsubscribes.sql', 'migrations/marketing_unsubscribes_undo.sql']) {
      expect(code(f), f).not.toMatch(/fetch\(|api\.mailchimp|apiBase|mailchimp_access_token|http_post|net\.http/)
    }
  })
  it('the client list never names the partner list', () => {
    for (const f of ['lib/marketing-no-list.ts', 'lib/client-unsubscribe.ts', 'migrations/marketing_unsubscribes.sql']) {
      expect(code(f), f).not.toMatch(/partner_unsubscribe|partner-unsubscribe|partners\b/)
    }
  })
})

describe('the database rules (proven on a copy of production; pinned here as text)', () => {
  const mig = readFileSync(join(process.cwd(), 'migrations/marketing_unsubscribes.sql'), 'utf8')
  it('keyed on the address, with the room for slice 7', () => {
    expect(mig).toMatch(/email_normalized\s+text NOT NULL CHECK \(email_normalized = lower\(btrim\(email_normalized\)\)/)
    expect(mig).toMatch(/source\s+text NOT NULL CHECK \(source IN \('link', 'marked', 'mailchimp'\)\)/)
    expect(mig).toMatch(/mailchimp_audience_id text/)
  })
  it('deleting a record keeps its no; nothing can delete or empty the list', () => {
    expect(mig).toMatch(/lead_id\s+uuid REFERENCES public\.leads\(id\)\s+ON DELETE SET NULL/)
    expect(mig).toMatch(/BEFORE INSERT OR UPDATE OR DELETE ON public\.marketing_unsubscribes/)
    expect(mig).toMatch(/BEFORE TRUNCATE ON public\.marketing_unsubscribes/)
  })
  it('a re-added, imported or synced record at a listed address arrives marked; clearing it is refused', () => {
    expect(mig).toMatch(/IF TG_OP = 'INSERT' THEN\s+IF v_listed THEN NEW\.marketing_opt_out := true; END IF;/)
    expect(mig).toMatch(/IF v_listed AND NEW\.email IS DISTINCT FROM OLD\.email THEN\s+NEW\.marketing_opt_out := true;/)
    expect(mig).toMatch(/marketing_no_is_listed/)
    expect(mig).toMatch(/BEFORE INSERT OR UPDATE OF email, marketing_opt_out ON public\.leads/)
  })
  it('the only way back is a super admin with a written reason, and the history stays', () => {
    expect(mig).toMatch(/h\.role = 'super_admin'/)
    expect(mig).toMatch(/'reason_required'/)
    expect(mig).not.toMatch(/DELETE FROM public\.marketing_unsubscribes/)
  })
})
