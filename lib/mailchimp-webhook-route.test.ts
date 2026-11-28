// FL-131: the address Mailchimp calls, and the hourly sweep. Who is let in,
// and that both run the same ongoing sync — nothing else.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ runs: [] as any[][], answer: { ok: true, created: 1, greeted: 1 } as any, loc: null as any }))
vi.mock('@/lib/mailchimp-ongoing', async () => ({
  runOngoing: async (...a: any[]) => { h.runs.push(a); return h.answer },
  ONGOING_LOCATIONS: (await import('@/lib/mailchimp-rollout')).MAILCHIMP_OPEN_LOCATIONS,
}))
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: h.loc, error: null }) }; return q } },
}))

import { GET, POST } from '@/app/api/mailchimp/webhook/route'
import { GET as SWEEP } from '@/app/api/cron/mailchimp-sweep/route'
import { mailchimpWebhookKey, mailchimpWebhookUrl } from '@/lib/mailchimp-webhook-key'

const TEST = 'a8fe17f6-fd16-4ed3-8730-550a65d69ad6'
const CHATT = 'e7b05e53-7bd7-48de-a13b-10018c8b1b08'
const TOKEN = 'tok-abcdefghijklmnop'
const key = (id = TEST, t = TOKEN) => mailchimpWebhookKey(t, id)!
const url = (id: string, k: string) => `https://beehive.beeorganized.com/api/mailchimp/webhook?l=${id}&k=${k}`
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString()
const post = (u: string, fields: Record<string, string>) => POST(new NextRequest(u, { method: 'POST', body: form(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } }))

beforeEach(() => {
  h.runs.length = 0; h.answer = { ok: true, created: 1, greeted: 1 }
  h.loc = { id: TEST, mailchimp_connected: true, mailchimp_access_token: TOKEN, mailchimp_list_id: 'aud1' }
})

describe('the address Mailchimp calls', () => {
  it('Mailchimp\'s check (GET) answers only with the right key', async () => {
    expect((await GET(new NextRequest(url(TEST, key())))).status).toBe(200)
    expect((await GET(new NextRequest(url(TEST, key().replace(/.$/, (c) => c === '0' ? '1' : '0'))))).status).toBe(404)
    expect((await GET(new NextRequest(url(TEST, '')))).status).toBe(404)
  })
  it('a "subscribe" for this location\'s list → the ongoing sync runs once, for this location', async () => {
    const r = await post(url(TEST, key()), { type: 'subscribe', 'data[list_id]': 'aud1', 'data[email]': 'pat@x.org' })
    expect(r.status).toBe(200)
    expect(h.runs).toEqual([[TEST, { trigger: 'webhook' }]])
    expect(await r.json()).toEqual({ ok: true, created: 1, greeted: 1 })
  })
  it('anything but "subscribe", or another list → nothing runs', async () => {
    for (const f of [{ type: 'unsubscribe', 'data[list_id]': 'aud1' }, { type: 'profile', 'data[list_id]': 'aud1' }, { type: 'subscribe', 'data[list_id]': 'other' }, {}]) {
      expect((await post(url(TEST, key()), f as any)).status).toBe(200)
    }
    expect(h.runs).toEqual([])
  })
  it('a bad key, a location not open before roll-out, or a lost connection → turned away, nothing runs', async () => {
    expect((await post(url(TEST, 'f'.repeat(40)), { type: 'subscribe', 'data[list_id]': 'aud1' })).status).toBe(404)
    h.loc = { ...h.loc, id: CHATT }
    expect((await post(url(CHATT, key(CHATT)), { type: 'subscribe', 'data[list_id]': 'aud1' })).status).toBe(404)
    h.loc = { id: TEST, mailchimp_connected: false, mailchimp_access_token: TOKEN, mailchimp_list_id: 'aud1' }
    expect((await post(url(TEST, key()), { type: 'subscribe', 'data[list_id]': 'aud1' })).status).toBe(404)
    // A reconnect (new token) makes the old address useless.
    h.loc = { id: TEST, mailchimp_connected: true, mailchimp_access_token: 'tok-a-brand-new-one', mailchimp_list_id: 'aud1' }
    expect((await post(url(TEST, key()), { type: 'subscribe', 'data[list_id]': 'aud1' })).status).toBe(404)
    expect(h.runs).toEqual([])
  })
  it('a run that can\'t finish → 500, so Mailchimp tries again; set-up not finished → 200, nothing to do', async () => {
    h.answer = { ok: false, reason: 'audience_unreadable' }
    expect((await post(url(TEST, key()), { type: 'subscribe', 'data[list_id]': 'aud1' })).status).toBe(500)
    h.answer = { ok: false, reason: 'setup_not_finished' }
    expect((await post(url(TEST, key()), { type: 'subscribe', 'data[list_id]': 'aud1' })).status).toBe(200)
  })
  it('the key: tied to the location and its connection; the address carries it', () => {
    expect(key()).toMatch(/^[0-9a-f]{40}$/)
    expect(key(CHATT)).not.toBe(key())
    expect(mailchimpWebhookKey(null, TEST)).toBeNull()
    expect(mailchimpWebhookUrl('https://beehive.beeorganized.com/', TOKEN, TEST)).toBe(url(TEST, key()))
  })
})

describe('the hourly sweep', () => {
  const was = process.env.CRON_SECRET
  afterEach(() => { if (was === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = was })
  const sweep = (auth?: string) => SWEEP(new NextRequest('https://x/api/cron/mailchimp-sweep', { headers: auth ? { authorization: auth } : {} }))
  it('no secret set → refused; wrong secret → refused; nothing runs', async () => {
    delete process.env.CRON_SECRET
    expect((await sweep('Bearer x')).status).toBe(500)
    process.env.CRON_SECRET = 's3cret'
    expect((await sweep('Bearer nope')).status).toBe(401)
    expect(h.runs).toEqual([])
  })
  it('the right secret → the ongoing sync runs for Test Location, and only Test Location', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await sweep('Bearer s3cret')).status).toBe(200)
    expect(h.runs).toEqual([[TEST, { trigger: 'sweep' }]])
  })
  it('it is in the cron list, hourly', async () => {
    const v = JSON.parse((await import('fs')).readFileSync('vercel.json', 'utf8'))
    expect(v.crons).toContainEqual({ path: '/api/cron/mailchimp-sweep', schedule: '15 * * * *' })
  })
})
