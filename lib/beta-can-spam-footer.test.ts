// @vitest-environment node
//
// #115 — the CAN-SPAM footer wired onto the three COMMERCIAL emails.
//
// This suite pins the whole contract the scout + brief laid out:
//   • the footer builder carries an ACCURATE, audience-specific "why you're
//     getting this" line (an inaccurate one is a deceptive-header violation);
//   • appendCanSpamFooter FAILS CLOSED — a null token or a missing postal
//     address refuses the send rather than shipping a non-compliant email;
//   • the commercial rails (welcome, opp_closed_job_3mo/12mo) attach the footer
//     with an absolute, token-bearing unsubscribe URL and the postal address;
//   • the transactional emails (the four estimate follow-ups, the drip steps)
//     get NO footer and are unchanged;
//   • the consent gate marketingSendBlockReason is NOT used on these paths
//     (that's enforced structurally in beta-drip-canspam-tripwire.test.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── supabaseService mock: per-table FIFO response queue (same shape as
//    lib/email-send-integrity.test.ts). Serves both the rail lookups and
//    ensureUnsubscribeToken's leads read/write.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  // Pass the body through so bodyToHtml / the branded wrapper operate on real text.
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? 's', body: tpl.body ?? 'b' })),
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => ({ id: 'own-1', full_name: 'Olive Owner', phone: '555' })),
}))

import { appendCanSpamFooter } from '@/lib/marketing-unsubscribe'
import { buildMarketingFooter } from '@/lib/marketing-consent'
import { sendWelcomeEmail } from '@/lib/welcome-email'
import { sendStageEmail, renderStageEmailContent } from '@/lib/stage-emails'
import { buildBrandedDripHtml } from '@/lib/drip-email-layout'

// ── env: the footer needs a postal address + an absolute app origin. Pin both;
//    restore whatever the runner had afterward.
const APP_ORIGIN = 'https://beehive.beeorganized.com'
const POSTAL = '123 Hive Lane, Suite 4, Omaha, NE 68102'
const savedEnv = {
  postal: process.env.MARKETING_POSTAL_ADDRESS,
  app: process.env.NEXT_PUBLIC_APP_URL,
  site: process.env.NEXT_PUBLIC_SITE_URL,
}
beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.MARKETING_POSTAL_ADDRESS = POSTAL
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN
  delete process.env.NEXT_PUBLIC_SITE_URL
})
afterEach(() => {
  savedEnv.postal === undefined ? delete process.env.MARKETING_POSTAL_ADDRESS : (process.env.MARKETING_POSTAL_ADDRESS = savedEnv.postal)
  savedEnv.app === undefined ? delete process.env.NEXT_PUBLIC_APP_URL : (process.env.NEXT_PUBLIC_APP_URL = savedEnv.app)
  savedEnv.site === undefined ? delete process.env.NEXT_PUBLIC_SITE_URL : (process.env.NEXT_PUBLIC_SITE_URL = savedEnv.site)
})

// ── helpers ────────────────────────────────────────────
const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const updatePayloads = (table: string) =>
  callsFor(table).flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))

const baseLead = (over: any = {}) => ({
  id: 'lead-1',
  name: 'Sarah Mitchell',
  first_name: 'Sarah',
  email: 'sarah@email.com',
  location_uuid: 'loc-uuid-1',
  assigned_to: null,
  is_junk: false,
  paused: false,
  marketing_opt_out: false,
  welcome_email_sent_at: null,
  ...over,
})

const LOC = {
  id: 'loc-uuid-1', name: 'Boulder', sender_name: 'Bee Boulder', phone: '(303) 555-0147',
  calendar_link: null, reviews_link: null, rate_per_hour: null,
  city: 'Boulder', state: 'CO', timezone: 'America/Denver',
}

// Apostrophe-free substrings so the same needle matches BOTH the plain text and
// the HTML (where buildMarketingFooter escapes "you're" → "you&#39;re").
const INQUIRY_REASON = 'inquired about Bee Organized'
const CLIENT_REASON = 'a Bee Organized client'

// ═══ 1. buildMarketingFooter — accurate, audience-specific reason line ═══════
describe('buildMarketingFooter — audience reason line (compliance, not style)', () => {
  const url = `${APP_ORIGIN}/unsubscribe/tok`
  it('inquiry audience → "inquired about" line, in html AND text', () => {
    const { html, text } = buildMarketingFooter({ unsubscribeUrl: url, postalAddress: POSTAL, audience: 'inquiry' })
    expect(html).toContain(INQUIRY_REASON)
    expect(text).toContain(INQUIRY_REASON)
    expect(html).not.toContain('mailing list')
    expect(text).not.toContain('mailing list')
  })
  it('client audience → "you\'re a Bee Organized client" line, in html AND text', () => {
    const { html, text } = buildMarketingFooter({ unsubscribeUrl: url, postalAddress: POSTAL, audience: 'client' })
    expect(html).toContain(CLIENT_REASON)
    expect(text).toContain(CLIENT_REASON)
    expect(html).not.toContain('mailing list')
  })
  it('default / mailing_list audience keeps the original mailing-list line (future genuine sends)', () => {
    expect(buildMarketingFooter({ unsubscribeUrl: url }).text).toContain('joined the Bee Organized mailing list')
    expect(buildMarketingFooter({ unsubscribeUrl: url, audience: 'mailing_list' }).html).toContain('joined the Bee Organized mailing list')
  })
})

// ═══ 2. appendCanSpamFooter — the rail seam, incl. fail-closed ══════════════
describe('appendCanSpamFooter — attaches a compliant footer, fails closed', () => {
  it('inquiry: appends footer to BOTH bodies, absolute token-bearing URL + postal, keeps original content', async () => {
    h.enqueue('leads', { unsubscribe_token: 'tok-abc' })
    const res = await appendCanSpamFooter('<p>Hi</p>', 'Hi', { leadId: 'lead-1', audience: 'inquiry' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.html.startsWith('<p>Hi</p>')).toBe(true)   // original preserved, footer appended
    expect(res.html).toContain(`${APP_ORIGIN}/unsubscribe/tok-abc`)
    expect(res.html).toContain(INQUIRY_REASON)
    expect(res.html).toContain(POSTAL)
    expect(res.text).toContain(`${APP_ORIGIN}/unsubscribe/tok-abc`)
    expect(res.text).toContain(INQUIRY_REASON)
    expect(res.text).toContain(POSTAL)
  })

  it('client audience carries the client reason line', async () => {
    h.enqueue('leads', { unsubscribe_token: 'tok-xyz' })
    const res = await appendCanSpamFooter('<p>Hi</p>', 'Hi', { leadId: 'lead-1', audience: 'client' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.html).toContain(CLIENT_REASON)
  })

  it('FAILS CLOSED when MARKETING_POSTAL_ADDRESS is unset — refuses before touching the DB', async () => {
    delete process.env.MARKETING_POSTAL_ADDRESS
    const res = await appendCanSpamFooter('<p>Hi</p>', 'Hi', { leadId: 'lead-1', audience: 'inquiry' })
    expect(res).toEqual({ ok: false, reason: 'no_postal_address' })
    expect(callsFor('leads')).toHaveLength(0)   // no token mint attempted
  })

  it('FAILS CLOSED when no unsubscribe token can be minted (read error)', async () => {
    h.enqueue('leads', null, { message: 'column leads.unsubscribe_token does not exist', code: '42703' })
    const res = await appendCanSpamFooter('<p>Hi</p>', 'Hi', { leadId: 'lead-1', audience: 'inquiry' })
    expect(res).toEqual({ ok: false, reason: 'no_token' })
  })
})

// ═══ 3. welcome rail — commercial, carries the footer, fails closed ═════════
describe('sendWelcomeEmail — commercial, carries the CAN-SPAM footer', () => {
  const enqueueWelcomeLookups = () => {
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)
    h.enqueue('templates', { subject: 'Welcome', body: 'Welcome to the hive' })
  }

  it('footer present in html AND text, inquiry reason, absolute token-bearing URL + postal', async () => {
    enqueueWelcomeLookups()
    h.enqueue('leads', { unsubscribe_token: 'tok-welcome' })   // ensureUnsubscribeToken read
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: true })
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailMock.mock.calls[0][0] as any
    for (const body of [arg.html, arg.text]) {
      expect(body).toContain(INQUIRY_REASON)
      expect(body).toContain(`${APP_ORIGIN}/unsubscribe/tok-welcome`)
      expect(body).toContain(POSTAL)
    }
    expect(arg.html).toContain('Unsubscribe')
  })

  it('FAILS CLOSED on missing postal address — send refused, sent_at NOT written', async () => {
    delete process.env.MARKETING_POSTAL_ADDRESS
    enqueueWelcomeLookups()
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'canspam_no_postal_address' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    // Left schedulable — no welcome_email_sent_at write, so the cron retries.
    expect(updatePayloads('leads').some(u => 'welcome_email_sent_at' in u)).toBe(false)
  })

  it('FAILS CLOSED on token mint failure — send refused', async () => {
    enqueueWelcomeLookups()
    h.enqueue('leads', null, { message: 'boom', code: '42703' })   // token read fails
    const res = await sendWelcomeEmail('lead-1')
    expect(res).toEqual({ sent: false, error: 'canspam_no_token' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})

// ═══ 4. stage rail — closed-job commercial vs estimate transactional ═══════
describe('sendStageEmail — closed-job carries the footer; estimates do not', () => {
  const CLOSED = ['opp_closed_job_3mo', 'opp_closed_job_12mo']

  it.each(CLOSED)('%s: footer present, client reason, absolute token-bearing URL', async (key) => {
    h.enqueue('scheduled_stage_emails', { id: 'sse-1', lead_id: 'lead-1', stage_email_key: key, sent_at: null, cancelled_at: null })
    h.enqueue('templates', { subject: 'S', body: 'Closed-job body', name: key })
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)
    h.enqueue('leads', { unsubscribe_token: `tok-${key}` })   // ensureUnsubscribeToken read
    const res = await sendStageEmail('sse-1')
    expect(res).toEqual({ sent: true })
    const arg = sendEmailMock.mock.calls[0][0] as any
    for (const body of [arg.html, arg.text]) {
      expect(body).toContain(CLIENT_REASON)
      expect(body).toContain(`${APP_ORIGIN}/unsubscribe/tok-${key}`)
      expect(body).toContain(POSTAL)
    }
  })

  it.each(CLOSED)('%s FAILS CLOSED on missing postal address — send refused, sent_at NOT written', async (key) => {
    delete process.env.MARKETING_POSTAL_ADDRESS
    h.enqueue('scheduled_stage_emails', { id: 'sse-1', lead_id: 'lead-1', stage_email_key: key, sent_at: null, cancelled_at: null })
    h.enqueue('templates', { subject: 'S', body: 'Closed-job body', name: key })
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)
    const res = await sendStageEmail('sse-1')
    expect(res).toEqual({ sent: false, error: 'canspam_no_postal_address' })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(updatePayloads('scheduled_stage_emails').some(u => 'sent_at' in u)).toBe(false)
  })

  const ESTIMATES = [
    'opp_organizing_estimate_3d', 'opp_organizing_estimate_30d',
    'opp_moving_estimate_3d', 'opp_moving_estimate_30d',
  ]
  it.each(ESTIMATES)('%s (transactional): NO footer, no token minted', async (key) => {
    h.enqueue('scheduled_stage_emails', { id: 'sse-e', lead_id: 'lead-1', stage_email_key: key, sent_at: null, cancelled_at: null })
    h.enqueue('templates', { subject: 'S', body: 'Estimate follow-up body', name: key })
    h.enqueue('leads', baseLead())
    h.enqueue('locations', LOC)
    const res = await sendStageEmail('sse-e')
    expect(res).toEqual({ sent: true })
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.html).not.toContain('/unsubscribe/')
    expect(arg.html.toLowerCase()).not.toContain('unsubscribe')
    expect(arg.text.toLowerCase()).not.toContain('unsubscribe')
    // No ensureUnsubscribeToken read → the only leads query is the main lookup.
    expect(callsFor('leads')).toHaveLength(1)
  })
})

// ═══ 5. no footer leaks onto transactional content (pure-render proof) ══════
describe('transactional content stays footer-less', () => {
  const brandCtx = { location_name: 'Boulder', location_phone: '(303) 555-0147', reviews_link: null }
  const ESTIMATES = [
    'opp_organizing_estimate_3d', 'opp_organizing_estimate_30d',
    'opp_moving_estimate_3d', 'opp_moving_estimate_30d',
  ]
  it.each(ESTIMATES)('%s render carries no CAN-SPAM footer', (key) => {
    const { html, text } = renderStageEmailContent(key, 'Body', brandCtx)
    expect(html.toLowerCase()).not.toContain('unsubscribe')
    expect(text.toLowerCase()).not.toContain('unsubscribe')
  })

  it('the drip branded wrapper carries no CAN-SPAM footer (drips are transactional)', () => {
    const html = buildBrandedDripHtml('Body of a drip step', brandCtx)
    expect(html.toLowerCase()).not.toContain('unsubscribe')
  })
})
