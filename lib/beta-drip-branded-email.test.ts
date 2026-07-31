// #90 — the Bee Organized branded drip wrapper. Pins the guarantees that keep
// a franchisee's client from seeing a broken email: every token still resolves
// through the wrapper, the booking CTA and reviews line are working links, the
// footer band carries name/website/phone, the plain-text alternative matches,
// and a missing optional token degrades to nothing rather than a raw {{token}}.

import { describe, it, expect } from 'vitest'
import { afterEach, beforeEach } from 'vitest'
import {
  buildBrandedDripHtml,
  buildBrandedDripText,
  linkifyLine,
  resolveDripLogoUrl,
  DRIP_LOGO_PATH,
  DRIP_BRAND_TEAL,
  DRIP_WEBSITE_URL,
  DRIP_WEBSITE_LABEL,
  REVIEWS_LINE_TEXT,
} from './drip-email-layout'

// The self-hosted logo URL is built from the app origin at render time. Pin a
// known origin for the tests so the src is deterministic; restore afterwards.
const APP_ORIGIN = 'https://beehive.beeorganized.com'
const savedEnv = { app: process.env.NEXT_PUBLIC_APP_URL, site: process.env.NEXT_PUBLIC_SITE_URL }
beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP_ORIGIN
})
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = savedEnv.app
  process.env.NEXT_PUBLIC_SITE_URL = savedEnv.site
})

const ctx = {
  location_name: 'Boulder',
  location_phone: '(303) 555-0147',
  reviews_link: 'https://g.page/bee-organized-boulder/review',
}

// A rendered step-1 body: tokens already substituted, in-body reviews line
// present, booking CTA in the corpus's "word (url)" form, a query-string URL.
const BODY_WITH_REVIEWS = `Hello John, thank you for reaching out!

Please click HERE (https://book.example.com/sarah?ref=a&b=2) to select a day and time.

Our rate starts at $95 per hour per Bee.

Thank you,

Sarah Mitchell

Be sure to check out our Google Reviews! (https://g.page/bee-organized-boulder/review)`

// A rendered step-3 body: NO in-body reviews line.
const BODY_NO_REVIEWS = `Hi John,

Still interested? Click here (https://book.example.com/sarah) to select a time. Or call or text me at (303) 555-0147.

Thank you,

Sarah Mitchell`

describe('branded drip wrapper — chrome', () => {
  it('embeds the self-hosted logo as an absolute HTTPS URL off the app origin, real alt text (not a data URI / CDN hot-link)', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    const expectedUrl = `${APP_ORIGIN}${DRIP_LOGO_PATH}`
    expect(html).toContain(`src="${expectedUrl}"`)
    expect(expectedUrl.startsWith('https://')).toBe(true)
    // Self-hosted: never the third-party Shopify CDN, never a data URI.
    expect(html).not.toContain('data:image')
    expect(html).not.toContain('cdn/shop')
    expect(html).not.toContain('beeorganized.com/cdn')
    expect(html).toMatch(/alt="Bee Organized"/)
  })

  it('resolveDripLogoUrl: NEXT_PUBLIC_APP_URL wins, trailing slash trimmed, falls back to SITE_URL then the bare path', () => {
    expect(resolveDripLogoUrl({ NEXT_PUBLIC_APP_URL: 'https://a.example.com/' } as any)).toBe(
      `https://a.example.com${DRIP_LOGO_PATH}`,
    )
    expect(resolveDripLogoUrl({ NEXT_PUBLIC_SITE_URL: 'https://b.example.com' } as any)).toBe(
      `https://b.example.com${DRIP_LOGO_PATH}`,
    )
    // Neither set → root-relative path, never a third-party CDN.
    expect(resolveDripLogoUrl({} as any)).toBe(DRIP_LOGO_PATH)
  })

  it('is table-based with the wordmark and a max-width single column', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    expect(html).toContain('role="presentation"')
    expect(html).toContain('max-width:600px')
    expect(html).toContain('BEE ORGANIZED')
    expect(html).toContain('Simplify Your Hive')
    // Body copy at 16px for the 45-65 audience.
    expect(html).toContain('font-size:16px')
  })

  it('declares color-scheme + a dark-mode guard that pins the card white', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    expect(html).toContain('color-scheme')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('.bo-card')
  })
})

describe('branded drip wrapper — footer band', () => {
  it('renders "Bee Organized <name> | beeorganized.com | <phone>" in the brand teal', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    expect(html).toContain(`bgcolor="${DRIP_BRAND_TEAL}"`)
    expect(html).toContain('Bee Organized Boulder')
    expect(html).toContain('(303) 555-0147')
    // Website: shown without the scheme, linked to the full URL, hardcoded.
    expect(html).toContain(`href="${DRIP_WEBSITE_URL}"`)
    expect(html).toContain(`>${DRIP_WEBSITE_LABEL}<`)
  })

  it('the band uses a dark brand color that carries white text', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    // White text sits on the teal band.
    const bandMatch = html.match(/bgcolor="#054E4A"[^>]*color:#ffffff/)
    expect(bandMatch).toBeTruthy()
  })
})

describe('branded drip wrapper — links', () => {
  it('renders the booking CTA as a working link on the word, URL hidden, & encoded', () => {
    const html = buildBrandedDripHtml(BODY_WITH_REVIEWS, ctx)
    expect(html).toContain(
      '<a href="https://book.example.com/sarah?ref=a&amp;b=2"',
    )
    expect(html).toMatch(/>HERE<\/a>/)
    // The raw parenthesised URL must not survive as visible text.
    expect(html).not.toContain('(https://book.example.com/sarah?ref=a')
  })

  it('renders the reviews line as a working link', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    expect(html).toContain(
      `<a href="${ctx.reviews_link}" style="color:${DRIP_BRAND_TEAL};text-decoration:underline;">${REVIEWS_LINE_TEXT}</a>`,
    )
  })

  it('does NOT duplicate the reviews line when the body already carries it', () => {
    const html = buildBrandedDripHtml(BODY_WITH_REVIEWS, ctx)
    // Exactly one anchor points at the reviews link.
    const occurrences = html.split(`href="${ctx.reviews_link}"`).length - 1
    expect(occurrences).toBe(1)
  })

  it('injects the reviews line when the body lacks it', () => {
    const html = buildBrandedDripHtml(BODY_NO_REVIEWS, ctx)
    const occurrences = html.split(`href="${ctx.reviews_link}"`).length - 1
    expect(occurrences).toBe(1)
  })

  it('linkifyLine: leaves a parenthesised phone number untouched', () => {
    const out = linkifyLine('call or text me at (303) 555-0147')
    expect(out).toBe('call or text me at (303) 555-0147')
  })

  it('linkifyLine: linkifies a bare URL in place', () => {
    const out = linkifyLine('Take the quiz: https://beeorganized.com/quiz/')
    expect(out).toContain('<a href="https://beeorganized.com/quiz/"')
    expect(out).toContain('>https://beeorganized.com/quiz/</a>')
  })
})

describe('branded drip wrapper — token safety & degradation', () => {
  it('every rendered token value passes through to the HTML unchanged', () => {
    // Simulate a fully-rendered body containing values from all the drip tokens.
    const body = [
      'Hi John,', // first_name
      'Rate is $95 per hour.', // rate_per_hour
      'Book HERE (https://book.example.com/x).', // book_assessment_link
      'Call (303) 555-0147.', // location_phone
      'Thank you, Sarah Mitchell', // owner_name
    ].join('\n\n')
    const html = buildBrandedDripHtml(body, ctx)
    for (const needle of ['John', '$95 per hour', 'Sarah Mitchell', 'Book']) {
      expect(html).toContain(needle)
    }
  })

  it('never emits a raw {{token}} — an empty optional token degrades to nothing', () => {
    // book_assessment_link resolved to '' → body shows "click HERE ()" (never {{...}}).
    const body = 'Please click HERE () to book.'
    const html = buildBrandedDripHtml(body, {
      location_name: 'Boulder',
      location_phone: null,
      reviews_link: null,
    })
    expect(html).not.toMatch(/\{\{[a-z_]+\}\}/)
    // No reviews_link → no injected reviews line, no broken anchor.
    expect(html).not.toContain('href=""')
    expect(html).not.toContain(REVIEWS_LINE_TEXT)
  })

  it('footer degrades cleanly when name/phone are blank', () => {
    const html = buildBrandedDripHtml('Hi.', {
      location_name: null,
      location_phone: null,
      reviews_link: null,
    })
    // Just "Bee Organized | beeorganized.com" — the separator precedes the
    // website link, and there is no doubled/trailing separator (no empty
    // name or phone segment).
    expect(html).toContain('Bee Organized&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://beeorganized.com"')
    expect(html).not.toMatch(/\|\s*\|/)
    // Nothing after the website link: no trailing separator + phone segment.
    expect(html).not.toContain(`${DRIP_WEBSITE_LABEL}</a>&nbsp;&nbsp;|`)
  })
})

describe('branded drip wrapper — plain text alternative', () => {
  it('is present, matches, and carries the footer band', () => {
    const text = buildBrandedDripText(BODY_WITH_REVIEWS, ctx)
    expect(text).toContain('BEE ORGANIZED — Simplify Your Hive')
    expect(text).toContain('Bee Organized Boulder | beeorganized.com | (303) 555-0147')
    // Body copy survives verbatim (plain text keeps visible URLs).
    expect(text).toContain('Please click HERE (https://book.example.com/sarah?ref=a&b=2)')
    // Contains no HTML.
    expect(text).not.toContain('<')
  })

  it('injects the reviews line in text when the body lacks it, once', () => {
    const text = buildBrandedDripText(BODY_NO_REVIEWS, ctx)
    const occurrences = text.split(REVIEWS_LINE_TEXT).length - 1
    expect(occurrences).toBe(1)
    expect(text).toContain(`${REVIEWS_LINE_TEXT} (${ctx.reviews_link})`)
  })

  it('does not duplicate the reviews line in text when the body already carries it', () => {
    const text = buildBrandedDripText(BODY_WITH_REVIEWS, ctx)
    const occurrences = text.split(REVIEWS_LINE_TEXT).length - 1
    expect(occurrences).toBe(1)
  })
})
