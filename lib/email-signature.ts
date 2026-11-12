// lib/email-signature.ts
//
// The Bee Organized email signature — ONE fixed layout, filled in with five
// things about a person and four links about their location. Nobody designs
// their own (Kevin asked the owners: every signature at Bee Organized is the
// same), so there is no rich-text editor and no HTML cleaner anywhere: owners
// type plain values into Settings, and THIS file is the only place signature
// HTML is ever built.
//
//   ┌────────┐ ┃ Jane Smith                         ← 22px bold sage
//   │ photo  │ ┃ Owner, Bee Organized Boulder       ← 16px bold italic grey
//   │ 90×112 │ ┃ jane@beeorganized.com              ← dark teal, underlined
//   │        │ ┃ m: (303) 555-0147                  ← "m:" sage, number grey
//   └────────┘ ┃ beeorganized.com/boulder           ← grey, underlined
//              ┃ [f] [ig] [in]                      ← 28px sage-framed squares
//
// 2026-10-31, KEVIN'S REDESIGN (replaces the Lovable version built earlier
// that day). Arial throughout; sage #A8C9C4 and grey #7A7C79; a 4px sage bar
// down the left of the text. Always light — Bee Hub has no dark mode.
//
// THE PHOTO BOX is 90×112 on #E6EFED. Kevin's rulings: a real photo when
// there is one, the initials (sage, 30px bold) when not, and no box at all
// when the name yields no initials. Photos uploaded before this were cropped
// SQUARE (160×160), so they sit as a 90×90 square in the box — never
// stretched; new uploads are cropped to the box's own portrait shape and say
// so in their file name ("-p", isPortraitSignaturePhotoPath).
//
// THE SOCIALS are the design's 28px sage-bordered square holding each
// network's symbol as a sage outline mark (SIGNATURE_ICON_PATHS) rather than
// its "f" / "ig" / "in" letters — Kevin's call over the earlier dark-circle
// logos. A social with no link is left out.
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

import { telHref as phoneTelHref } from '@/lib/phone'
import { escHtml, escAttr } from './email-escape'

// The email's sage. NOTE: the Emails SCREEN's design token is #A2C7C1; every
// email ever sent uses this one, so it stays (2026-10-31, deliberately left).
export const SIGNATURE_SAGE = '#A8C9C4'
export const SIGNATURE_GREY = '#7A7C79'
// THE EMAIL ADDRESS ONLY (Kevin, 2026-11-12). Sage on white is 1.78:1 — too
// faint to read at 15px in the Welcome Email. Nothing sage in the email
// palette reaches the 4.5:1 small text needs (#7FA8A2 is 2.62:1), so this is
// the brand's dark teal, 9.57:1 — the same hex as DRIP_BRAND_TEAL in
// lib/drip-email-layout.ts (a test holds the two together; not imported, that
// file imports this one). The name, the bar, the "m:", the initials and the
// social frames stay SIGNATURE_SAGE.
export const SIGNATURE_EMAIL_LINK = '#054E4A'
export const SIGNATURE_PHOTO_BG = '#E6EFED'
export const SIGNATURE_FONT = 'Arial, Helvetica, sans-serif'
export const SIGNATURE_NAME_COLOR = SIGNATURE_SAGE
export const SIGNATURE_TITLE_COLOR = SIGNATURE_GREY
export const SIGNATURE_TEXT_COLOR = SIGNATURE_GREY

// The photo box (display size). Portrait uploads are stored at 2×.
export const SIGNATURE_PHOTO_W = 90
export const SIGNATURE_PHOTO_H = 112
// The social squares: 28px inside a 2px sage border, the mark centred in it.
export const SIGNATURE_SOCIAL_PX = 28
export const SIGNATURE_SOCIAL_LOGO_PX = 20


// Where an uploaded headshot lives: the PUBLIC email-signatures bucket
// (migrations/email_signatures.sql). Mail clients fetch it without a login,
// so it must be public; the path is two random UUIDs, never a name.
export const SIGNATURE_PHOTO_BUCKET = 'email-signatures'

// Photos are served from OUR domain (beehive.beeorganized.com), not the
// Supabase address — next.config.mjs rewrites this prefix to the bucket. Same
// reasoning as the drip logo: every image in a client email comes from the
// sending brand's own domain.
export const SIGNATURE_PHOTO_ROUTE = '/email-signature-photos'

// Social marks are self-hosted in public/, like the drip logo: the symbol
// alone in sage, drawn as 24×24 stroke-2 line icons like the Settings screen's
// own, rendered at 2× (40×40 PNGs for the 20px slot). New names, never the old
// facebook.png / instagram.png / linkedin.png: inboxes and image proxies cache
// by address, so reusing a path could keep serving the dark-circle logo.
export const SIGNATURE_ICON_PATHS = {
  facebook: '/email-signature/facebook-mark.png',
  instagram: '/email-signature/instagram-mark.png',
  linkedin: '/email-signature/linkedin-mark.png',
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
  // The location the signer works for, for the title line. Optional: absent
  // or null → the title stands alone.
  locationName?: string | null
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

// Instagram: owners type handles, not addresses (Lovable's signatureUrl).
// "@handle" → https://instagram.com/handle; anything else as safeHttpUrl.
const INSTAGRAM_HANDLE_RE = /^@([A-Za-z0-9._]{1,30})$/
export function instagramUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(INSTAGRAM_HANDLE_RE)
  return m ? `https://instagram.com/${m[1]}` : safeHttpUrl(raw)
}

// Lovable's signatureInitials: the first letter of the first two words,
// uppercased. Only letters and digits count, so "(Jane) Smith" is "JS" and a
// name with neither — "—", "???" — yields '' and the email shows no circle at
// all rather than an empty one.
// (Built with new RegExp: the project's TypeScript target refuses the /u flag
// in a literal, though every runtime we ship to supports it.)
const LETTER_OR_DIGIT = new RegExp('[\\p{L}\\p{N}]', 'u')
export function signatureInitials(name: string | null | undefined): string {
  if (typeof name !== 'string') return ''
  return name.trim().split(/\s+/)
    .map((w) => (w.match(LETTER_OR_DIGIT) || [''])[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

// LINKEDIN: THE LOCATION'S FIRST, THE PERSON'S ONLY AS A FALLBACK (Kevin,
// 2026-10-31: "1 linkedin makes sense for all signatures … if not people can
// do individuals"). Everyone signing for a location carries its one LinkedIn;
// a person's own appears only where the location has none.
//
// THIS IS THE OPPOSITE DIRECTION TO resolveOwnerBookingLink (lib/
// booking-link.ts), which tries the person first and falls back to the
// location. Deliberate — do not "make them consistent".
//
// The renderer still runs the winner through safeHttpUrl. Used by the
// send-time resolver (assembleSignature) and the screen's own previews
// (signatureFromData), so the two can't disagree.
export function linkedinFor(locationUrl: string | null | undefined, personUrl: string | null | undefined): string | null {
  const loc = typeof locationUrl === 'string' ? locationUrl.trim() : ''
  if (loc) return loc
  const own = typeof personUrl === 'string' ? personUrl.trim() : ''
  return own || null
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

// tel: href — the ONE shape from lib/phone.ts (US: +1 and ten digits;
// foreign: its own +digits; fewer than 7 digits: no link). The DISPLAYED
// number stays as the person typed it (escaped).
export function telHref(raw: string | null | undefined): string | null {
  return phoneTelHref(raw)
}

// A stored photo path must be exactly "<uuid>/<uuid>[-p].jpg|png" — the shape
// the upload route mints. Anything else (a URL, a traversal, a stray value)
// yields no photo rather than an image pointing somewhere we didn't choose.
// "-p" marks a PORTRAIT upload (90×112 at 2×, from 2026-10-31); without it
// the photo is one of the earlier SQUARE ones.
const PHOTO_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-p)?\.(jpg|png)$/
export function isValidSignaturePhotoPath(path: string | null | undefined): path is string {
  return typeof path === 'string' && PHOTO_PATH_RE.test(path)
}
export function isPortraitSignaturePhotoPath(path: string | null | undefined): boolean {
  return isValidSignaturePhotoPath(path) && /-p\.(jpg|png)$/.test(path)
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


// The title line: "Owner, Bee Organized Boulder"; title alone without a
// location; nothing without a title.
function titleLine(sig: EmailSignature): string | null {
  const title = clean(sig.title)
  if (!title) return null
  const loc = clean(sig.locationName ?? null)
  return loc ? `${title}, Bee Organized ${loc}` : title
}

// ── HTML ──────────────────────────────────────────────────────────────────
// Table layout (the only thing every mail client agrees on): the photo box,
// then the text behind a 4px sage bar. Every value poured in is escaped (text)
// or validated-then-escaped (links).
const ROW_TEXT = 'font-size:15px;line-height:22px;font-weight:bold;font-style:italic;word-break:break-word;overflow-wrap:anywhere;'

export function buildSignatureHtml(sig: EmailSignature, env: NodeJS.ProcessEnv = process.env): string {
  const name = clean(sig.name)
  const title = titleLine(sig)
  const mobile = clean(sig.mobile)
  const email = safeEmail(sig.email)
  const mobileHref = telHref(mobile)
  const website = safeHttpUrl(sig.websiteUrl)
  const photo = signaturePhotoUrl(sig.photoPath, env)
  const SAGE = SIGNATURE_SAGE, GREY = SIGNATURE_GREY

  const rows: string[] = []
  const row = (padding: string, style: string, inner: string) =>
    rows.push(`<tr><td style="padding:${padding};${style}">${inner}</td></tr>`)
  if (name) row('0 0 8px 0', `font-size:22px;line-height:28px;font-weight:bold;color:${SAGE};`, escHtml(name))
  if (title) row('0 0 10px 0', `font-size:16px;line-height:22px;font-weight:bold;font-style:italic;color:${GREY};`, escHtml(title))
  if (email) row('0 0 10px 0', ROW_TEXT, `<a href="${escAttr(`mailto:${email}`)}" style="color:${SIGNATURE_EMAIL_LINK};text-decoration:underline;">${escHtml(email)}</a>`)
  if (mobile) {
    const shown = escHtml(mobile)
    const number = mobileHref ? `<a href="${escAttr(mobileHref)}" style="color:${GREY};text-decoration:underline;">${shown}</a>` : `<span style="color:${GREY};">${shown}</span>`
    row('0 0 10px 0', ROW_TEXT, `<span style="color:${SAGE};">m:</span> ${number}`)
  }
  if (website) row('0 0 10px 0', ROW_TEXT, `<a href="${escAttr(website)}" style="color:${GREY};text-decoration:underline;">${escHtml(displayUrl(website))}</a>`)

  const socials: string[] = []
  const social = (key: keyof typeof SIGNATURE_ICON_PATHS, url: string | null, label: string) => {
    if (!url) return
    const B = SIGNATURE_SOCIAL_PX, L = SIGNATURE_SOCIAL_LOGO_PX
    socials.push(
      `<a href="${escAttr(url)}" aria-label="${label}" style="display:inline-block;width:${B}px;height:${B}px;line-height:${B}px;margin:0 7px 0 0;border:2px solid ${SAGE};border-radius:6px;text-align:center;text-decoration:none;">` +
        `<img src="${escAttr(iconUrl(key, env))}" width="${L}" height="${L}" alt="${label}" style="display:inline-block;width:${L}px;height:${L}px;border:0;vertical-align:middle;"></a>`,
    )
  }
  social('facebook', safeHttpUrl(sig.facebookUrl), 'Facebook')
  social('instagram', instagramUrl(sig.instagramUrl), 'Instagram')
  social('linkedin', safeHttpUrl(sig.linkedinUrl), 'LinkedIn')
  if (socials.length) rows.push(`<tr><td style="padding:8px 0 0 0;">${socials.join('')}</td></tr>`)

  if (!rows.length) return ''

  const textCell = `<td valign="top" style="border-left:4px solid ${SAGE};padding:8px 0 8px 18px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table></td>`

  // The photo box: a portrait upload fills it; an earlier SQUARE upload sits
  // as a 90×90 square in it; no photo → the initials; no initials → no box.
  const W = SIGNATURE_PHOTO_W, H = SIGNATURE_PHOTO_H
  const initials = photo ? '' : signatureInitials(name)
  let boxInner = ''
  if (photo) {
    const [iw, ih] = isPortraitSignaturePhotoPath(sig.photoPath) ? [W, H] : [W, W]
    boxInner = `<img src="${escAttr(photo)}" width="${iw}" height="${ih}" alt="${escHtml(name ?? '')}" style="display:block;width:${iw}px;height:${ih}px;border:0;">`
  } else if (initials) {
    boxInner = `<span style="font-size:30px;line-height:30px;font-weight:bold;color:${SAGE};">${escHtml(initials)}</span>`
  }
  const photoCell = boxInner
    ? `<td valign="top" style="padding:6px 16px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="${W}" height="${H}" align="center" valign="middle" bgcolor="${SIGNATURE_PHOTO_BG}" style="width:${W}px;height:${H}px;background:${SIGNATURE_PHOTO_BG};">${boxInner}</td></tr></table></td>`
    : ''

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="dm-text" style="margin:8px 0;font-family:${SIGNATURE_FONT};color:${GREY};"><tr>${photoCell}${textCell}</tr></table>`
}

// ── Plain text (the text/plain half of the email) ─────────────────────────
export function buildSignatureText(sig: EmailSignature): string {
  const out: string[] = []
  const name = clean(sig.name)
  const title = titleLine(sig)
  const email = safeEmail(sig.email)
  const mobile = clean(sig.mobile)
  const website = safeHttpUrl(sig.websiteUrl)
  if (name) out.push(name)
  if (title) out.push(title)
  if (email) out.push(email)
  if (mobile) out.push(`Mobile: ${mobile}`)
  if (website) out.push(displayUrl(website))
  const fb = safeHttpUrl(sig.facebookUrl)
  const ig = instagramUrl(sig.instagramUrl)
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
