// lib/drip-email-layout.ts
// ─────────────────────────────────────────────────────────────
// #90 — the Bee Organized branded wrapper for DRIP client emails.
//
// Drips go to franchisees' own clients; the audience skews 45-65, so this
// wrapper prioritises legibility over density: single column, ~600px, 16px
// body copy at generous line-height, one gold bee logo + wordmark header,
// and a solid teal footer band.
//
// SCOPE: drips ONLY. bodyToHtml (lib/drip-send.ts) is shared by welcome +
// stage emails and is deliberately left untouched — this module is a new,
// separate layer used only by the drip send path, so welcome/stage output
// is byte-identical to before.
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

// Brand teal = ui/tokens GREEN_FILL (hive token set accent.fg — the site's own
// deep teal). Closest existing brand colour to the reference's teal band, and
// dark enough to carry white text (AA), unlike gold #D4A049 / sage #A8C9C4
// which the palette bans for white text. NOT eyedropped from the screenshot.
export const DRIP_BRAND_TEAL = '#054E4A'
// Gold-hued ink that passes on white (tokens brand.goldFill) — the tagline.
export const DRIP_BRAND_GOLD_INK = '#8C6421'

// Website is NOT per-location — every location shares this. Hardcoded per #90:
// no locations.website column, no {{location_website}} token. Displayed without
// the scheme, linked to the full URL.
export const DRIP_WEBSITE_URL = 'https://beeorganized.com'
export const DRIP_WEBSITE_LABEL = 'beeorganized.com'

// The standalone reviews line copy — matches the wording already used in the
// master template bodies so the two never read differently.
export const REVIEWS_LINE_TEXT = 'Be sure to check out our Google Reviews!'

export type BrandedEmailContext = {
  location_name?: string | null
  location_phone?: string | null
  reviews_link?: string | null
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// URL for an href attribute: escape only the chars that could break out of the
// quoted attribute. Ampersands in query strings become &amp; so the HTML is
// well-formed; the browser/mail client decodes them back on click.
function escAttr(url: string): string {
  return url
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const LINK_STYLE = `color:${DRIP_BRAND_TEAL};text-decoration:underline;`

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
      return `<p style="margin:0 0 18px;font-size:16px;line-height:1.7;color:#2b2b28;">${inner}</p>`
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
    phone: ctx.location_phone?.trim() || null,
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────
export function buildBrandedDripHtml(renderedBody: string, ctx: BrandedEmailContext): string {
  const logoUrl = resolveDripLogoUrl()
  const reviewsLink = ctx.reviews_link?.trim() || null
  const addReviewsLine = reviewsLink && !bodyHasReviewsLink(renderedBody, reviewsLink)

  const reviewsHtml = addReviewsLine
    ? `<p style="margin:20px 0 0;font-size:16px;line-height:1.7;color:#2b2b28;"><a href="${escAttr(
        reviewsLink!,
      )}" style="${LINK_STYLE}">${escHtml(REVIEWS_LINE_TEXT)}</a></p>`
    : ''

  const { brand, phone } = footerSegments(ctx)
  const websiteCell = `<a href="${DRIP_WEBSITE_URL}" style="color:#ffffff;text-decoration:underline;">${DRIP_WEBSITE_LABEL}</a>`
  const footerInner = [escHtml(brand), websiteCell, phone ? escHtml(phone) : null]
    .filter(Boolean)
    .join('&nbsp;&nbsp;|&nbsp;&nbsp;')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  /* Dark-mode guard only. Gmail strips this block; the email is fully correct
     without it. Where honoured (Apple Mail, iOS Mail), it pins the card white
     so the dark wordmark/body stay legible instead of being force-inverted. */
  @media (prefers-color-scheme: dark) {
    .bo-wrap { background:#12110f !important; }
    .bo-card { background:#ffffff !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f2ec;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bo-wrap" style="background:#f4f2ec;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="bo-card" style="width:600px;max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden;">
          <tr>
            <td align="center" style="padding:36px 40px 4px;background:#ffffff;">
              <img src="${logoUrl}" width="120" height="84" alt="Bee Organized" style="display:block;border:0;outline:none;text-decoration:none;width:120px;height:auto;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;letter-spacing:3px;color:${DRIP_BRAND_TEAL};padding-top:16px;">BEE ORGANIZED</div>
              <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:${DRIP_BRAND_GOLD_INK};padding-top:6px;">Simplify Your Hive</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 40px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
              ${bodyParagraphsHtml(renderedBody)}
              ${reviewsHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" bgcolor="${DRIP_BRAND_TEAL}" style="background:${DRIP_BRAND_TEAL};padding:18px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#ffffff;">
                    ${footerInner}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

// ── Plain text ────────────────────────────────────────────────────────────
// The text alternative MUST match the HTML, not be left stale (#90). URLs stay
// visible (plain text can't hyperlink), which is exactly what the master bodies
// already do ("click HERE (url)"). Adds the wordmark line, the conditional
// reviews line, and the footer band as text.
export function buildBrandedDripText(renderedBody: string, ctx: BrandedEmailContext): string {
  const reviewsLink = ctx.reviews_link?.trim() || null
  const addReviewsLine = reviewsLink && !bodyHasReviewsLink(renderedBody, reviewsLink)

  const { brand, phone } = footerSegments(ctx)
  const footerLine = [brand, DRIP_WEBSITE_LABEL, phone].filter(Boolean).join(' | ')

  const parts = [
    'BEE ORGANIZED — Simplify Your Hive',
    '',
    renderedBody.trimEnd(),
  ]
  if (addReviewsLine) {
    parts.push('', `${REVIEWS_LINE_TEXT} (${reviewsLink})`)
  }
  parts.push('', '—', footerLine)
  return parts.join('\n')
}
