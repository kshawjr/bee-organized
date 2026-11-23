// @vitest-environment node
//
// Partner emails, slice 4 (2026-11-22): THE CLIENT SENDER IS UNCHANGED, BY
// OUTPUT. lib/drip-send.ts gave its shareable parts to lib/drip-send-shared.ts
// so the partner sender runs the same code. This runs the REAL client sender
// (sendDripStepForRow / sendDripStep) through every branch it has — sent,
// held, skipped, stopped, every kind of refused send — with a recording fake
// database and a recording fake Resend, and fingerprints EVERYTHING it does:
//
//   · what Resend is handed (from, reply-to, to, subject, html, text)
//   · every database call, in order, with its arguments (the tracking writes
//     to the client drip table, the lead's status, the Timeline, the
//     notebook, the welcome schedule — and every read)
//   · what it returns
//
// The fingerprints below were produced by the code at af902cb (before this
// slice) and checked equal to f115e0e (main). One byte different fails.
// RECORD=<file> writes the full outputs (not just hashes) for a byte compare.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => {
  const state = { calls: [] as unknown[], sent: [] as unknown[], sc: null as any }
  const respond = (table: string, op: string, sel: string | null, chain: unknown[]): { data: unknown; error: unknown } => {
    const sc = state.sc
    if (sc.fail?.[table] && op === 'select') return { data: null, error: { message: `${table} read failed` } }
    if (op !== 'select') return { data: null, error: null }
    const single = chain.some((c: any) => c[0] === 'maybeSingle' || c[0] === 'single')
    const one = (row: unknown) => ({ data: single ? row : (row == null ? [] : [row]), error: null })
    switch (table) {
      case 'drip_path_steps':
        if (sel && sel.includes('templates:master_template_id')) return one(sc.step)
        if (sel === 'step_order, delay_days') return sc.nextStepError ? { data: null, error: { message: 'next lookup failed' } } : one(sc.nextStep ?? null)
        if (sel === 'delay_days') return one({ delay_days: sc.step?.delay_days ?? 0 })
        return one(null)
      case 'leads':
        return one(sc.lead)
      case 'locations':
        return one(sc.loc)
      case 'hub_users':
        return one(sc.hub)
      case 'lead_' + 'drip_progress':
        if (sel === 'consecutive_failures') return one({ consecutive_failures: sc.consecutiveFailures ?? 0 })
        return one(sc.dueRow ?? null)
      default:
        return one(null)
    }
  }
  const from = (table: string) => {
    const chain: unknown[] = []
    let op = 'select'
    let sel: string | null = null
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'in', 'not', 'lte', 'gte', 'lt', 'gt', 'order', 'limit', 'neq', 'or', 'filter']) {
      b[m] = (...args: unknown[]) => {
        chain.push([m, ...args])
        if (m === 'select' && op === 'select') sel = String(args[0])
        return b
      }
    }
    for (const m of ['update', 'insert', 'upsert', 'delete']) b[m] = (...args: unknown[]) => { op = m; chain.push([m, ...args]); return b }
    const finish = (how: string) => {
      chain.push([how])
      state.calls.push({ table, chain })
      return Promise.resolve(respond(table, op, sel, chain))
    }
    b.maybeSingle = () => finish('maybeSingle')
    b.single = () => finish('single')
    b.then = (res: any, rej: any) => finish('await').then(res, rej)
    return b
  }
  return { state, from }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: {
  from: (t: string) => h.from(t),
  rpc: (fn: string, args: unknown) => { h.state.calls.push({ rpc: fn, args }); return Promise.resolve({ data: null, error: null }) },
} }))
vi.mock('resend', () => ({ Resend: class { emails = { send: async (p: unknown) => { h.state.sent.push(p); return h.state.sc.resend ?? { data: { id: 're_1' }, error: null } } } } }))

import * as DripSend from '@/lib/drip-send'

const LOC = {
  id: 'loc-1', name: 'Kansas City', phone: '8165550100', city: 'Kansas City', state: 'MO', timezone: 'America/Chicago',
  lifecycle_status: 'active', rate_per_hour: '$95', reviews_link: 'https://g.page/r/x', calendar_link: 'https://cal.example/loc',
  sender_name: 'Bee Organized KC', send_from_email: 'kc@beeorganized.com', reply_to_email: 'kc@beeorganized.com',
  email_style: 'bold', discovery_booking_link: 'https://cal.example/disc', virtual_booking_link: 'https://cal.example/virt',
  drip_followups_off: false, website_url: 'https://kc.example', facebook_url: null, instagram_url: null, linkedin_url: null,
}
const LEAD = {
  id: 'lead-1', name: 'Jordan Smith', first_name: 'Jordan', email: ' jordan@example.com ', location_uuid: 'loc-1', assigned_to: null,
  marketing_opt_out: false, project_type: null, drip_last_send_status: null, drip_last_send_error: null, import_source: null, paid_amount: null,
}
const HUB = {
  id: 'u1', email: 'lyn@beeorganized.com', full_name: 'Lynette Ewy', phone: '8165550101', is_active: true, disabled_at: null,
  location_id: 'loc-1', booking_link: 'https://cal.example/lyn', signature_title: 'Owner', signature_photo_path: null, signature_linkedin_url: null,
}
const BODY = 'Hello {{first_name}},\n\nI am {{owner_name}} ({{owner_first_name}}) at {{location_name}}, {{service_area}}. Call {{phone}} or {{location_phone}}.\nBook HERE ({{book_assessment_link}}) or {{booking_link}} or {{owner_booking_link}}.\n\nRate {{rate_per_hour}}. Reviews {{reviews_link}}. {{location_owner_name}} {{organizer_name}} {{partner_name}}\n\nThank you,\n{{signature}}'
const STEP = (o: Record<string, unknown> = {}) => ({
  id: 's1', drip_path_id: 'p1', step_order: 1, delay_days: 0, channel: 'email', subject: 'Hi {{first_name}} & <friends>', body: BODY,
  body_format: 'plain', is_active: true, is_paused: false, button_text: null, button_link: null, button_align: null,
  master_template_id: null, templates: null, ...o,
})
const ROW = (o: Record<string, unknown> = {}) => ({
  id: 'ldp-1', lead_id: 'lead-1', drip_path_id: 'p1', current_step: 1, next_send_at: '2026-11-23T15:00:00+00:00',
  drip_paths: { id: 'p1', path_key: 'organizing-a', location_uuid: null }, ...o,
})

type Sc = { name: string; row?: any; step?: any; lead?: any; loc?: any; hub?: any; nextStep?: any; nextStepError?: boolean; resend?: any; consecutiveFailures?: number; fail?: Record<string, boolean>; byLead?: boolean; dueRow?: any }
const S = (name: string, o: Partial<Sc> = {}): Sc => ({ name, row: ROW(), step: STEP(), lead: LEAD, loc: LOC, hub: HUB, nextStep: { step_order: 2, delay_days: 5 }, ...o })

const SCENARIOS: Sc[] = [
  S('step1-sent-welcome'),
  S('step1-returning-no-welcome', { row: ROW({ drip_paths: { id: 'p1', path_key: 'returning-a', location_uuid: null } }) }),
  S('step2-sent-next', { row: ROW({ current_step: 2 }), step: STEP({ step_order: 2, delay_days: 5 }), nextStep: { step_order: 3, delay_days: 30 } }),
  S('step3-last-completed', { row: ROW({ current_step: 3 }), step: STEP({ step_order: 3, delay_days: 30 }), nextStep: null }),
  S('html-body', { step: STEP({ body: '<p>Hello {{first_name}} &amp; <strong>{{owner_name}}</strong></p><p>{{signature}}</p>', body_format: 'html' }) }),
  S('button-custom-left', { step: STEP({ button_text: 'Visit {{location_name}}', button_link: 'https://kc.example/?a=1&b=2', button_align: 'left' }) }),
  S('button-booking-tag', { step: STEP({ button_text: 'Book now', button_link: '{{discovery_booking_link}}' }) }),
  S('no-signature-tag', { step: STEP({ body: 'Hello {{first_name}},\n\nShort one.' }) }),
  S('assignee', { lead: { ...LEAD, assigned_to: 'u2' } }),
  S('project-type-sender', { lead: { ...LEAD, project_type: 'Moving' } }),
  S('linked-template', { step: STEP({ subject: null, body: null, master_template_id: 't1', templates: { id: 't1', subject: 'From the template, {{first_name}}', body: 'Template body {{location_name}}\n\n{{signature}}', body_format: 'plain' } }) }),
  S('step-overrides-template', { step: STEP({ master_template_id: 't1', templates: { id: 't1', subject: 'TEMPLATE subject', body: 'TEMPLATE body', body_format: 'html' } }) }),
  S('opted-out', { lead: { ...LEAD, marketing_opt_out: true } }),
  S('no-email', { lead: { ...LEAD, email: '   ' } }),
  S('non-email-channel', { step: STEP({ channel: 'sms' }) }),
  S('no-location', { lead: { ...LEAD, location_uuid: null } }),
  S('location-read-failed', { fail: { locations: true } }),
  S('location-not-active', { loc: { ...LOC, lifecycle_status: 'paused' } }),
  S('followups-off-step2', { row: ROW({ current_step: 2 }), step: STEP({ step_order: 2, delay_days: 5 }), loc: { ...LOC, drip_followups_off: true } }),
  S('followups-off-step1-stops-after', { loc: { ...LOC, drip_followups_off: true } }),
  S('step-removed', { row: ROW({ current_step: 2 }), step: STEP({ step_order: 2, delay_days: 5, is_active: false }) }),
  S('step-paused', { row: ROW({ current_step: 2 }), step: STEP({ step_order: 2, delay_days: 5, is_paused: true }) }),
  S('step1-paused-still-sends', { step: STEP({ is_paused: true }) }),
  S('missing-rate', { loc: { ...LOC, rate_per_hour: null } }),
  S('missing-booking-link', { loc: { ...LOC, calendar_link: null }, hub: { ...HUB, booking_link: null }, step: STEP({ body: 'Book ({{book_assessment_link}})' }) }),
  S('missing-subject', { step: STEP({ subject: '{{partner_name}}' }) }),
  S('no-body', { step: STEP({ body: null }) }),
  S('step-missing', { step: null }),
  S('sender-config-missing', { loc: { ...LOC, send_from_email: null } }),
  S('reply-to-broken-first', { loc: { ...LOC, reply_to_email: 'a@beeorganized.com, b@beeorganized.com' } }),
  S('reply-to-broken-repeat', { loc: { ...LOC, reply_to_email: 'a@beeorganized.com, b@beeorganized.com' }, lead: { ...LEAD, drip_last_send_error: 'LOCATION_REPLY_TO_PLACEHOLDER' } }),
  S('sender-domain-unlabelled', { resend: { data: null, error: { name: 'validation_error', message: 'The gmail.com domain is not verified. Please, add and verify your domain.', statusCode: 403 } } }),
  S('terminal-invalid-recipient', { resend: { data: null, error: { name: 'validation_error', message: 'Invalid `to` field.', statusCode: 422 } } }),
  S('transient-500', { resend: { data: null, error: { name: 'internal_server_error', message: 'boom', statusCode: 500 } } }),
  S('transient-cap-trip', { consecutiveFailures: 4, resend: { data: null, error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 } } }),
  S('resend-no-id', { resend: { data: {}, error: null } }),
  S('success-after-failure-resets', { lead: { ...LEAD, drip_last_send_status: 'failed' } }),
  S('next-step-lookup-error', { nextStepError: true }),
  S('phone-falls-back-to-owner', { loc: { ...LOC, phone: null } }),
  S('tz-label', { loc: { ...LOC, timezone: 'Central Time (CT)' }, row: ROW({ current_step: 2 }), step: STEP({ step_order: 2, delay_days: 5 }), nextStep: { step_order: 3, delay_days: 30 } }),
  S('style-classic-no-reviews', { loc: { ...LOC, email_style: 'classic', reviews_link: null } }),
  S('style-unset', { loc: { ...LOC, email_style: null } }),
  S('by-lead-due', { byLead: true, dueRow: ROW() }),
  S('by-lead-nothing-due', { byLead: true, dueRow: null }),
  // Slice 5: a step whose subject is BLANK TEXT ('' or spaces), not missing,
  // over a template that has one. The step's '' wins (??, not ||), so the
  // email is held for a blank subject; it never falls back to the template's.
  S('blank-step-subject-over-template', { step: STEP({ subject: '', master_template_id: 't1', templates: { id: 't1', subject: 'From the template, {{first_name}}', body: 'Template body', body_format: 'plain' } }) }),
  S('spaces-step-subject-over-template', { step: STEP({ subject: '   ', master_template_id: 't1', templates: { id: 't1', subject: 'From the template, {{first_name}}', body: 'Template body', body_format: 'plain' } }) }),
  S('blank-step-body-over-template', { step: STEP({ body: '', master_template_id: 't1', templates: { id: 't1', subject: 'T', body: 'Template body {{location_name}}', body_format: 'plain' } }) }),
]

async function runAll(): Promise<Record<string, string>> {
  const { LOCATION_REPLY_TO_BROKEN } = await import('@/lib/reply-to')
  const out: Record<string, string> = {}
  for (const sc0 of SCENARIOS) {
    const sc = sc0.name === 'reply-to-broken-repeat' ? { ...sc0, lead: { ...sc0.lead, drip_last_send_error: LOCATION_REPLY_TO_BROKEN } } : sc0
    h.state.sc = sc; h.state.calls = []; h.state.sent = []
    const result = sc.byLead ? await DripSend.sendDripStep('lead-1') : await DripSend.sendDripStepForRow(sc.row)
    out[sc.name] = JSON.stringify({ result, sent: h.state.sent, calls: h.state.calls })
  }
  return out
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// sha-256 (first 16 hex) of each scenario's full output, produced by the code
// at af902cb (and equal on f115e0e).
const BEFORE: Record<string, string> = {
  "step1-sent-welcome": "8f19d16e01151530",
  "step1-returning-no-welcome": "5a4b9e580ae814bf",
  "step2-sent-next": "83844170aa186d21",
  "step3-last-completed": "2f98f80cf901fa83",
  "html-body": "cd7c1e591420c385",
  "button-custom-left": "c3e342165f8d7317",
  "button-booking-tag": "26d96da628c73086",
  "no-signature-tag": "526d314dc0122c8e",
  "assignee": "5d2e2e4ff459d7f5",
  "project-type-sender": "52837c06a64dc1de",
  "linked-template": "538287db3031eb84",
  "step-overrides-template": "8f19d16e01151530",
  "opted-out": "65bb045e500c3117",
  "no-email": "4ef2af41c19ad1fe",
  "non-email-channel": "b8f714ebdc6915b4",
  "no-location": "7454848aa33e867d",
  "location-read-failed": "d7d9f0550d07a5f3",
  "location-not-active": "8fcea6c79008e556",
  "followups-off-step2": "d8167d0592a0ac20",
  "followups-off-step1-stops-after": "19e1b054ec79e2ad",
  "step-removed": "429feb1031e35939",
  "step-paused": "985ac21238188e93",
  "step1-paused-still-sends": "8f19d16e01151530",
  "missing-rate": "7a23b50e20e4455f",
  "missing-booking-link": "d7017648c465d9a0",
  "missing-subject": "65dc4a3de05be35b",
  "no-body": "9581f78121d3b02e",
  "step-missing": "05c005fd8bf28d64",
  "sender-config-missing": "f3906c79176bbd27",
  "reply-to-broken-first": "f4404c2cddafeb3d",
  "reply-to-broken-repeat": "f2e312627260913d",
  "sender-domain-unlabelled": "7a46b17fd7774988",
  "terminal-invalid-recipient": "38357c9a8abe94f1",
  "transient-500": "2f58c9bfab31ac74",
  "transient-cap-trip": "6ddff38c988839a3",
  "resend-no-id": "a106227948763cb1",
  "success-after-failure-resets": "e69978b9e39a8766",
  "next-step-lookup-error": "3ff7f2f9d4cf4046",
  "phone-falls-back-to-owner": "46d41060f3b8ffec",
  "tz-label": "83844170aa186d21",
  "style-classic-no-reviews": "c121f7cdaeba2a71",
  "style-unset": "8f19d16e01151530",
  "by-lead-due": "ed0c2df5a75dbfd2",
  "by-lead-nothing-due": "ce470d039a235b87",
  // Slice 5: recorded on af902cb, on f115e0e and on this code (all equal).
  "blank-step-subject-over-template": "65dc4a3de05be35b",
  "spaces-step-subject-over-template": "65dc4a3de05be35b",
  "blank-step-body-over-template": "9581f78121d3b02e",
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T15:30:00.000Z'))
  process.env.MARKETING_POSTAL_ADDRESS = '1 Hive Way, Kansas City, MO'
  process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
  process.env.RESEND_API_KEY = 're_test_placeholder'
})
afterAll(() => { vi.useRealTimers() })

describe('the client drip sender does exactly what it did before slice 4', () => {
  it('every scenario: what Resend is handed, every database call, the result', async () => {
    const all = await runAll()
    if (process.env.RECORD) {
      const fs = await import('node:fs')
      fs.writeFileSync(process.env.RECORD, JSON.stringify(all, null, 1))
      fs.writeFileSync(process.env.RECORD + '.hashes.json', JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, sha(v)])), null, 2))
      return
    }
    expect(Object.keys(all).length).toBe(SCENARIOS.length)
    expect(Object.keys(BEFORE).length).toBe(SCENARIOS.length)
    for (const [k, v] of Object.entries(all)) expect(sha(v), k).toBe(BEFORE[k])
  })
  it('the scenarios really send, hold and stop (the fake is not empty)', async () => {
    const all = await runAll()
    const sentCount = Object.values(all).filter(v => JSON.parse(v).sent.length > 0).length
    expect(sentCount).toBeGreaterThan(20)
    expect(JSON.parse(all['step1-sent-welcome']).sent[0].to).toBe('jordan@example.com')
    expect(JSON.parse(all['opted-out']).sent).toEqual([])
  })
})
