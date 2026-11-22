// @vitest-environment happy-dom
//
// Partner emails, slice 3 fixes (2026-11-22). Rule for this area: do not test
// for a heading or a label — compare the real output.
//
//   THE PREVIEW, THE READ WINDOW AND THE SEND SHOW THE SAME FOOTER. The same
//   partner email is produced three ways — the editor's Preview (rendered and
//   clicked, read out of its frame), the Read window's preview, and "Send me a
//   test" (the route, its real html) — and the unsubscribe footer is cut out of
//   each and compared as text. Equal, non-empty, with the unsubscribe link and
//   the postal address. If one path drifts (or forgets it), this fails.
//
//   PARTNER EMAILS OFFER ONLY NONE AND CUSTOM FOR A BUTTON, read from the
//   editor as rendered; client emails keep all five. A step carrying a
//   booking-link button anyway is held by the send, never sent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => ({ queue: [] as { table: string; resp: any }[], sent: [] as any[] }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => {
  const i = h.queue.findIndex(q => q.table === t); const resp = i >= 0 ? h.queue.splice(i, 1)[0].resp : { data: null, error: null }
  const b: any = {}; for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = () => b
  b.single = () => Promise.resolve(resp); b.maybeSingle = () => Promise.resolve(resp); b.then = (r: any, j: any) => Promise.resolve(resp).then(r, j); return b
}, rpc: () => Promise.resolve({ data: null, error: null }) } }))
vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'owner@beeorganized.com' } } }) },
  from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'u1', role: 'owner', location_id: 'loc-1' }, error: null }); return b },
}) }))
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: async () => ({ id: 'u1', full_name: 'Lynette Ewy', phone: null }) }))
vi.mock('@/lib/email-signature-resolve', () => ({ resolveEmailSignature: async () => SIG }))
vi.mock('@/lib/resend', async (o) => ({ ...(await o() as any), sendEmail: async (a: any) => { h.sent.push(a); return { success: true } } }))

import { NextRequest } from 'next/server'
import * as BeeHub from '@/components/BeeHub'
import * as EmailsScreen from '@/components/settings/EmailsScreen'
import { POST as partnerTestSend } from '@/app/api/emails/test-send-partner/route'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const { DripPathStepEditor, dripEmailRows } = BeeHub as any
const { previewEmailHtml } = EmailsScreen as any

const SIG = { name: 'Lynette Ewy', title: 'Owner', email: 'kc@beeorganized.com', mobile: '8165550100', photoUrl: null, locationName: 'Kansas City' }
const POSTAL = '1 Hive Way, Kansas City, MO 64105'
const BODY = 'Hi {{partner_name}},\n\nIt was such a pleasure meeting you.\n\nWarmly,\n{{signature}}'
const STEP = { id: 'm1', order: 1, type: 'email', delay_days: 0, subject: 'Great to meet you', body: BODY, origin: 'master', fromMaster: true, isActive: true }
const VALUES = { partner_name: 'Taylor', location_owner_name: 'Lynette Ewy', location_name: 'Kansas City', location_phone: '8165550100', reviews_link: null }
const PREVIEW = { style: 'soft', values: VALUES, signature: SIG, postalAddress: POSTAL }

// The footer cut out of a finished email: its text (tags out, spaces folded)
// and the paths its links point at.
function footerOf(html: string) {
  const m = /<td class="bo-card-footer[^"]*"[^>]*>([\s\S]*?)<\/td>/.exec(html)
  if (!m) return { text: '', links: [] as string[] }
  const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
  const links = Array.from(m[1].matchAll(/href="([^"]+)"/g)).map(x => new URL(x[1], 'http://x').pathname)
  return { text, links }
}

let container: HTMLElement, root: ReturnType<typeof createRoot>
beforeEach(() => {
  h.queue = []; h.sent = []
  process.env.MARKETING_POSTAL_ADDRESS = POSTAL; process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function sentHtml() {
  h.queue.push({ table: 'locations', resp: { data: { id: 'loc-1', name: 'Kansas City', phone: '8165550100', city: 'Kansas City', state: 'MO', rate_per_hour: null, reviews_link: null, email_style: 'soft' }, error: null } },
    { table: 'drip_path_steps', resp: { data: { id: 'st1', subject: 'Great to meet you', body: BODY, body_format: 'plain', drip_paths: { id: 'p', location_uuid: null, is_master: true, path_key: 'partner-introduction' } }, error: null } })
  const res = await partnerTestSend(new NextRequest('http://hub.test/x', { method: 'POST', body: JSON.stringify({ locationId: 'loc-1', stepId: 'st1' }) }))
  expect(res.status).toBe(200)
  return h.sent[0].html as string
}
function readHtml() {
  const row = dripEmailRows({ pathSteps: { 'partner-introduction': [STEP] }, templates: [], pathKey: 'partner-introduction' })[0]
  return previewEmailHtml({ row, ...PREVIEW }) as string
}
async function editorPreviewHtml(audience = 'partner') {
  await act(async () => { root.render(<DripPathStepEditor audience={audience} preview={PREVIEW} onSave={vi.fn()} onClose={() => {}}
    step={{ step_order: 1, subject: STEP.subject, body: BODY, delay_days: 0, button_text: '', button_link: '', button_align: null }} />) })
  const btn = (Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]).find(b => b.textContent === 'Preview')!
  await act(async () => { btn.click() })
  const frame = document.querySelector('[data-editor-preview] iframe') as HTMLIFrameElement
  return frame.getAttribute('srcdoc') || (frame as any).srcdoc || ''
}

describe('the Preview, the Read window and the send show the same footer, compared as text', () => {
  it('all three are equal, and the footer is really there', async () => {
    const [send, read, edit] = [footerOf(await sentHtml()), footerOf(readHtml()), footerOf(await editorPreviewHtml())]
    expect(send.text).not.toBe('')
    expect(send.text).toContain('Unsubscribe')
    expect(send.text).toContain(POSTAL)
    expect(read.text).toBe(send.text)
    expect(edit.text).toBe(send.text)
    // and every link points at the same (placeholder) unsubscribe page
    for (const f of [send, read, edit]) expect(f.links).toEqual(['/unsubscribe/test-email'])
  })
  it('and the bodies the footer closes are the same email (greeting, signature)', async () => {
    for (const html of [await sentHtml(), readHtml(), await editorPreviewHtml()]) {
      expect(html).toContain('Hi Taylor,')
      expect(html).toContain('Lynette Ewy')
    }
  })
})

describe('a caller cannot leave the footer out', () => {
  it('a JS caller that passes nothing is refused at run time, not given a footer-less email', async () => {
    const { buildBrandedDripHtml, buildBrandedDripText, buildBrandedShellHtml } = await import('@/lib/drip-email-layout')
    expect(() => (buildBrandedDripHtml as any)('Hi', { location_name: 'KC' })).toThrow(/cannot be left out/)
    expect(() => (buildBrandedDripText as any)('Hi', { location_name: 'KC' })).toThrow(/cannot be left out/)
    expect(() => (buildBrandedShellHtml as any)('<p>x</p>', 'y')).toThrow(/cannot be left out/)
    expect(() => (buildBrandedDripHtml as any)('Hi', { location_name: 'KC' }, { footer: 'none' })).toThrow(/needs a reason/)
    expect(() => (buildBrandedDripHtml as any)('Hi', { location_name: 'KC' }, { html: 'bare', text: 'bare' })).toThrow(/cannot be left out/)
  })
  it('every TypeScript caller states it (the build checks the rest)', () => {
    for (const f of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'lib/feedback-reply-email.ts', 'lib/lead-notification-email.ts', 'app/api/emails/test-send/route.ts', 'lib/network/partner-email.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).toMatch(/NO_FOOTER\(|\{ footer: /)
    }
  })
})

describe('partner emails offer only None and Custom for a button', () => {
  const pills = () => Array.from(document.querySelectorAll('[data-button-pill]')).map(e => e.getAttribute('data-button-pill'))
  const LINKS = { discovery: 'https://cal.example/d', inHome: 'https://cal.example/h', video: 'https://cal.example/v' }
  const mount = async (audience?: string) => act(async () => { root.render(<DripPathStepEditor {...(audience ? { audience } : {})} links={LINKS} onSave={vi.fn()} onClose={() => {}}
    step={{ step_order: 1, subject: 'S', body: 'B', delay_days: 0, button_text: '', button_link: '', button_align: null }} />) })
  it('partner: exactly None and Custom', async () => { await mount('partner'); expect(pills()).toEqual(['none', 'custom']) })
  it('client: all five, as before', async () => { await mount(); expect(pills()).toEqual(['none', 'discovery', 'inHome', 'video', 'custom']) })
  it('a partner step that already carries a booking-link button is held by the send, not sent', async () => {
    h.queue.push({ table: 'locations', resp: { data: { id: 'loc-1', name: 'Kansas City', email_style: 'soft' }, error: null } },
      { table: 'drip_path_steps', resp: { data: { id: 'st1', subject: 'S', body: 'B', button_text: 'Book', button_link: '{{discovery_booking_link}}', drip_paths: { id: 'p', location_uuid: null, is_master: true, path_key: 'partner-introduction' } }, error: null } })
    const res = await partnerTestSend(new NextRequest('http://hub.test/x', { method: 'POST', body: JSON.stringify({ locationId: 'loc-1', stepId: 'st1' }) }))
    expect(res.status).toBe(409)
    expect(h.sent).toEqual([])
  })
})
