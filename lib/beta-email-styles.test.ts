// lib/beta-email-styles.test.ts
//
// The five styles (Settings → Emails → Look, 2026-10-30), the designer's
// layout they share, and the pieces around them. Exactly the export's values
// (its src/lib/email-html.ts) — see lib/drip-email-layout.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The render functions are pure; their modules also hold the senders, which
// import the database client. Nothing here touches it.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: () => { throw new Error('no db in this test') } } }))
vi.mock('@/lib/resend', () => ({ sendEmail: vi.fn(), renderTemplate: vi.fn() }))
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildBrandedDripHtml, buildBrandedDripText, buildBrandedShellHtml, EMAIL_STYLES, normalizeEmailStyle,
} from './drip-email-layout'
import { stripTaggedSentences, applyEmailSwitches, RATE_TAG, BOOKING_LINK_TAGS } from './email-switches'
import { renderWelcomeEmailContent } from './welcome-email'
import { renderStageEmailContent } from './stage-emails'
import { timingFromStored, timingToStored, formatTiming, timingLabel } from './email-timing'

const APP = 'https://beehive.beeorganized.com'
const saved = { app: process.env.NEXT_PUBLIC_APP_URL, site: process.env.NEXT_PUBLIC_SITE_URL }
beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = APP })
afterEach(() => { process.env.NEXT_PUBLIC_APP_URL = saved.app; process.env.NEXT_PUBLIC_SITE_URL = saved.site })

const ctx = { location_name: 'Boulder', location_phone: '(303) 555-0147', reviews_link: null, heading: 'Thank you for reaching out!', button: { label: 'Book a Discovery Call', href: 'https://cal.example.com/x' } }
const BODY = 'Jordan,\n\nThank you for reaching out!'
const html = (style?: string | null) => buildBrandedDripHtml(BODY, { ...ctx, style })
const buttonCell = (h: string) => h.slice(h.indexOf('<tr><td align="center" bgcolor='), h.indexOf('</a>', h.indexOf('<tr><td align="center" bgcolor=')))

describe('Soft is everyone’s look until they pick another (Kevin, 2026-10-30)', () => {
  it('no style, an unknown style and "soft" render the same email, byte for byte', () => {
    expect(html(undefined)).toBe(html('soft'))
    expect(html(null)).toBe(html('soft'))
    expect(html('neon')).toBe(html('soft'))
    expect(normalizeEmailStyle(undefined)).toBe('soft')
  })
})

// The brief's table, verbatim.
const TABLE: Record<string, { bg: string; text: string; border: string; radius: number; caps: boolean }> = {
  soft:    { bg: '#A8C9C4', text: '#3A3C39', border: '#A8C9C4', radius: 10, caps: true },
  outline: { bg: '#FFFFFF', text: '#4A4C49', border: '#A8C9C4', radius: 10, caps: true },
  bold:    { bg: '#60625F', text: '#FFFFFF', border: '#60625F', radius: 10, caps: true },
  rounded: { bg: '#A8C9C4', text: '#3A3C39', border: '#A8C9C4', radius: 30, caps: false },
  classic: { bg: '#FFFFFF', text: '#60625F', border: '#C99B50', radius: 10, caps: true },
}

describe('each of the five styles produces its documented button', () => {
  it('there are exactly five, in the design’s order', () => {
    expect(EMAIL_STYLES.map(s => s.id)).toEqual(['soft', 'outline', 'bold', 'rounded', 'classic'])
  })
  for (const [id, t] of Object.entries(TABLE)) {
    it(`${id}: ${t.bg} / ${t.text} / ${t.border} border / ${t.radius}px / ${t.caps ? 'uppercase 15px 2px' : 'sentence case 17px 0.5px'}`, () => {
      const cell = buttonCell(html(id))
      expect(cell).toContain(`bgcolor="${t.bg}" style="background-color:${t.bg};border:2px solid ${t.border};border-radius:${t.radius}px;"`)
      expect(cell).toContain(`color:${t.text};`)
      expect(cell).toContain(t.caps
        ? 'font-size:15px;font-weight:500;letter-spacing:2px;text-transform:uppercase;'
        : 'font-size:17px;font-weight:500;letter-spacing:0.5px;text-transform:none;')
      expect(cell).toContain('>Book a Discovery Call')
    })
  }
})

describe('Rounded repeats the band at the bottom — as a real, already-flipped image', () => {
  it('a second image file, below the card content; no CSS transform anywhere (Outlook ignores them)', () => {
    const h = html('rounded')
    expect(h).toContain(`<img src="${APP}/email-honeycomb-footer.png"`)
    expect(h.indexOf('email-honeycomb-footer.png')).toBeGreaterThan(h.indexOf('>Book a Discovery Call'))
    for (const id of Object.keys(TABLE)) expect(html(id)).not.toMatch(/(?<!text-)transform\s*:/i)   // text-transform (caps) is fine
    for (const id of ['soft', 'outline', 'bold', 'classic']) expect(html(id)).not.toContain('email-honeycomb-footer.png')
  })
  it('the flipped file is shipped, the same size as the band, and is not the band itself', () => {
    const pub = (f: string) => join(process.cwd(), 'public', f)
    const a = readFileSync(pub('email-honeycomb-header.png'))
    const b = readFileSync(pub('email-honeycomb-footer.png'))
    // PNG IHDR: width and height at bytes 16–23.
    expect(b.subarray(16, 24).equals(a.subarray(16, 24))).toBe(true)
    expect(a.equals(b)).toBe(false)
    expect(statSync(pub('email-honeycomb-footer.png')).size).toBeGreaterThan(1000)
  })
})

describe('Classic swaps the script heading for Arvo', () => {
  it('Arvo 30px in #7FA8A2, and no script face', () => {
    const h = html('classic')
    expect(h).toContain(`<h1 style="margin:0 0 14px 0;font-family:Arvo, Georgia, 'Times New Roman', serif;font-size:30px;line-height:40px;font-weight:400;letter-spacing:1px;color:#7FA8A2;text-align:center;">Thank you for reaching out!</h1>`)
    expect(h).not.toContain('font-family:Corinthia')
  })
  it('every other style keeps the gold script heading', () => {
    for (const id of ['soft', 'outline', 'bold', 'rounded']) {
      expect(html(id)).toContain(`font-family:Corinthia, 'Brush Script MT', cursive;font-size:46px;line-height:56px;font-weight:400;color:#C99B50;`)
    }
  })
})

describe('images come from our own domain — never the export’s hosts', () => {
  it('honeycomb and logo on beehive.beeorganized.com; no Lovable preview, no Shopify CDN', () => {
    const h = html('rounded')
    expect(h).toContain(`${APP}/email-honeycomb-header.png`)
    expect(h).toContain(`${APP}/bee-organized-logo.png`)
    expect(h).not.toMatch(/lovable|cdn\/shop|shopify/i)
  })
})

describe('the style applies to every client email type, not only drips', () => {
  const FOOT = { html: '<p>unsubscribe</p>', text: 'unsubscribe' }
  it('the welcome renders in the location’s style', () => {
    const { html: h } = renderWelcomeEmailContent(BODY, { ...ctx, style: 'classic' }, FOOT)
    expect(h).toContain('font-family:Arvo')
    expect(h).toContain('border:2px solid #C99B50')
  })
  it('the job follow-ups and the estimate follow-ups render in the location’s style', () => {
    for (const key of ['opp_closed_job_3mo', 'opp_closed_job_12mo', 'opp_organizing_estimate_3d']) {
      const { html: h } = renderStageEmailContent(key, BODY, { ...ctx, style: 'bold' }, FOOT)
      expect(h, key).toContain('bgcolor="#60625F"')
    }
  })
  it('all three senders hand the location’s style and the subject heading to the layout', () => {
    const src = (f: string) => readFileSync(join(process.cwd(), 'lib', f), 'utf8')
    expect(src('drip-send.ts')).toMatch(/style: emailOptions\.style,\s*heading: rendered\.subject,/)
    expect(src('welcome-email.ts')).toMatch(/style: emailOptions\.style,\s*heading: rendered\.subject,/)
    expect(src('stage-emails.ts')).toMatch(/style: emailOptions\.style,\s*heading: rendered\.subject,/)
  })
  it('owner-facing mail shares the same shell (one layout, never forked)', () => {
    const h = buildBrandedShellHtml('<p>x</p>', 'Bee Organized')
    expect(h).toContain('email-honeycomb-header.png')
    expect(h).not.toContain('<h1')
  })
})

describe('the text half matches the HTML', () => {
  it('heading and button appear in the plain-text alternative', () => {
    const t = buildBrandedDripText(BODY, { ...ctx, style: 'soft' })
    expect(t.startsWith('BEE ORGANIZED\n\nThank you for reaching out!\n\n')).toBe(true)
    expect(t).toContain('BOOK A DISCOVERY CALL:\nhttps://cal.example.com/x')
  })
  it('a non-web button link is dropped, never rendered', () => {
    const h = buildBrandedDripHtml(BODY, { ...ctx, button: { label: 'x', href: 'javascript:alert(1)' } })
    expect(h).not.toContain('javascript:')
    expect(h).not.toContain('target="_blank"')
  })
})

describe('"I don’t show rates" / "I don’t use booking links" — the sentence rule', () => {
  const MASTER = 'Following the assessment, we\'ll be able to provide an estimate of time and associated costs. Our rate starts at {{rate_per_hour}} per hour per Bee. We will source and bring recommended products.'
  it('takes the price sentence out of the first email and the paragraph still reads', () => {
    expect(stripTaggedSentences(MASTER, [RATE_TAG])).toBe('Following the assessment, we\'ll be able to provide an estimate of time and associated costs. We will source and bring recommended products.')
  })
  it('a paragraph that was only the price goes, with its blank line', () => {
    expect(stripTaggedSentences('Hi,\n\nOur rate is {{rate_per_hour}}.\n\nThanks', [RATE_TAG])).toBe('Hi,\n\nThanks')
  })
  it('a dot inside a link or a price never splits a sentence', () => {
    expect(stripTaggedSentences('See beeorganized.com today. Our rate is {{rate_per_hour}}.', [RATE_TAG])).toBe('See beeorganized.com today.')
  })
  it('only the first email (and the welcome) are rewritten; any other is skipped', () => {
    const opts = { showsHourlyRate: false, usesBookingLinks: true }
    expect(applyEmailSwitches({ alwaysSends: false, options: opts, subject: 's', body: MASTER, buttonLink: null })).toEqual({ action: 'skip', reason: 'rate_not_shown' })
    expect(applyEmailSwitches({ alwaysSends: true, options: opts, subject: 's', body: MASTER, buttonLink: null })).toMatchObject({ action: 'send', changed: true })
  })
  it('with both switches on, nothing changes', () => {
    const d = applyEmailSwitches({ alwaysSends: false, options: { showsHourlyRate: true, usesBookingLinks: true }, subject: 's', body: MASTER, buttonLink: '{{booking_link}}' })
    expect(d).toEqual({ action: 'send', subject: 's', body: MASTER, buttonLink: '{{booking_link}}', changed: false })
  })
  it('links off: the first email loses its booking sentence AND its link button', () => {
    const d = applyEmailSwitches({ alwaysSends: true, options: { showsHourlyRate: true, usesBookingLinks: false }, subject: 's', body: 'Hi.\n\nBook here ({{booking_link}}). Talk soon.', buttonLink: '{{booking_link}}' })
    expect(d).toMatchObject({ action: 'send', body: 'Hi.\n\nTalk soon.', buttonLink: null })
    expect(BOOKING_LINK_TAGS).toContain('{{discovery_booking_link}}')
  })
})

describe('timing in days, months and years', () => {
  it('a months or years timing reads back as written; days as before', () => {
    expect(timingLabel(90, 'months')).toBe('3 months later')
    expect(timingLabel(30, 'months')).toBe('A month later')
    expect(timingLabel(730, 'years')).toBe('2 years later')
    expect(timingLabel(30, null)).toBe('Day 30')        // never rewritten as "A month later"
    expect(timingLabel(1, null)).toBe('Next day')
    expect(timingLabel(0, null)).toBe('Right away')
  })
  it('round-trips through what is stored', () => {
    for (const t of [{ immediate: false, n: 3, unit: 'months' as const }, { immediate: false, n: 1, unit: 'years' as const }, { immediate: false, n: 12, unit: 'days' as const }]) {
      const s = timingToStored(t)
      expect(timingFromStored(s.delay_days, s.delay_unit)).toEqual(t)
      expect(formatTiming(timingFromStored(s.delay_days, s.delay_unit))).toBe(formatTiming(t))
    }
  })
  it('a unit whose days no longer divide falls back to the real day', () => {
    expect(timingLabel(95, 'months')).toBe('Day 95')
  })
})
