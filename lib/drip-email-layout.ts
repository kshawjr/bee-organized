// lib/drip-email-layout.ts
// ─────────────────────────────────────────────────────────────
// #90 — the Bee Organized branded wrapper for DRIP client emails.
//
// Drips go to franchisees' own clients; the audience skews 45-65, so this
// wrapper prioritises legibility over density: single column, ~600px, 16px
// body copy at generous line-height. Since 2026-10-30 the look is the
// designer's: honeycomb band, gold bee logo + wordmark, script heading, and one
// of five button styles chosen per location (EMAIL_STYLES below).
//
// SCOPE: every automated client email — drips, all six opportunity-stage
// emails (lib/stage-emails.ts — the four estimate follow-ups AND the two
// commercial Closed-Job follow-ups), and the welcome (lib/welcome-email.ts) —
// plus the shell alone for lead notifications + feedback replies. The old
// plain bodyToHtml path (lib/drip-send.ts) no longer has a sending caller.
//
// COMPLIANCE SLOT: a commercial email's CAN-SPAM footer (unsubscribe + postal
// address) must sit INSIDE the white card, as its last row. Appending it to
// the finished document would land it after </html>, outside the frame. The
// caller passes it as `cardFooterHtml`; with no footer passed there is no
// such row (drips never pass one).
//
// EMAIL-CLIENT CONSTRAINTS (not optional): table-based layout, every style
// inline (Gmail strips <style>), no flexbox/grid (Outlook). A single <style>
// block carries ONLY the dark-mode guard, which is a progressive enhancement
// — the email is fully correct without it.
//
// TOKENS: this module never sees {{tokens}}. It receives the ALREADY-RENDERED
// body text (tokens substituted by renderTemplate) plus the resolved
// location_name / location_phone / reviews_link values for the chrome. It
// does not re-render, convert, or add tokens.
// ─────────────────────────────────────────────────────────────

// escHtml / escAttr moved to lib/email-escape.ts (so lib/email-signature.ts
// can share them without a circular import) and are re-exported here.
import { escHtml, escAttr } from './email-escape'
import { displayPhone } from './phone'
import { htmlWithSignature, textWithSignature, safeHttpUrl, SIGNATURE_MARKER, type EmailSignature } from './email-signature'
export { escHtml, escAttr }

// The gold bee mark — the SAME transparent PNG the brand site uses, but
// SELF-HOSTED in this app's public/ dir rather than hot-linked off
// beeorganized.com's Shopify CDN. Mail clients re-fetch the logo on every open,
// so a hot-link would break every drip ever sent (including ones already in
// inboxes) the day the site is redesigned or the CDN path changes. Serving it
// from our own stable origin removes that dependency.
//
// Absolute HTTPS (built from the app origin below), not an attachment or data
// URI, per #90. Transparent background means it survives a client's dark-mode
// inversion (gold-on-dark stays visible) rather than becoming a gold bee
// trapped on a white tile.
export const DRIP_LOGO_PATH = '/bee-organized-logo.png'

// Build the absolute logo URL from the app origin. NEXT_PUBLIC_APP_URL is the
// stable, non-SSO custom domain (see lib/internal-origin.ts); NEXT_PUBLIC_SITE_URL
// is the same domain under an alternate key. Email needs an ABSOLUTE url, so if
// neither is set we fall back to the root-relative path — it won't load in a
// mail client (the alt text + wordmark still render), but it never resurrects a
// third-party CDN dependency. Resolved at render time so a deploy that sets the
// env doesn't require a rebuild of this constant.
export function resolveDripLogoUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
  return base ? `${base}${DRIP_LOGO_PATH}` : DRIP_LOGO_PATH
}

// Brand teal = ui/tokens GREEN_FILL. No longer painted in client email (the
// teal band went with the 2026-10-30 redesign); kept because other screens and
// tests still import it by name.
export const DRIP_BRAND_TEAL = '#054E4A'
// Gold-hued ink that passes on white (tokens brand.goldFill).
export const DRIP_BRAND_GOLD_INK = '#8C6421'

// Website is NOT per-location — every location shares this. Hardcoded per #90:
// no locations.website column, no {{location_website}} token. Displayed without
// the scheme, linked to the full URL.
export const DRIP_WEBSITE_URL = 'https://beeorganized.com'
export const DRIP_WEBSITE_LABEL = 'beeorganized.com'

// The standalone reviews line copy — matches the wording already used in the
// master template bodies so the two never read differently.
export const REVIEWS_LINE_TEXT = 'Be sure to check out our Google Reviews!'

// ── THE FIVE STYLES (Settings → Emails → Look, 2026-10-30) ─────────────────
// Taken exactly from the designer's export (its src/lib/email-html.ts). One
// layout; the style is a parameter of it, never a second layout. Every client
// email — drips, the welcome, the job follow-ups — goes through
// buildBrandedShellHtml, so a location's style reaches all of them.
//
// Kevin's ruling 2026-10-30: Soft is the default and EVERY location is on it
// from the day this ships (a NULL locations.email_style is Soft).
//
// Two styles change more than the button:
//   rounded  repeats the honeycomb band under the card, upside down. The
//            export flipped it with transform:scaleY(-1), which Outlook
//            ignores (the band would sit the right way up). So it is a
//            SECOND IMAGE FILE, already flipped: public/email-honeycomb-footer.png.
//   classic  replaces the gold script heading with sage Arvo at 30px.
export type EmailStyle = 'soft' | 'outline' | 'bold' | 'rounded' | 'classic'
export const DEFAULT_EMAIL_STYLE: EmailStyle = 'soft'

export type EmailStyleSpec = {
  id: EmailStyle
  name: string
  note: string
  buttonBg: string
  buttonText: string
  buttonBorder: string
  buttonRadius: number
  // true: uppercase, 15px, 2px tracking. false: sentence case, 17px, 0.5px.
  buttonCaps: boolean
}

export const EMAIL_STYLES: EmailStyleSpec[] = [
  { id: 'soft',    name: 'Soft',    note: 'Gentle and calm',        buttonBg: '#A8C9C4', buttonText: '#3A3C39', buttonBorder: '#A8C9C4', buttonRadius: 10, buttonCaps: true },
  { id: 'outline', name: 'Outline', note: 'Light and airy',         buttonBg: '#FFFFFF', buttonText: '#4A4C49', buttonBorder: '#A8C9C4', buttonRadius: 10, buttonCaps: true },
  { id: 'bold',    name: 'Bold',    note: 'Easiest to spot',        buttonBg: '#60625F', buttonText: '#FFFFFF', buttonBorder: '#60625F', buttonRadius: 10, buttonCaps: true },
  { id: 'rounded', name: 'Rounded', note: 'Friendly and relaxed',   buttonBg: '#A8C9C4', buttonText: '#3A3C39', buttonBorder: '#A8C9C4', buttonRadius: 30, buttonCaps: false },
  { id: 'classic', name: 'Classic', note: 'Traditional, with gold', buttonBg: '#FFFFFF', buttonText: '#60625F', buttonBorder: '#C99B50', buttonRadius: 10, buttonCaps: true },
]

// Anything that isn't one of the five (NULL, a typo, a column that doesn't
// exist yet) is Soft.
export function normalizeEmailStyle(v: unknown): EmailStyle {
  return EMAIL_STYLES.some((s) => s.id === v) ? (v as EmailStyle) : DEFAULT_EMAIL_STYLE
}
export function emailStyleSpec(v: unknown): EmailStyleSpec {
  const id = normalizeEmailStyle(v)
  return EMAIL_STYLES.find((s) => s.id === id)!
}

// The honeycomb band, self-hosted for the same reason as the logo. The export
// pointed at a Lovable preview host, which would vanish from every email in
// every inbox the day the preview expired.
export const EMAIL_HONEYCOMB_PATH = '/email-honeycomb-header.png'
export const EMAIL_HONEYCOMB_FLIPPED_PATH = '/email-honeycomb-footer.png'
function appAsset(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
  return base ? `${base}${path}` : path
}
export const resolveHoneycombUrl = (env: NodeJS.ProcessEnv = process.env) => appAsset(EMAIL_HONEYCOMB_PATH, env)
export const resolveHoneycombFlippedUrl = (env: NodeJS.ProcessEnv = process.env) => appAsset(EMAIL_HONEYCOMB_FLIPPED_PATH, env)

// Type and colour, from the export.
export const EMAIL_TEXT = '#60625F'
export const EMAIL_GOLD = '#C99B50'
export const EMAIL_SAGE = '#A8C9C4'
export const EMAIL_CLASSIC_HEADING = '#7FA8A2'
const EMAIL_MIST = '#F6F8F3'
export const EMAIL_SANS = `'Helvetica Neue', Helvetica, Arial, sans-serif`
export const EMAIL_SCRIPT = `Corinthia, 'Brush Script MT', cursive`
export const EMAIL_ARVO = `Arvo, Georgia, 'Times New Roman', serif`
const FONTS_LINK = 'https://fonts.googleapis.com/css2?family=Arvo:wght@400;700&family=Lato:wght@300;700&family=Corinthia&display=swap'

export type BrandedEmailContext = {
  location_name?: string | null
  location_phone?: string | null
  reviews_link?: string | null
  // What {{signature}} becomes (lib/email-signature.ts). Only read when the
  // rendered body carries SIGNATURE_MARKER; null/absent → the marker is dropped.
  signature?: EmailSignature | null
  // The location's look (locations.email_style). Absent → Soft.
  style?: EmailStyle | string | null
  // The heading at the top of the card — a client email's rendered subject.
  // Absent → no heading row.
  heading?: string | null
  // The email's optional button (button_text + button_link), ALREADY
  // RENDERED. Both must be present and the link a real http(s) URL, or there
  // is no button.
  button?: { label?: string | null; href?: string | null } | null
}

const LINK_STYLE = `color:${EMAIL_TEXT};text-decoration:underline;`

// Turn URLs in a single line of ALREADY-RENDERED, RAW (un-escaped) text into
// clickable links, escaping everything else. Two forms, template-agnostic:
//
//   1. `word (https://…)`  → the word becomes the link, the parenthesised URL
//      is dropped. This is the corpus's universal CTA shape — "click HERE
//      ({{book_assessment_link}})" renders as "click HERE" (HERE linked), just
//      like the reference. The word may not itself contain "(".
//   2. a bare `https://…`  → linkified in place (covers e.g. the Profiles Quiz
//      P.S. line, or any link an owner pasted without the parenthetical form).
//
// Operates on raw text (not pre-escaped) so URL query strings keep their real
// "&" until escAttr re-encodes them; surrounding prose is escHtml'd here.
const LINK_RE = /([^\s()]+)[ \t]*\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g

export function linkifyLine(raw: string): string {
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(raw)) !== null) {
    out += escHtml(raw.slice(last, m.index))
    if (m[2]) {
      // word (url) — visible text is the word, URL hidden
      out += `<a href="${escAttr(m[2])}" style="${LINK_STYLE}">${escHtml(m[1])}</a>`
    } else {
      // bare url — visible text is the url itself
      out += `<a href="${escAttr(m[3])}" style="${LINK_STYLE}">${escHtml(m[3])}</a>`
    }
    last = LINK_RE.lastIndex
  }
  out += escHtml(raw.slice(last))
  return out
}

// Body text → paragraphs. Blank line (\n\n+) separates paragraphs; a single \n
// becomes <br>. Each line is linkified + escaped. Mirrors bodyToHtml's
// paragraph model so the copy structure is unchanged — only styling and links
// are added.
function bodyParagraphsHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((para) => {
      const inner = para
        .split('\n')
        .map((line) => linkifyLine(line))
        .join('<br />')
      return `<p class="dm-text" style="margin:0 0 20px 0;font-family:${EMAIL_SANS};font-size:17px;line-height:28px;font-weight:300;color:${EMAIL_TEXT};">${inner}</p>`
    })
    .join('\n')
}

// Does the rendered body already contain the reviews link? If so the wrapper
// must NOT add a second reviews line — the in-body one is linkified in place
// instead. reviewsLink is the resolved URL (never a token).
function bodyHasReviewsLink(body: string, reviewsLink: string | null | undefined): boolean {
  if (!reviewsLink || !reviewsLink.trim()) return false
  return body.includes(reviewsLink.trim())
}

// Build the footer-band text: "Bee Organized {{location_name}} | beeorganized.com
// | {{location_phone}}". Segments with a blank value are dropped so a location
// with no name/phone still reads cleanly (never "Bee Organized  |  | ").
function footerSegments(ctx: BrandedEmailContext): {
  brand: string
  phone: string | null
} {
  const name = ctx.location_name?.trim()
  return {
    brand: name ? `Bee Organized ${name}` : 'Bee Organized',
    phone: displayPhone(ctx.location_phone) || null,
  }
}

// ── Shared branded shell ────────────────────────────────────────────────────
// The Bee Organized chrome (the 2026-10-30 design): honeycomb band, gold bee
// logo + wordmark, an optional heading over a thin rule, the card body, an
// optional compliance row, and the location line under the card. Slots:
//   • cardContentHtml   → the white card body (drip paragraphs, OR a lead-
//                          notification field grid + button — structured HTML)
//   • footerBandHtml    → the line under the card (name | website | phone)
//   • cardFooterHtml    → optional; the CAN-SPAM footer of a commercial email,
//                          the last row INSIDE the card. Empty → no row.
//   • opts.style        → the location's look; absent → Soft
//   • opts.heading      → heading text (escaped here); absent → no heading
// Every HTML slot is inserted verbatim: the caller escapes its own content.
//
// No CSS transforms anywhere (Outlook ignores them — hence the second,
// pre-flipped band image for Rounded). The web-font link is a progressive
// enhancement; every font stack falls back to a system face.
export type ShellOptions = { style?: EmailStyle | string | null; heading?: string | null }

export function buildBrandedShellHtml(
  cardContentHtml: string,
  footerBandHtml: string,
  cardFooterHtml = '',
  opts: ShellOptions = {},
): string {
  const style = normalizeEmailStyle(opts.style)
  const logoUrl = resolveDripLogoUrl()
  const heading = opts.heading?.trim() || ''
  const headingHtml = !heading
    ? ''
    : style === 'classic'
      ? `<h1 style="margin:0 0 14px 0;font-family:${EMAIL_ARVO};font-size:30px;line-height:40px;font-weight:400;letter-spacing:1px;color:${EMAIL_CLASSIC_HEADING};text-align:center;">${escHtml(heading)}</h1>`
      : `<h1 style="margin:0 0 8px 0;font-family:${EMAIL_SCRIPT};font-size:46px;line-height:56px;font-weight:400;color:${EMAIL_GOLD};text-align:center;">${escHtml(heading)}</h1>`
  const headingRow = headingHtml
    ? `
          <tr><td align="center" style="padding:20px 28px 0 28px;">
            ${headingHtml}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="80%" align="center"><tr><td class="dm-line" style="border-top:1px solid #DDDDDA;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>
          </td></tr>`
    : ''
  const cardFooterRow = cardFooterHtml
    ? `
          <tr>
            <td class="bo-card-footer dm-line" style="padding:16px 32px 24px 32px;border-top:1px solid #EEEEEE;font-family:${EMAIL_SANS};font-size:13px;line-height:20px;color:#7A7C79;text-align:center;">
              ${cardFooterHtml}
            </td>
          </tr>`
    : ''
  const bottomBandRow = style === 'rounded'
    ? `
          <tr><td style="padding:0;font-size:0;line-height:0;"><img src="${resolveHoneycombFlippedUrl()}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>`
    : ''
  const darkCss = `.dm-bg{background-color:#1F201E !important;}.dm-card{background-color:#2A2B29 !important;}.dm-text,.dm-text a,.dm-text strong{color:#E4E5E1 !important;}.dm-line{border-color:#454643 !important;}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
${heading ? `<title>${escHtml(heading)}</title>\n` : ''}<link href="${FONTS_LINK}" rel="stylesheet">
<style>
  /* Dark-mode guard only. Gmail strips this block; the email is fully correct
     without it. */
  :root{color-scheme:light dark;supported-color-schemes:light dark;}
  @media (prefers-color-scheme: dark) { ${darkCss} }
  [data-ogsc] .dm-text{color:#E4E5E1 !important;}
</style>
</head>
<body class="dm-bg" style="margin:0;padding:0;background-color:${EMAIL_MIST};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bo-wrap dm-bg" bgcolor="${EMAIL_MIST}" style="background-color:${EMAIL_MIST};">
    <tr>
      <td align="center" style="padding:24px 10px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="bo-card dm-card" bgcolor="#FFFFFF" style="width:100%;max-width:600px;background-color:#FFFFFF;">
          <tr><td align="right" style="padding:0;font-size:0;line-height:0;"><img src="${resolveHoneycombUrl()}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></td></tr>
          <tr><td align="center" style="padding:0 24px 4px 24px;">
            <img src="${logoUrl}" width="72" alt="Bee Organized" style="display:block;margin:0 auto;width:72px;height:auto;border:0;font-family:${EMAIL_SANS};font-size:20px;letter-spacing:3px;color:${EMAIL_TEXT};">
            <p class="dm-text" style="margin:10px 0 0 0;font-family:${EMAIL_SANS};font-size:13px;letter-spacing:4px;text-transform:uppercase;color:${EMAIL_TEXT};">Bee Organized</p>
          </td></tr>${headingRow}
          <tr>
            <td style="padding:24px 28px 8px 32px;font-family:${EMAIL_SANS};">
              ${cardContentHtml}
            </td>
          </tr>${cardFooterRow}${bottomBandRow}
        </table>
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr><td align="center" class="dm-text" style="padding:20px 24px;font-family:${EMAIL_SANS};font-size:14px;line-height:22px;color:${EMAIL_TEXT};">
            ${footerBandHtml}
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

// ── The button ─────────────────────────────────────────────────────────────
// Kevin, 2026-10-30: a button only when BOTH its text and its link are filled
// in. The link has already been through renderTemplate, so a tag with nothing
// behind it ({{booking_link}} with no link set) leaves an empty string — not a
// URL, so no button. Only http(s) survives (safeHttpUrl, as for signature
// links): an owner-typed "javascript:" never reaches an href.
export function resolveButton(button: BrandedEmailContext['button']): { label: string; href: string } | null {
  const label = button?.label?.trim()
  const raw = button?.href?.trim()
  if (!label || !raw) return null
  const href = safeHttpUrl(raw)
  return href ? { label, href } : null
}

export function buildButtonHtml(style: EmailStyle | string | null | undefined, button: { label: string; href: string }): string {
  const s = emailStyleSpec(style)
  const size = s.buttonCaps ? 15 : 17
  const tracking = s.buttonCaps ? 2 : 0.5
  const transform = s.buttonCaps ? 'uppercase' : 'none'
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px auto;">
<tr><td align="center" bgcolor="${s.buttonBg}" style="background-color:${s.buttonBg};border:2px solid ${s.buttonBorder};border-radius:${s.buttonRadius}px;">
<a href="${escAttr(button.href)}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${EMAIL_SANS};font-size:${size}px;font-weight:500;letter-spacing:${tracking}px;text-transform:${transform};color:${s.buttonText};text-decoration:none;border-radius:${s.buttonRadius}px;">${escHtml(button.label)}</a>
</td></tr></table>`
}

// Where the button goes: after the message, before the sign-off, as the design
// lays it out. With {{signature}} in the body, the paragraph holding it (the
// "Thank you," line and the signature) and everything after it follow the
// button; the rest is the message. No signature → the button closes the message.
export function splitForButton(body: string): [string, string] {
  const i = body.indexOf(SIGNATURE_MARKER)
  if (i === -1) return [body, '']
  const head = body.slice(0, i)
  const lastBreak = head.replace(/\n+$/, '').lastIndexOf('\n\n')
  const cut = lastBreak === -1 ? 0 : lastBreak
  return [body.slice(0, cut), body.slice(cut).replace(/^\n+/, '')]
}

// A commercial email's compliance footer, pre-built by the caller
// (lib/marketing-unsubscribe.ts buildCanSpamFooter). html goes in the card's
// footer slot; text goes after the body in the plain-text alternative.
export type CardFooter = { html: string; text: string }

// ── HTML ──────────────────────────────────────────────────────────────────
export function buildBrandedDripHtml(
  renderedBody: string,
  ctx: BrandedEmailContext,
  cardFooter?: CardFooter | null,
): string {
  const reviewsLink = ctx.reviews_link?.trim() || null
  const addReviewsLine = reviewsLink && !bodyHasReviewsLink(renderedBody, reviewsLink)

  const reviewsHtml = addReviewsLine
    ? `<p class="dm-text" style="margin:20px 0 0;font-family:${EMAIL_SANS};font-size:17px;line-height:28px;font-weight:300;color:${EMAIL_TEXT};"><a href="${escAttr(
        reviewsLink!,
      )}" style="${LINK_STYLE}">${escHtml(REVIEWS_LINE_TEXT)}</a></p>`
    : ''

  const { brand, phone } = footerSegments(ctx)
  const websiteCell = `<a href="${DRIP_WEBSITE_URL}" style="color:${EMAIL_TEXT};">${DRIP_WEBSITE_LABEL}</a>`
  const footerInner = [escHtml(brand), websiteCell, phone ? escHtml(phone) : null]
    .filter(Boolean)
    .join(' | ')

  // {{signature}}: the body is split on the private placeholder, every piece is
  // escaped by bodyParagraphsHtml exactly as before, and the fixed signature
  // layout is joined in between (lib/email-signature.ts header).
  const button = resolveButton(ctx.button)
  let contentHtml: string
  if (button) {
    const [message, rest] = splitForButton(renderedBody)
    contentHtml = [
      message.trim() ? htmlWithSignature(message, bodyParagraphsHtml, ctx.signature) : '',
      buildButtonHtml(ctx.style, button),
      rest.trim() ? htmlWithSignature(rest, bodyParagraphsHtml, ctx.signature) : '',
    ].filter(Boolean).join('\n              ')
  } else {
    contentHtml = htmlWithSignature(renderedBody, bodyParagraphsHtml, ctx.signature)
  }
  return buildBrandedShellHtml(`${contentHtml}
              ${reviewsHtml}`, footerInner, cardFooter?.html ?? '', { style: ctx.style, heading: ctx.heading })
}

// ── Plain text ────────────────────────────────────────────────────────────
// The text alternative MUST match the HTML, not be left stale (#90). URLs stay
// visible (plain text can't hyperlink), which is exactly what the master bodies
// already do ("click HERE (url)"). Adds the wordmark line, the conditional
// reviews line, and the footer band as text.
export function buildBrandedDripText(
  renderedBody: string,
  ctx: BrandedEmailContext,
  cardFooter?: CardFooter | null,
): string {
  const reviewsLink = ctx.reviews_link?.trim() || null
  const addReviewsLine = reviewsLink && !bodyHasReviewsLink(renderedBody, reviewsLink)

  const { brand, phone } = footerSegments(ctx)
  const footerLine = [brand, DRIP_WEBSITE_LABEL, phone].filter(Boolean).join(' | ')

  const heading = ctx.heading?.trim()
  const button = resolveButton(ctx.button)
  const parts = ['BEE ORGANIZED', '']
  if (heading) parts.push(heading, '')
  if (button) {
    const [message, rest] = splitForButton(renderedBody)
    if (message.trim()) parts.push(textWithSignature(message, ctx.signature).trimEnd(), '')
    parts.push(`${button.label.toUpperCase()}:`, button.href)
    if (rest.trim()) parts.push('', textWithSignature(rest, ctx.signature).trimEnd())
  } else {
    parts.push(textWithSignature(renderedBody, ctx.signature).trimEnd())
  }
  if (addReviewsLine) {
    parts.push('', `${REVIEWS_LINE_TEXT} (${reviewsLink})`)
  }
  // Same order as the HTML: the compliance footer closes the card, then the band.
  if (cardFooter?.text) parts.push('', cardFooter.text)
  parts.push('', '—', footerLine)
  return parts.join('\n')
}
