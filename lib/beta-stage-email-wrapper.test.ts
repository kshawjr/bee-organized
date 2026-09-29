// @vitest-environment node
//
// Stage emails on the branded layout.
//
// renderStageEmailContent (lib/stage-emails.ts) renders all six opportunity-
// stage emails through the #90 Bee Organized layout. This suite pins:
//   - the four transactional estimate follow-ups: branded, NO footer
//   - the two COMMERCIAL Closed-Job follow-ups (3- and 12-month): branded, with
//     the #115 CAN-SPAM footer INSIDE the white card, directly above the teal
//     band — never after </html> (where the old append would have put it)
//   - a commercial follow-up refuses to render without its footer
//   - the booking link is a clickable word, the reviews line and phone appear
//   - {{signature}} still resolves through the branded path
//   - drips are byte-identical to before this change
//
// The footer-placement pin runs through the REAL send path (sendStageEmail →
// real buildCanSpamFooter → real layout) and checks what reaches sendEmail, so
// a regression in either the layout slot or the send site trips it.
//
// The CAN-SPAM tripwire hashes seed BODIES and so is blind to this HTML-layer
// change (see beta-drip-canspam-tripwire.test.ts) — this file is the guard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// ── Queued fake DB (FIFO per table), same shape as the issue 206 suite ──────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[] }
  const reset = () => { state.queue = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = () => b
    }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

// Real renderTemplate (tokens + the {{signature}} marker); only the network send is faked.
const sendEmailMock = vi.hoisted(() => vi.fn(async (_args: any) => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/resend')>()),
  sendEmail: sendEmailMock,
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => null),
}))
const SIGNATURE = {
  name: 'Jane Smith', title: 'Owner & Lead Organizer', email: 'jane@example.com',
  mobile: '303 555 0199', photoPath: null, websiteUrl: null,
  facebookUrl: null, instagramUrl: null, linkedinUrl: null,
}
vi.mock('@/lib/email-signature-resolve', () => ({
  resolveEmailSignature: vi.fn(async () => SIGNATURE),
}))

import { renderStageEmailContent, sendStageEmail } from '@/lib/stage-emails'
import {
  buildBrandedDripHtml,
  buildBrandedDripText,
  DRIP_BRAND_TEAL,
  DRIP_WEBSITE_LABEL,
  DRIP_LOGO_PATH,
  REVIEWS_LINE_TEXT,
} from '@/lib/drip-email-layout'

// The logo + unsubscribe URLs are built from the app origin at render time —
// pin one so the HTML is deterministic; restore afterward.
const APP_ORIGIN = 'https://beehive.beeorganized.com'
const POSTAL = '123 Hive Lane, Boulder, CO 80301'
const savedEnv = {
  app: process.env.NEXT_PUBLIC_APP_URL,
  site: process.env.NEXT_PUBLIC_SITE_URL,
  postal: process.env.MARKETING_POSTAL_ADDRESS,
}
beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN
  process.env.MARKETING_POSTAL_ADDRESS = POSTAL
})
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = savedEnv.app
  process.env.NEXT_PUBLIC_SITE_URL = savedEnv.site
  process.env.MARKETING_POSTAL_ADDRESS = savedEnv.postal
})

const ESTIMATE_KEYS = [
  'opp_organizing_estimate_3d',
  'opp_organizing_estimate_30d',
  'opp_moving_estimate_3d',
  'opp_moving_estimate_30d',
]
const COMMERCIAL_STAGE_KEYS = ['opp_closed_job_3mo', 'opp_closed_job_12mo']

const brandCtx = {
  location_name: 'Boulder',
  location_phone: '(303) 555-0147',
  reviews_link: 'https://g.page/bee-organized-boulder/review',
}

// A fully-rendered body: tokens already substituted, booking CTA in the
// corpus's "word (url)" form with a query string, no in-body reviews line.
const RENDERED_BODY = `Hi John,

Just following up. Click HERE (https://book.example.com/sarah?ref=a&b=2) to pick a time.

Our rate starts at $95 per hour per Bee.

Thank you,

Sarah Mitchell`

const STAND_IN_FOOTER = {
  html: '<div data-test="canspam">Unsubscribe here</div>',
  text: '—\nUnsubscribe at any time: https://x/unsubscribe/t',
}

// Where the teal band starts — everything above it and after the card's own
// open tag is "inside the white card".
const TEAL_BAND = `bgcolor="${DRIP_BRAND_TEAL}"`

function expectBrandedChrome(html: string) {
  expect(html).toContain('role="presentation"')
  expect(html).toContain('max-width:600px')
  expect(html).toContain('BEE ORGANIZED')
  expect(html).toContain('Simplify Your Hive')
  expect(html).toContain(`${APP_ORIGIN}${DRIP_LOGO_PATH}`)
  expect(html).toContain(TEAL_BAND)
  expect(html).toContain('Bee Organized Boulder')
  expect(html).toContain(DRIP_WEBSITE_LABEL)
}

// The compliance placement check. `needle` is a string that only the footer
// carries. It must appear exactly once, after the body copy and the card's
// opening tag, before the teal band, and inside the document.
function expectFooterInsideCard(html: string, needle: string, bodyMarker: string) {
  expect(html.split(needle).length - 1).toBe(1)
  const at = html.indexOf(needle)
  expect(at).toBeGreaterThan(html.indexOf('class="bo-card"'))
  expect(at).toBeGreaterThan(html.indexOf(bodyMarker))
  expect(at).toBeLessThan(html.indexOf(TEAL_BAND))
  expect(at).toBeLessThan(html.indexOf('</body>'))
  // It sits in its own row of the card table, directly above the band row.
  const between = html.slice(at, html.indexOf(TEAL_BAND))
  expect(between).not.toContain('class="bo-card"')
  expect(between.match(/<\/tr>/g)?.length).toBe(1)
  // Nothing trails the document.
  expect(html.trimEnd().endsWith('</html>')).toBe(true)
}

describe('transactional estimate follow-ups — branded, no footer', () => {
  it.each(ESTIMATE_KEYS)('%s renders inside the branded layout with no footer row', (key) => {
    const { html } = renderStageEmailContent(key, RENDERED_BODY, brandCtx)
    expectBrandedChrome(html)
    expect(html).not.toContain('bo-card-footer')
    // A footer passed by mistake is ignored — transactional mail stays footer-less.
    const { html: again } = renderStageEmailContent(key, RENDERED_BODY, brandCtx, STAND_IN_FOOTER)
    expect(again).toBe(html)
  })
})

describe('Closed-Job follow-ups (3- and 12-month) — branded, footer inside the card', () => {
  it.each(COMMERCIAL_STAGE_KEYS)('%s renders branded with the footer above the teal band', (key) => {
    const { html, text } = renderStageEmailContent(key, RENDERED_BODY, brandCtx, STAND_IN_FOOTER)
    expectBrandedChrome(html)
    expectFooterInsideCard(html, 'data-test="canspam"', 'Sarah Mitchell')
    // Plain text: footer after the body, before the band line.
    const t = text.indexOf('Unsubscribe at any time')
    expect(t).toBeGreaterThan(text.indexOf('Sarah Mitchell'))
    expect(t).toBeLessThan(text.indexOf('Bee Organized Boulder | beeorganized.com'))
  })

  it.each(COMMERCIAL_STAGE_KEYS)('%s refuses to render without its footer (fail closed)', (key) => {
    expect(() => renderStageEmailContent(key, RENDERED_BODY, brandCtx)).toThrow(/CAN-SPAM/)
    expect(() => renderStageEmailContent(key, RENDERED_BODY, brandCtx, null)).toThrow(/CAN-SPAM/)
  })

  it.each(COMMERCIAL_STAGE_KEYS)('%s: booking link is a clickable word, not a raw URL', (key) => {
    const { html, text } = renderStageEmailContent(key, RENDERED_BODY, brandCtx, STAND_IN_FOOTER)
    expect(html).toContain('<a href="https://book.example.com/sarah?ref=a&amp;b=2"')
    expect(html).toMatch(/>HERE<\/a>/)
    expect(html).not.toContain('HERE (https://')
    // Plain text can't hyperlink, so it keeps the visible URL.
    expect(text).toContain('Click HERE (https://book.example.com/sarah?ref=a&b=2)')
  })

  it.each(COMMERCIAL_STAGE_KEYS)('%s: the reviews line and location phone appear', (key) => {
    const { html, text } = renderStageEmailContent(key, RENDERED_BODY, brandCtx, STAND_IN_FOOTER)
    expect(html.split(`href="${brandCtx.reviews_link}"`).length - 1).toBe(1)
    expect(html).toContain(REVIEWS_LINE_TEXT)
    expect(html).toContain('(303) 555-0147')
    expect(text).toContain(`${REVIEWS_LINE_TEXT} (${brandCtx.reviews_link})`)
    expect(text).toContain('Bee Organized Boulder | beeorganized.com | (303) 555-0147')
    expect(text).not.toContain('<')
  })
})

// ── The compliance pin, end to end ──────────────────────────────────────────
describe('COMPLIANCE — what actually ships for a Closed-Job follow-up', () => {
  const TOKEN = 'a'.repeat(48)
  const queueSend = (key: string, body: string) => {
    h.enqueue('scheduled_stage_emails', {
      id: 'sched-1', lead_id: 'lead-1', stage_email_key: key, sent_at: null, cancelled_at: null,
    })
    h.enqueue('templates', { id: 'master-1', subject: 'We hope you love your space', body, name: key })
    h.enqueue('leads', {
      id: 'lead-1', name: 'John Doe', first_name: 'John', email: 'john@example.com',
      location_uuid: 'loc-1', assigned_to: null, marketing_opt_out: false,
    })
    h.enqueue('locations', {
      id: 'loc-1', name: 'Boulder', sender_name: 'Bee Boulder', phone: '(303) 555-0147',
      calendar_link: 'https://book.example.com/boulder?x=1&y=2',
      reviews_link: 'https://g.page/bee-organized-boulder/review',
      rate_per_hour: '95', city: 'Boulder', state: 'CO',
    })
    // ensureUnsubscribeToken's read — an existing token, so nothing is minted.
    h.enqueue('leads', { unsubscribe_token: TOKEN })
  }

  it.each(COMMERCIAL_STAGE_KEYS)(
    '%s ships branded with the real unsubscribe link + postal address inside the card',
    async (key) => {
      queueSend(key, '{{first_name}},\n\nWe hope you are still thrilled.\n\nBest,\n\n{{owner_name}}')
      const res = await sendStageEmail('sched-1')
      expect(res).toEqual({ sent: true })

      const { html, text } = sendEmailMock.mock.calls[0][0]
      const unsubUrl = `${APP_ORIGIN}/unsubscribe/${TOKEN}`
      expectBrandedChrome(html)
      expectFooterInsideCard(html, `href="${unsubUrl}"`, 'We hope you are still thrilled.')
      // The postal address and audience line are inside the card too.
      expect(html.indexOf(POSTAL)).toBeLessThan(html.indexOf(TEAL_BAND))
      expect(html.indexOf(POSTAL)).toBeGreaterThan(html.indexOf('We hope you are still thrilled.'))
      expect(html).toContain('because you&#39;re a Bee Organized client')
      expect(text).toContain("because you're a Bee Organized client")
      expect(text).toContain(`Unsubscribe at any time: ${unsubUrl}`)
      expect(text).toContain(POSTAL)
    },
  )

  it('no postal address → held, nothing sent', async () => {
    process.env.MARKETING_POSTAL_ADDRESS = ''
    queueSend('opp_closed_job_3mo', 'Hi {{first_name}}')
    const res = await sendStageEmail('sched-1')
    expect(res).toEqual({ sent: false, error: 'canspam_no_postal_address' })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('{{signature}} and the booking tag resolve through the branded path', async () => {
    queueSend(
      'opp_closed_job_12mo',
      'Hi {{first_name}},\n\nBook a refresh HERE ({{book_assessment_link}}).\n\nWarmly,\n{{signature}}',
    )
    const res = await sendStageEmail('sched-1')
    expect(res).toEqual({ sent: true })
    const { html, text } = sendEmailMock.mock.calls[0][0]
    // Signature block laid out once, in the body — above the footer and band.
    expect(html).toContain('Jane Smith')
    expect(html).toContain('Owner &amp; Lead Organizer')
    expect(html).not.toContain('{{signature}}')
    expect(html).not.toContain('bo-signature')
    expect(html.indexOf('Jane Smith')).toBeLessThan(html.indexOf('/unsubscribe/'))
    expect(text).toContain('Jane Smith\nOwner & Lead Organizer')
    // Booking link: clickable word.
    expect(html).toContain('<a href="https://book.example.com/boulder?x=1&amp;y=2"')
    expect(html).toMatch(/>HERE<\/a>/)
  })
})

// ── Drips are unchanged ─────────────────────────────────────────────────────
describe('drips are byte-identical to before the footer slot existed', () => {
  // SHA-256 of buildBrandedDripHtml / buildBrandedDripText for this exact input,
  // recorded on d4e99c5 BEFORE the card-footer slot was added.
  it('same output, byte for byte', () => {
    const body = 'Hi John,\n\nClick HERE (https://book.example.com/s?a=1&b=2) to book.\n\nThanks,\n\nSarah'
    const ctx = { location_name: 'Boulder', location_phone: '(303) 555-0147', reviews_link: 'https://g.page/r' }
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    expect(sha(buildBrandedDripHtml(body, ctx))).toBe(
      '2ccb28fcb2afe51dff02929f8e29639782542b69b825b368d18fa09118992e76',
    )
    expect(sha(buildBrandedDripText(body, ctx))).toBe(
      '3b9d0e5b8a968c165ed27212cf0100f47512d861455a7d498593546731568eed',
    )
    expect(buildBrandedDripHtml(body, ctx)).not.toContain('bo-card-footer')
  })

  it('the drip send site passes no footer', () => {
    const src = readFileSync(join(__dirname, 'drip-send.ts'), 'utf8')
    expect(src).toMatch(/buildBrandedDripHtml\(rendered\.body, \{ \.\.\.ctx, signature \}\)/)
    expect(src).toMatch(/buildBrandedDripText\(rendered\.body, \{ \.\.\.ctx, signature \}\)/)
  })
})

// ── Follow-ups unchanged by the welcome move ────────────────────────────────
describe('the Closed-Job follow-ups are byte-identical to 5656a86', () => {
  // SHA-256 recorded on 5656a86, before the welcome moved to the branded layout.
  it('same output, byte for byte', () => {
    const body = 'Hi John,\n\nClick HERE (https://book.example.com/s?a=1&b=2) to book.\n\nThanks,\n\nSarah'
    const ctx = { location_name: 'Boulder', location_phone: '(303) 555-0147', reviews_link: 'https://g.page/r' }
    const r = renderStageEmailContent('opp_closed_job_3mo', body, ctx, { html: '<div>FOOTER</div>', text: 'FOOTER' })
    const sha = (s: string) => createHash('sha256').update(s).digest('hex')
    expect(sha(r.html)).toBe('2cd4623a2bb9cf3230917d27caae1ae9f00e8839a056a5502572f31aec58eeea')
    expect(sha(r.text)).toBe('ddf4cf2733ab65db098ef5f4750fe1823629b079107a22754b70f82d956faf6f')
  })
})

// ── Welcome: branded, footer in the card ────────────────────────────────────
describe('welcome-email render path — branded layout, footer in the card', () => {
  // REVERSED ON PURPOSE, 2026-09-28. Until then this block pinned the OPPOSITE:
  // "builds its base HTML via the plain bodyToHtml path" and "does not import
  // the branded layout". Those guarded a real rule — never put branded chrome on
  // a commercial email that has no CAN-SPAM footer — and the rule's condition
  // no longer holds: #115 gave welcome its footer. Kevin asked for the welcome
  // to be branded. The guard is not dropped, it is flipped: welcome must now
  // use the branded layout, must NOT fall back to the plain path, and must keep
  // its footer (placement is pinned end-to-end, on Kevin's live copy, in
  // lib/beta-welcome-master-template.test.ts).
  const src = readFileSync(join(__dirname, 'welcome-email.ts'), 'utf8')

  it('welcome-email.ts renders through the branded layout, not the plain bodyToHtml path', () => {
    expect(src).toMatch(/from '\.\/drip-email-layout'/)
    expect(src).toMatch(/buildBrandedDripHtml\(renderedBody, brandCtx, canSpamFooter\)/)
    expect(/bodyToHtml\(/.test(src)).toBe(false)
  })

  it('welcome-email.ts builds the #115 CAN-SPAM footer and places it, not appends it', () => {
    expect(src).toContain('buildCanSpamFooter')
    expect(src).not.toContain('appendCanSpamFooter(')
  })
})

describe('welcome refuses to render without its footer (fail closed)', () => {
  it('no footer → throws; with a footer → branded, footer in the card', async () => {
    const { renderWelcomeEmailContent } = await import('@/lib/welcome-email')
    expect(() => renderWelcomeEmailContent(RENDERED_BODY, brandCtx, null)).toThrow(/CAN-SPAM/)
    expect(() => renderWelcomeEmailContent(RENDERED_BODY, brandCtx, undefined)).toThrow(/CAN-SPAM/)
    const { html } = renderWelcomeEmailContent(RENDERED_BODY, brandCtx, STAND_IN_FOOTER)
    expectBrandedChrome(html)
    expectFooterInsideCard(html, 'data-test="canspam"', 'Sarah Mitchell')
  })
})
