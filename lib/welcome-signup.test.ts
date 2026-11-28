// FL-131: what the ongoing Mailchimp sync needs from Bee Hub's greeting —
// a 24-hour clock that can start at the Mailchimp join time, the 72-hour
// limit checked again at send time, a reason saved when it is skipped, and a
// Mailchimp sign-up not mistaken for a past client. Every other greeting is
// unchanged (each test pins that too).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; payload: any; filters: any[] }>,
  lead: null as any,
  won: null as any,
  saidNo: 'said_no' as string,
}))
vi.mock('./supabase-service', () => {
  const from = (table: string) => {
    let op = 'select', payload: any = null
    const filters: any[] = []
    const q: any = {
      select: () => q, eq: (...a: any[]) => { filters.push(['eq', ...a]); return q }, is: (...a: any[]) => { filters.push(['is', ...a]); return q },
      not: (...a: any[]) => { filters.push(['not', ...a]); return q }, limit: () => q,
      update: (p: any) => { op = 'update'; payload = p; return q },
      maybeSingle: () => q, single: () => q,
      then: (ok: any, bad: any) => {
        if (op === 'update') { h.updates.push({ table, payload, filters }); return Promise.resolve({ data: null, error: null }).then(ok, bad) }
        if (table === 'leads') return Promise.resolve({ data: h.lead, error: null }).then(ok, bad)
        if (table === 'engagements') return Promise.resolve({ data: h.won, error: null }).then(ok, bad)
        return Promise.resolve({ data: null, error: null }).then(ok, bad)
      },
    }
    return q
  }
  return { supabaseService: { from } }
})
vi.mock('./marketing-no-list', () => ({ addressSaidNo: async () => h.saidNo, SAID_NO_ELSEWHERE: 'unsubscribed_elsewhere', NO_LIST_UNREADABLE: 'no_list_unreadable' }))
vi.mock('./resend', () => ({ sendEmail: async () => { throw new Error('nothing may be sent in these tests') }, renderTemplate: () => '' }))

import { scheduleWelcomeEmail, sendWelcomeEmail, skipWelcomeEmail } from './welcome-email'
import { pastClientCheck } from './drip-lifecycle'

const H = 3600e3
beforeEach(() => { h.updates.length = 0; h.lead = null; h.won = null; h.saidNo = 'said_no'; vi.useRealTimers() })

describe('the clock can start at the Mailchimp join time', () => {
  it('from: join time → due 24 hours after it (even if that is already past)', async () => {
    const joined = '2026-11-27T10:00:00.000Z'
    expect(await scheduleWelcomeEmail('L1', { import_source: 'mailchimp_signup', paid_amount: 0 }, { from: joined })).toBe('scheduled')
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].payload).toEqual({ welcome_email_scheduled_at: '2026-11-28T10:00:00.000Z' })
    // Only ever set once: both columns must still be empty.
    expect(h.updates[0].filters).toEqual(expect.arrayContaining([['is', 'welcome_email_sent_at', null], ['is', 'welcome_email_scheduled_at', null]]))
  })
  it('no from (every other caller) → now + 24 hours, exactly as before', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-28T12:00:00.000Z'))
    expect(await scheduleWelcomeEmail('L1', { import_source: 'manual', paid_amount: 0 })).toBe('scheduled')
    expect(h.updates[0].payload).toEqual({ welcome_email_scheduled_at: '2026-11-29T12:00:00.000Z' })
  })
  it('a from that is not a date → nothing set', async () => {
    expect(await scheduleWelcomeEmail('L1', { import_source: 'mailchimp_signup', paid_amount: 0 }, { from: 'soon' })).toBe('error')
    expect(h.updates).toEqual([])
  })
})

describe('72 hours, checked again when it would be sent', () => {
  const signup = (hoursSinceJoining: number) => ({
    id: 'L1', name: 'Pat', first_name: 'Pat', email: 'p@x.org', location_uuid: 'loc', assigned_to: null,
    welcome_email_sent_at: null, welcome_email_scheduled_at: '2026-11-25T10:00:00.000Z', is_junk: false, paused: false, marketing_opt_out: false,
    import_source: 'mailchimp_signup', paid_amount: 0, created_at: new Date(Date.now() - hoursSinceJoining * H).toISOString(),
  })
  it('a Mailchimp sign-up past 72 hours → not sent, skipped with the reason and the due time saved', async () => {
    h.lead = signup(73)
    expect(await sendWelcomeEmail('L1')).toEqual({ sent: false, error: 'too_late' })
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].payload).toMatchObject({ welcome_email_scheduled_at: null, welcome_email_skip_reason: 'too_late', welcome_email_skipped_due_at: '2026-11-25T10:00:00.000Z' })
    expect(h.updates[0].filters).toContainEqual(['is', 'welcome_email_sent_at', null])
  })
  it('a Mailchimp sign-up inside 72 hours → passes this gate (stopped here by the next one, the no-marketing list)', async () => {
    h.lead = signup(71)
    expect(await sendWelcomeEmail('L1')).toEqual({ sent: false, error: 'unsubscribed_elsewhere' })
  })
  it('anyone else, however old the record → this gate never applies', async () => {
    h.lead = { ...signup(24 * 30), import_source: 'manual' }
    expect(await sendWelcomeEmail('L1')).toEqual({ sent: false, error: 'unsubscribed_elsewhere' })
  })
  it('skipWelcomeEmail never touches a greeting already sent', async () => {
    expect(await skipWelcomeEmail('L1', 'added_by_jobber')).toBe(true)
    expect(h.updates[0].payload).toMatchObject({ welcome_email_scheduled_at: null, welcome_email_skip_reason: 'added_by_jobber', welcome_email_skipped_due_at: null })
    expect(h.updates[0].filters).toContainEqual(['is', 'welcome_email_sent_at', null])
  })
})

describe('a Mailchimp sign-up is not a past client — until they are one', () => {
  it('sign-up, nothing paid, never won → not past', async () => {
    expect(await pastClientCheck('L1', { import_source: 'mailchimp_signup', paid_amount: 0 })).toEqual({ past: false, failed: false })
  })
  it('sign-up who has paid, or was won → past', async () => {
    expect((await pastClientCheck('L1', { import_source: 'mailchimp_signup', paid_amount: 50 })).past).toBe(true)
    h.won = { id: 'E1' }
    expect((await pastClientCheck('L1', { import_source: 'mailchimp_signup', paid_amount: 0 })).past).toBe(true)
  })
  it.each(['mailchimp_import', 'jobber', 'csv', 'webhook'])('every other import source stays a past client ("%s")', async (src) => {
    expect((await pastClientCheck('L1', { import_source: src, paid_amount: 0 })).past).toBe(true)
  })
})
