// lib/email-signature.ts
//
// The Bee Organized email signature — ONE fixed layout, filled in with five
// things about a person and four links about their location. Nobody designs
// their own (Kevin asked the owners: every signature at Bee Organized is the
// same), so there is no rich-text editor and no HTML cleaner anywhere: owners
// type plain values into Settings, and THIS file is the only place signature
// HTML is ever built.
//
//   ┌────────┐ │ Jane Smith                 ← sage, larger, bold
//   │ photo  │ │ Owner & Lead Organizer     ← bold italic, grey
//   │ 80×80  │ │ jane@beeorganized.com      ← mailto:
//   └────────┘ │ m: (303) 555-0147          ← tel:
//              │ beeorganized.com/boulder   ← the LOCATION's website
//              │ [f] [ig] [in]              ← the LOCATION's social links
//
// PURE: no DB, no env reads except the app origin for image URLs. The
// send-time resolver (who signs, with what) is lib/email-signature-resolve.ts.
//
// ── HOW {{signature}} REACHES AN EMAIL — the private placeholder ─────────
// Every client email body is owner-typed PLAIN TEXT that is escaped into
// paragraphs (lib/drip-email-layout.ts bodyParagraphsHtml, lib/drip-send.ts
// bodyToHtml). The signature is HTML, so it cannot simply be substituted as a
// {{tag}} value — the paragraph builder would escape it into visible markup,
// and loosening the escaping would let owner text run as HTML in an email
// sent in Bee Organized's name. So:
//
//   1. renderTemplate(..., { signatureMarker: true }) turns {{signature}} in
//      the BODY into SIGNATURE_MARKER (in a subject it is always empty).
//   2. The body builder splits the text on the marker, escapes every piece
//      exactly as before, and joins the pieces with buildSignatureHtml().
//
// Owner text never passes through anything but the existing escapers; the
// only unescaped HTML in the email is this file's fixed layout, and every
// value poured into it is escaped (text) or validated-then-escaped (links).
// lib/beta-email-signature.test.ts pins that hardest, and was mutation-tested.
//
// ── IMAGES BLOCKED (Outlook, by default, for unknown senders) ─────────────
// Everything a client needs is real text: name, title, email, mobile and
// website. The photo is decoration with a fixed 80×80 box and the person's
// name as alt text, so a blocked photo is a small labelled square, not a
// hole. The social icons are 24×24 images with alt text "Facebook" /
// "Instagram" / "LinkedIn"; blocked, they are three small squares that are
// STILL clickable links. They stay icons because that is the agreed layout,
// and nothing the client needs lives only in them.

import { escHtml, escAttr } from './email-escape'

// The brand's pale green (sage) — the same hex the design tokens call
// brand.sage. Name line only.
export const SIGNATURE_NAME_COLOR = '#A8C9C4'
export const SIGNATURE_TITLE_COLOR = '#6B6B66'
export const SIGNATURE_TEXT_COLOR = '#4A4A45'
export const SIGNATURE_LINK_COLOR = '#054E4A'
export const SIGNATURE_RULE_COLOR = '#A8C9C4'

// Display size of the headshot. Uploads are shrunk in the browser to 2× this
// (lib/signature-photo.js) so it stays sharp on high-density screens.
export const SIGNATURE_PHOTO_PX = 80
export const SIGNATURE_ICON_PX = 24

// Where an uploaded headshot lives: the PUBLIC email-signatures bucket
// (migrations/email_signatures.sql). Mail clients fetch it without a login,
// so it must be public; the path is two random UUIDs, never a name.
export const SIGNATURE_PHOTO_BUCKET = 'email-signatures'

// Photos are served from OUR domain (beehive.beeorganized.com), not the
// Supabase address — next.config.mjs rewrites this prefix to the bucket. Same
// reasoning as the drip logo: every image in a client email comes from the
// sending brand's own domain.
export const SIGNATURE_PHOTO_ROUTE = '/email-signature-photos'

// Social icons are self-hosted in public/, like the drip logo.
export const SIGNATURE_ICON_PATHS = {
  facebook: '/email-signature/facebook.png',
  instagram: '/email-signature/instagram.png',
  linkedin: '/email-signature/linkedin.png',
} as const

// A private-use code point pair no keyboard produces. renderTemplate emits it
// for {{signature}}; the body builders swap it for the signature (or drop it).
export const SIGNATURE_MARKER = 'bo-signature'
export const SIGNATURE_TAG_RE = /\{\{signature\}\}/g

export function hasSignatureTag(text: string | null | undefined): boolean {
  return !!text && /\{\{signature\}\}/.test(text)
}

// ── The resolved signature — what the layout is filled with ────────────────
// Every field may be null; the layout drops the line. `name` is the one field
// the resolver guarantees (a person's name, else "Bee Organized <Location>"),
// so a template that reads "Thank you,\n{{signature}}" is never left with a
// dangling "Thank you,".
export type EmailSignature = {
  name: string | null
  title: string | null
  email: string | null
  mobile: string | null
  photoPath: string | null
  websiteUrl: string | null
  facebookUrl: string | null
  instagramUrl: string | null
  linkedinUrl: string | null
}

export const EMPTY_SIGNATURE: EmailSignature = {
  name: null,
  title: null,
  email: null,
  mobile: null,
  photoPath: null,
  websiteUrl: null,
  facebookUrl: null,
  instagramUrl: null,
  linkedinUrl: null,
}

// ── Value validation ────────────────────────────────────────────────────
// Links: http(s) only, parsed by URL so a "javascript:" / "data:" value, a
// quote, or an angle bracket can never reach an href. An owner typing
// "beeorganized.com/boulder" gets https:// added. Anything unparseable is
// dropped (the line disappears) rather than rendered.
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let s = raw.trim()
  if (!s || /\s/.test(s)) return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (!u.hostname || !u.hostname.includes('.')) return null
  return u.href
}

// What the website line SHOWS: no scheme, no "www.", no trailing slash.
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
}

const EMAIL_RE = /^[^\s@<>"'()\\,;:]+@[^\s@<>"'()\\,;:]+\.[^\s@<>"'()\\,;:]+$/
export function safeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return EMAIL_RE.test(s) ? s : null
}

// tel: href — digits and a leading + only. The DISPLAYED number stays as the
// person typed it (escaped). Fewer than 7 digits is not a phone number.
export function telHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const plus = raw.trim().startsWith('+') ? '+' : ''
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 7 ? `tel:${plus}${digits}` : null
}

// A stored photo path must be exactly "<uuid>/<uuid>.jpg|png" — the shape the
// upload route mints. Anything else (a URL, a traversal, a stray value) yields
// no photo rather than an image pointing somewhere we didn't choose.
const PHOTO_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$/
export function isValidSignaturePhotoPath(path: string | null | undefined): path is string {
  return typeof path === 'string' && PHOTO_PATH_RE.test(path)
}

function appOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || '').replace(/\/+$/, '')
}

export function signaturePhotoUrl(path: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isValidSignaturePhotoPath(path)) return null
  return `${appOrigin(env)}${SIGNATURE_PHOTO_ROUTE}/${path}`
}

function iconUrl(key: keyof typeof SIGNATURE_ICON_PATHS, env: NodeJS.ProcessEnv = process.env): string {
  return `${appOrigin(env)}${SIGNATURE_ICON_PATHS[key]}`
}

function clean(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim()
  return t ? t : null
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`

// ── HTML ──────────────────────────────────────────────────────────────────
// Table layout (the only thing every mail client agrees on). Photo cell and
// the vertical rule appear only when there is a photo — without one, a rule
// with nothing to its left reads as a mistake, so the text simply stands alone.
export function buildSignatureHtml(sig: EmailSignature, env: NodeJS.ProcessEnv = process.env): string {
  const name = clean(sig.name)
  const title = clean(sig.title)
  const mobile = clean(sig.mobile)
  const email = safeEmail(sig.email)
  const mobileHref = telHref(mobile)
  const website = safeHttpUrl(sig.websiteUrl)
  const photo = signaturePhotoUrl(sig.photoPath, env)

  const linkStyle = `color:${SIGNATURE_LINK_COLOR};text-decoration:none;`
  const lines: string[] = []
  if (name) {
    lines.push(`<div style="font-size:18px;line-height:1.3;font-weight:bold;color:${SIGNATURE_NAME_COLOR};">${escHtml(name)}</div>`)
  }
  if (title) {
    lines.push(`<div style="font-weight:bold;font-style:italic;color:${SIGNATURE_TITLE_COLOR};padding-bottom:4px;">${escHtml(title)}</div>`)
  }
  if (email) {
    lines.push(`<div><a href="${escAttr(`mailto:${email}`)}" style="${linkStyle}">${escHtml(email)}</a></div>`)
  }
  if (mobile) {
    const shown = escHtml(mobile)
    lines.push(`<div>m:&nbsp;${mobileHref ? `<a href="${escAttr(mobileHref)}" style="${linkStyle}">${shown}</a>` : shown}</div>`)
  }
  if (website) {
    lines.push(`<div><a href="${escAttr(website)}" style="${linkStyle}">${escHtml(displayUrl(website))}</a></div>`)
  }

  const socials: string[] = []
  const social = (key: keyof typeof SIGNATURE_ICON_PATHS, raw: string | null, label: string) => {
    const url = safeHttpUrl(raw)
    if (!url) return
    socials.push(
      `<a href="${escAttr(url)}" style="text-decoration:none;"><img src="${escAttr(iconUrl(key, env))}" width="${SIGNATURE_ICON_PX}" height="${SIGNATURE_ICON_PX}" alt="${label}" style="display:inline-block;width:${SIGNATURE_ICON_PX}px;height:${SIGNATURE_ICON_PX}px;border:0;"></a>`,
    )
  }
  social('facebook', sig.facebookUrl, 'Facebook')
  social('instagram', sig.instagramUrl, 'Instagram')
  social('linkedin', sig.linkedinUrl, 'LinkedIn')
  if (socials.length) {
    lines.push(`<div style="padding-top:8px;">${socials.join('&nbsp;&nbsp;')}</div>`)
  }

  if (!lines.length) return ''

  const textCell = `<td valign="top" style="${photo ? `border-left:2px solid ${SIGNATURE_RULE_COLOR};padding:0 0 0 14px;` : 'padding:0;'}font-family:${FONT};font-size:13px;line-height:1.55;color:${SIGNATURE_TEXT_COLOR};">${lines.join('')}</td>`
  const photoCell = photo
    ? `<td valign="top" style="padding:0 14px 0 0;"><img src="${escAttr(photo)}" width="${SIGNATURE_PHOTO_PX}" height="${SIGNATURE_PHOTO_PX}" alt="${escHtml(name ?? '')}" style="display:block;width:${SIGNATURE_PHOTO_PX}px;height:${SIGNATURE_PHOTO_PX}px;border:0;"></td>`
    : ''

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 18px;"><tr>${photoCell}${textCell}</tr></table>`
}

// ── Plain text (the text/plain half of the email) ─────────────────────────
export function buildSignatureText(sig: EmailSignature): string {
  const out: string[] = []
  const name = clean(sig.name)
  const title = clean(sig.title)
  const email = safeEmail(sig.email)
  const mobile = clean(sig.mobile)
  const website = safeHttpUrl(sig.websiteUrl)
  if (name) out.push(name)
  if (title) out.push(title)
  if (email) out.push(email)
  if (mobile) out.push(`m: ${mobile}`)
  if (website) out.push(displayUrl(website))
  const fb = safeHttpUrl(sig.facebookUrl)
  const ig = safeHttpUrl(sig.instagramUrl)
  const li = safeHttpUrl(sig.linkedinUrl)
  if (fb) out.push(`Facebook: ${fb}`)
  if (ig) out.push(`Instagram: ${ig}`)
  if (li) out.push(`LinkedIn: ${li}`)
  return out.join('\n')
}

// ── Body plumbing ───────────────────────────────────────────────────────
// Split a rendered body on the marker. Each piece has its edge newlines
// trimmed so "Thank you,\n<marker>\n\nBe sure…" becomes ["Thank you,",
// "Be sure…"] and the signature sits between them as its own block.
export function splitOnSignatureMarker(body: string): string[] {
  return body.split(SIGNATURE_MARKER).map((piece) => piece.replace(/^\n+|\n+$/g, ''))
}

export function stripSignatureMarkers(s: string): string {
  return s.split(SIGNATURE_MARKER).join('')
}

// HTML: escape each piece with the caller's own paragraph builder, join with
// the signature. No marker in the body → the builder runs exactly as before.
export function htmlWithSignature(
  body: string,
  toParagraphs: (text: string) => string,
  signature: EmailSignature | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!body.includes(SIGNATURE_MARKER)) return toParagraphs(body)
  const sigHtml = signature ? buildSignatureHtml(signature, env) : ''
  return splitOnSignatureMarker(body)
    .map((piece) => (piece ? toParagraphs(piece) : ''))
    .reduce((acc, pieceHtml, i) => (i === 0 ? pieceHtml : `${acc}${sigHtml}${pieceHtml}`), '')
}

// Text: the marker becomes the text signature (or nothing).
export function textWithSignature(body: string, signature: EmailSignature | null | undefined): string {
  if (!body.includes(SIGNATURE_MARKER)) return body
  const sigText = signature ? buildSignatureText(signature) : ''
  return body.split(SIGNATURE_MARKER).join(sigText)
}
