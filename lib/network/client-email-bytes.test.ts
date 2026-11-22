// @vitest-environment node
//
// Partner emails, slice 3 fixes (2026-11-22): CLIENT EMAILS ARE UNCHANGED, BY
// FINGERPRINT. The footer argument of the email layout became required (a
// caller must now say "this footer" or "no footer, because …"), which touched
// every caller of lib/drip-email-layout.ts. This renders every kind of email a
// client, owner or franchisee receives through that layout — with fixed
// fixtures — and compares the sha-256 of the real output with what origin's
// code (66c41af, before the change) produced. One byte different fails.
//
//   drip steps (the layout as lib/drip-send.ts calls it: plain, html, button,
//   signature, every style), the welcome, every stage email, the feedback
//   reply, the shell as the lead notification calls it, the Emails screen's
//   style samples and client previews, and the client "Send me a test".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({ queue: [] as { table: string; resp: any }[], sent: [] as any[] }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => {
  const i = h.queue.findIndex(q => q.table === t); const resp = i >= 0 ? h.queue.splice(i, 1)[0].resp : { data: null, error: null }
  const b: any = {}; for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = () => b
  b.single = () => Promise.resolve(resp); b.maybeSingle = () => Promise.resolve(resp); b.then = (r: any, j: any) => Promise.resolve(resp).then(r, j); return b
} } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'owner@beeorganized.com' } } }) },
  from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'u1', role: 'owner', location_id: 'loc-1', full_name: 'Lynette Ewy', first_name: 'Lynette' }, error: null }); return b },
}) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: async () => ({ id: 'u1', full_name: 'Lynette Ewy', phone: null }) }))
vi.mock('@/lib/email-signature-resolve', () => ({ resolveEmailSignature: async () => ({ name: 'Lynette Ewy', title: 'Owner', email: 'kc@beeorganized.com', mobile: '8165550100', photoUrl: null, locationName: 'Kansas City' }) }))
vi.mock('@/lib/booking-link', async (o) => ({ ...(await o() as any), resolveOwnerBookingLink: async () => 'https://cal.example/owner' }))
vi.mock('@/lib/template-fork', () => ({ resolveLocationTemplateFork: async () => null }))
vi.mock('@/lib/resend', async (o) => ({ ...(await o() as any), sendEmail: async (a: any) => { h.sent.push(a); return { success: true } } }))

import * as Layout from '@/lib/drip-email-layout'
import { renderWelcomeEmailContent } from '@/lib/welcome-email'
import { renderStageEmailContent } from '@/lib/stage-emails'
import { buildFeedbackReplyEmail } from '@/lib/feedback-reply-email'
import { buildMarketingFooter } from '@/lib/marketing-consent'
import * as EmailsScreen from '@/components/settings/EmailsScreen'
const { sampleEmailHtml, previewEmailHtml } = EmailsScreen as any
import { NextRequest } from 'next/server'
import { POST as clientTestSend } from '@/app/api/emails/test-send/route'

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const L: any = Layout
// What a no-footer caller passes now; nothing at all before the change.
const none = (reason: string) => (typeof L.NO_FOOTER === 'function' ? [L.NO_FOOTER(reason)] : [])
const withFooter = (f: any) => (typeof L.NO_FOOTER === 'function' ? [{ footer: f }] : [f])

const SIG = { name: 'Lynette Ewy', title: 'Owner', email: 'kc@beeorganized.com', mobile: '8165550100', photoUrl: null, locationName: 'Kansas City' }
const BODY = 'Hello Jordan,\n\nThank you so much for reaching out. Book HERE (https://cal.example/x)\n\nThank you,\n\u0000SIG\u0000\n\nBe sure to check out our Google Reviews! (https://g.page/r/x)'
const BODY_SIG = BODY.replace('\u0000SIG\u0000', (Layout as any).SIGNATURE_MARKER ?? '')
const HTML_BODY = '<p>Hello <strong>Jordan</strong>,</p><ul><li>One</li><li>Two</li></ul><p>Thanks</p>'
const ctx = (over: any = {}) => ({ location_name: 'Kansas City', location_phone: '8165550100', reviews_link: 'https://g.page/r/x', style: 'soft', heading: 'Thank you for reaching out!', ...over })
const FOOTER = buildMarketingFooter({ unsubscribeUrl: 'https://hub.test/unsubscribe/abc', postalAddress: '1 Hive Way, Kansas City, MO', audience: 'client' })

function outputs(): Record<string, string> {
  const o: Record<string, string> = {}
  for (const style of ['soft', 'outline', 'bold', 'rounded', 'classic']) {
    o[`drip-html-${style}`] = L.buildBrandedDripHtml(BODY_SIG, ctx({ style, signature: SIG }), ...none('a drip step'))
    o[`drip-text-${style}`] = L.buildBrandedDripText(BODY_SIG, ctx({ style, signature: SIG }), ...none('a drip step'))
    o[`drip-button-${style}`] = L.buildBrandedDripHtml(BODY, ctx({ style, button: { label: 'Book now', href: 'https://cal.example/b', align: 'center' } }), ...none('a drip step'))
    o[`sample-${style}`] = sampleEmailHtml(style)
  }
  o['drip-htmlbody'] = L.buildBrandedDripHtml(HTML_BODY, ctx({ bodyFormat: 'html' }), ...none('a drip step'))
  o['drip-htmlbody-text'] = L.buildBrandedDripText(HTML_BODY, ctx({ bodyFormat: 'html' }), ...none('a drip step'))
  o['drip-noheading-noreviews'] = L.buildBrandedDripHtml('Hi,\n\nShort.', ctx({ heading: null, reviews_link: null }), ...none('a drip step'))
  o['shell-notification'] = L.buildBrandedShellHtml('<p>A new lead</p>', '<div>Sent by Bee Organized</div>', ...none('an internal notification'))
  o['shell-with-footer'] = L.buildBrandedShellHtml('<p>x</p>', '<div>y</div>', ...(typeof L.NO_FOOTER === 'function' ? [{ footer: FOOTER }] : [FOOTER.html]))
  const w = renderWelcomeEmailContent(BODY_SIG, ctx({ signature: SIG }), FOOTER)
  o['welcome-html'] = w.html; o['welcome-text'] = w.text
  for (const key of ['opp_closed_job_3mo', 'opp_closed_job_12mo']) {
    const s = renderStageEmailContent(key, BODY, ctx(), FOOTER); o[`${key}-html`] = s.html; o[`${key}-text`] = s.text
  }
  for (const key of ['opp_organizing_estimate_3d', 'opp_organizing_estimate_30d', 'opp_moving_estimate_3d', 'opp_moving_estimate_30d']) {
    const s = renderStageEmailContent(key, BODY, ctx(), null); o[`${key}-html`] = s.html; o[`${key}-text`] = s.text
  }
  const fb = buildFeedbackReplyEmail({ recipientName: 'Lynette', itemTitle: 'Export button', itemType: 'bug', replyText: 'Fixed, thanks!', statusLabel: 'Fixed', link: 'https://hub.test/f' })
  o['feedback-html'] = fb.html; o['feedback-text'] = fb.text
  const values = { first_name: 'Jordan', location_name: 'Kansas City', location_phone: '8165550100', reviews_link: 'https://g.page/r/x' }
  o['preview-drip'] = previewEmailHtml({ row: { rail: 'drip', pathKey: 'organizing-a', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}},\n\n{{signature}}' }, style: 'soft', values, signature: SIG, postalAddress: '1 Hive Way' })
  o['preview-welcome'] = previewEmailHtml({ row: { rail: 'welcome', templateKey: 'welcome', subject: 'Welcome', body: 'Hi {{first_name}}' }, style: 'bold', values, signature: null, postalAddress: '1 Hive Way' })
  o['preview-closed-job'] = previewEmailHtml({ row: { rail: 'stage', templateKey: 'opp_closed_job_3mo', subject: 'Hi', body: 'Hi {{first_name}}' }, style: 'classic', values, signature: null, postalAddress: null })
  return o
}

// sha-256 (first 16 hex) of each output, produced by the code at 66c41af.
const BEFORE: Record<string, string> = {
  "drip-html-soft": "26ecb25ae4efd483",
  "drip-text-soft": "c9668fadefe650bf",
  "drip-button-soft": "8b17cf27905a9285",
  "sample-soft": "90a3601c24b1550a",
  "drip-html-outline": "26ecb25ae4efd483",
  "drip-text-outline": "c9668fadefe650bf",
  "drip-button-outline": "cbea80432fac4894",
  "sample-outline": "36f0b740caf8e49a",
  "drip-html-bold": "26ecb25ae4efd483",
  "drip-text-bold": "c9668fadefe650bf",
  "drip-button-bold": "f7d2aae4a1d87cbc",
  "sample-bold": "935c023d1fc613b8",
  "drip-html-rounded": "e611e5c7f706f473",
  "drip-text-rounded": "c9668fadefe650bf",
  "drip-button-rounded": "deaacb9cf9ce1547",
  "sample-rounded": "f3a53f9077f9d5be",
  "drip-html-classic": "d56e1219b092e816",
  "drip-text-classic": "c9668fadefe650bf",
  "drip-button-classic": "ed27f694dd38cb55",
  "sample-classic": "366c8cbc834fef9c",
  "drip-htmlbody": "2dadc8cd7b14c1da",
  "drip-htmlbody-text": "7140f41560b7e0a7",
  "drip-noheading-noreviews": "115394b9a2185c14",
  "shell-notification": "7463188ddeb9cb60",
  "shell-with-footer": "f59fbaf867367c19",
  "welcome-html": "f9fba956b9c8a991",
  "welcome-text": "221319799169bfbd",
  "opp_closed_job_3mo-html": "275338f73b6a9026",
  "opp_closed_job_3mo-text": "d513fdc268a6c401",
  "opp_closed_job_12mo-html": "275338f73b6a9026",
  "opp_closed_job_12mo-text": "d513fdc268a6c401",
  "opp_organizing_estimate_3d-html": "ba7c1ff8095d9d78",
  "opp_organizing_estimate_3d-text": "1fb917484b6ab4c3",
  "opp_organizing_estimate_30d-html": "ba7c1ff8095d9d78",
  "opp_organizing_estimate_30d-text": "1fb917484b6ab4c3",
  "opp_moving_estimate_3d-html": "ba7c1ff8095d9d78",
  "opp_moving_estimate_3d-text": "1fb917484b6ab4c3",
  "opp_moving_estimate_30d-html": "ba7c1ff8095d9d78",
  "opp_moving_estimate_30d-text": "1fb917484b6ab4c3",
  "feedback-html": "0ece2a6a6157d87a",
  "feedback-text": "c0e342b13e46ddcc",
  "preview-drip": "97e70271cd5ac2b0",
  "preview-welcome": "c5a9745dba9e7e2c",
  "preview-closed-job": "fb8dec45b18bc2fd",
  "test-send-0-html": "010532d2f8430802",
  "test-send-0-text": "be84bb38ae57307d",
  "test-send-0-to": "43431f29e5f49c99",
  "test-send-1-html": "cbcec5706105abef",
  "test-send-1-text": "d1ec067901987126",
  "test-send-1-to": "393caeabb9198282",
  "test-send-2-html": "986f81929b91854c",
  "test-send-2-text": "3d97634e63c97e99",
  "test-send-2-to": "f4b90c65ed5546f4",
  "test-send-count": "4e07408562bedb8b",
}

beforeEach(() => { h.queue = []; h.sent = []; process.env.MARKETING_POSTAL_ADDRESS = '1 Hive Way, Kansas City, MO'; process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test' })

describe('every client email is byte for byte what it was', () => {
  it('records (when RECORD=1)', async () => {
    if (!process.env.RECORD) return
    const all = { ...Object.fromEntries(Object.entries(outputs()).map(([k, v]) => [k, sha(v)])), ...(await testSendHashes()) }
    ;(await import('node:fs')).writeFileSync(process.env.RECORD, JSON.stringify(all, null, 2))
  })
  it('the layout, the welcome, the stage emails, the feedback reply, the samples and previews', () => {
    if (process.env.RECORD) return
    const now = Object.fromEntries(Object.entries(outputs()).map(([k, v]) => [k, sha(v)]))
    expect(Object.keys(now).length).toBe(44)
    for (const [k, v] of Object.entries(now)) expect(v, k).toBe(BEFORE[k])
  })
  it('the client "Send me a test" (drip step, welcome, a closed-job follow-up)', async () => {
    if (process.env.RECORD) return
    const now = await testSendHashes()
    for (const [k, v] of Object.entries(now)) expect(v, k).toBe(BEFORE[k])
  })
})

async function testSendHashes(): Promise<Record<string, string>> {
  const LOC = { id: 'loc-1', name: 'Kansas City', phone: '8165550100', city: 'Kansas City', state: 'MO', rate_per_hour: '$95', reviews_link: 'https://g.page/r/x', calendar_link: 'https://cal.example/loc', sender_name: 'Bee Organized KC', email_style: 'bold' }
  const out: Record<string, string> = {}
  const post = (body: any) => clientTestSend(new NextRequest('http://hub.test/api/emails/test-send', { method: 'POST', body: JSON.stringify(body) }))
  h.queue.push({ table: 'locations', resp: { data: LOC, error: null } }, { table: 'drip_path_steps', resp: { data: { id: 's1', subject: 'Hi {{first_name}}', body: 'Hello {{first_name}},\n\nBook HERE ({{book_assessment_link}})\n\n{{signature}}', drip_paths: { id: 'p', location_uuid: null, is_master: true } }, error: null } })
  await post({ locationId: 'loc-1', stepId: 's1' })
  h.queue.push({ table: 'locations', resp: { data: LOC, error: null } }, { table: 'templates', resp: { data: { id: 't1', legacy_id: 'welcome', subject: 'Welcome {{first_name}}', body: 'Hi {{first_name}},\n\nWelcome.' }, error: null } })
  await post({ locationId: 'loc-1', templateKey: 'welcome' })
  h.queue.push({ table: 'locations', resp: { data: LOC, error: null } }, { table: 'templates', resp: { data: { id: 't2', legacy_id: 'opp_closed_job_3mo', subject: 'How did we do?', body: 'Hi {{first_name}},\n\nThanks.' }, error: null } })
  await post({ locationId: 'loc-1', templateKey: 'opp_closed_job_3mo' })
  h.sent.forEach((m, i) => { out[`test-send-${i}-html`] = sha(m.html); out[`test-send-${i}-text`] = sha(m.text); out[`test-send-${i}-to`] = sha(m.to + '|' + m.subject) })
  out['test-send-count'] = sha(String(h.sent.length))
  return out
}
