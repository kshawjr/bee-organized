// #114 — the branded-wrapper split for opportunity-stage emails.
//
// renderStageEmailContent (lib/stage-emails.ts) decides which of the six stage
// templates gets the #90 Bee Organized branded wrapper. This suite pins that
// split so a future edit can't silently:
//   - drop the wrapper off a transactional estimate follow-up, or
//   - slip the wrapper onto a footer-less COMMERCIAL email (welcome /
//     opp_closed_job_*), which would fake an official footer before #115 ships
//     the real postal-address + unsubscribe one.
//
// The CAN-SPAM tripwire hashes seed BODIES and so is blind to this HTML-layer
// change (see beta-drip-canspam-tripwire.test.ts) — this file is the guard.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// stage-emails.ts pulls in the service-role client at module load; it never
// runs in these pure-render tests, so a bare stub is enough.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))

import { renderStageEmailContent } from '@/lib/stage-emails'
import { bodyToHtml } from '@/lib/drip-send'
import {
  DRIP_BRAND_TEAL,
  DRIP_WEBSITE_LABEL,
  DRIP_LOGO_PATH,
  REVIEWS_LINE_TEXT,
} from '@/lib/drip-email-layout'

// The logo URL is built from the app origin at render time — pin one so the
// branded HTML is deterministic; restore afterward.
const APP_ORIGIN = 'https://beehive.beeorganized.com'
const savedEnv = { app: process.env.NEXT_PUBLIC_APP_URL, site: process.env.NEXT_PUBLIC_SITE_URL }
beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN
})
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = savedEnv.app
  process.env.NEXT_PUBLIC_SITE_URL = savedEnv.site
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

// A fully-rendered estimate follow-up: tokens already substituted, booking CTA
// in the corpus's "word (url)" form with a query string, no in-body reviews line.
const RENDERED_ESTIMATE_BODY = `Hi John,

Just following up on the estimate for your project. Click HERE (https://book.example.com/sarah?ref=a&b=2) to pick a time.

Our rate starts at $95 per hour per Bee.

Thank you,

Sarah Mitchell`

describe('#114 stage-email wrapper — transactional estimate follow-ups are branded', () => {
  it.each(ESTIMATE_KEYS)('%s renders inside the branded wrapper', (key) => {
    const { html } = renderStageEmailContent(key, RENDERED_ESTIMATE_BODY, brandCtx)
    // Branded chrome present…
    expect(html).toContain('role="presentation"')
    expect(html).toContain('max-width:600px')
    expect(html).toContain('BEE ORGANIZED')
    expect(html).toContain('Simplify Your Hive')
    expect(html).toContain(`${APP_ORIGIN}${DRIP_LOGO_PATH}`)
    // …and the teal footer band with name / website / phone.
    expect(html).toContain(`bgcolor="${DRIP_BRAND_TEAL}"`)
    expect(html).toContain('Bee Organized Boulder')
    expect(html).toContain(DRIP_WEBSITE_LABEL)
    expect(html).toContain('(303) 555-0147')
    // …and is NOT the plain unbranded path.
    expect(html).not.toBe(bodyToHtml(RENDERED_ESTIMATE_BODY))
  })

  it('tokens resolve, the booking link is clickable, and the plain-text alternative matches', () => {
    const { html, text } = renderStageEmailContent(
      ESTIMATE_KEYS[0],
      RENDERED_ESTIMATE_BODY,
      brandCtx,
    )
    // Rendered token values survive into the HTML (no raw {{token}} left).
    for (const needle of ['John', '$95 per hour', 'Sarah Mitchell']) {
      expect(html).toContain(needle)
    }
    expect(html).not.toMatch(/\{\{[a-z_]+\}\}/)
    // Booking CTA is a working link on the word, URL hidden, & encoded.
    expect(html).toContain('<a href="https://book.example.com/sarah?ref=a&amp;b=2"')
    expect(html).toMatch(/>HERE<\/a>/)
    // No in-body reviews line → the wrapper injects one, linked, exactly once.
    expect(html.split(`href="${brandCtx.reviews_link}"`).length - 1).toBe(1)
    // Plain-text alternative: carries the wordmark + footer band, keeps the
    // visible URL, and contains no HTML.
    expect(text).toContain('BEE ORGANIZED — Simplify Your Hive')
    expect(text).toContain('Bee Organized Boulder | beeorganized.com | (303) 555-0147')
    expect(text).toContain('Click HERE (https://book.example.com/sarah?ref=a&b=2)')
    expect(text).toContain(`${REVIEWS_LINE_TEXT} (${brandCtx.reviews_link})`)
    expect(text).not.toContain('<')
  })
})

describe('#114 stage-email wrapper — commercial closed-job templates stay unbranded (byte-identical)', () => {
  it.each(COMMERCIAL_STAGE_KEYS)(
    '%s is rendered by the plain bodyToHtml path, not the wrapper',
    (key) => {
      const { html, text } = renderStageEmailContent(key, RENDERED_ESTIMATE_BODY, brandCtx)
      // Byte-identical to the pre-#114 path: bodyToHtml for html, raw body for text.
      expect(html).toBe(bodyToHtml(RENDERED_ESTIMATE_BODY))
      expect(text).toBe(RENDERED_ESTIMATE_BODY)
      // No branded chrome leaked in.
      expect(html).not.toContain('BEE ORGANIZED')
      expect(html).not.toContain(`bgcolor="${DRIP_BRAND_TEAL}"`)
      expect(html).not.toContain(DRIP_WEBSITE_LABEL)
    },
  )
})

describe('#114 stage-email wrapper — welcome-email stays byte-identical (untouched path)', () => {
  // welcome is COMMERCIAL and never routes through renderStageEmailContent; it
  // renders in lib/welcome-email.ts via the plain bodyToHtml path. Guard that
  // that module still uses bodyToHtml and never adopts the branded wrapper, so
  // welcome output remains byte-identical to before #114.
  const src = readFileSync(join(__dirname, 'welcome-email.ts'), 'utf8')

  it('welcome-email.ts renders via bodyToHtml with the raw body as the text alternative', () => {
    expect(src).toContain('const html = bodyToHtml(rendered.body)')
    expect(src).toContain('text: rendered.body')
  })

  it('welcome-email.ts does not import or call the branded drip wrapper', () => {
    expect(/buildBrandedDrip|drip-email-layout/.test(src)).toBe(false)
  })
})
