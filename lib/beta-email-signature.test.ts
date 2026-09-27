// The {{signature}} merge tag — lib/email-signature.ts (layout + placeholder),
// lib/email-signature-resolve.ts (who signs), and the three client-email body
// builders that learned it (branded drip layout, plain bodyToHtml, both
// follow-up paths).
//
// THE ONE THIS FILE EXISTS FOR: nothing an owner typed is ever rendered as
// HTML. The signature is the only unescaped HTML that reaches a client email,
// and every value poured into it is owner-typed (name, title, email, mobile,
// four links, a photo path). The "hostile values" block below is the guard; it
// was mutation-tested — dropping the escaping on a single field fails it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── A fake supabaseService for the resolver ───────────────────────────────
// Only the query shapes lib/email-signature-resolve.ts uses. `db.missing`
// simulates migrations/email_signatures.sql not having run: any select naming
// one of the new columns errors, exactly as PostgREST does.
type Row = Record<string, any>
const db: {
  hub_users: Row[]
  seats: Row[]
  locations: Row[]
  missing: boolean
  throwAll: boolean
} = { hub_users: [], seats: [], locations: [], missing: false, throwAll: false }

const NEW_COLS = /signature_title|signature_photo_path|website_url|facebook_url|instagram_url|linkedin_url/

function fakeFrom(table: string) {
  if (db.throwAll) throw new Error('db down')
  let cols = ''
  const filters: [string, any][] = []
  const run = () => {
    if (NEW_COLS.test(cols) && db.missing) {
      return { data: null, error: { message: `column ${cols.split(',')[0]} does not exist` } }
    }
    const src = table === 'hub_users' ? db.hub_users : table === 'subscription_seats' ? db.seats : table === 'locations' ? db.locations : []
    const rows = src.filter((r) => filters.every(([k, v]) => r[k] === v))
    return { data: rows, error: null }
  }
  const b: any = {
    select(c: string) { cols = c; return b },
    eq(k: string, v: any) { filters.push([k, v]); return b },
    maybeSingle() { const r = run(); return Promise.resolve({ data: r.error ? null : (r.data![0] ?? null), error: r.error }) },
    then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
  }
  return b
}

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => fakeFrom(t) } }))
vi.mock('./supabase-service', () => ({ supabaseService: { from: (t: string) => fakeFrom(t) } }))

const ownerByLocation: Record<string, string | null> = {}
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: async (loc: string) => {
    const id = ownerByLocation[loc]
    return id ? { id, email: null, full_name: null, phone: null } : null
  },
}))
vi.mock('./owner-resolution', () => ({
  getPrimaryOwnerForLocation: async (loc: string) => {
    const id = ownerByLocation[loc]
    return id ? { id, email: null, full_name: null, phone: null } : null
  },
}))

import {
  buildSignatureHtml,
  buildSignatureText,
  SIGNATURE_MARKER,
  SIGNATURE_NAME_COLOR,
  SIGNATURE_TITLE_COLOR,
  SIGNATURE_PHOTO_ROUTE,
  EMPTY_SIGNATURE,
  safeHttpUrl,
  type EmailSignature,
} from '@/lib/email-signature'
import {
  chooseSignaturePerson,
  assembleSignature,
  resolveEmailSignature,
  type SignatureCandidate,
} from '@/lib/email-signature-resolve'
import { renderTemplate } from '@/lib/resend'
import { buildBrandedDripHtml, buildBrandedDripText, DRIP_WEBSITE_URL } from '@/lib/drip-email-layout'
import { bodyToHtml } from '@/lib/drip-send'
import { renderStageEmailContent } from '@/lib/stage-emails'

const APP = 'https://beehive.beeorganized.com'
const saved = { app: process.env.NEXT_PUBLIC_APP_URL, site: process.env.NEXT_PUBLIC_SITE_URL }
// Image URLs are built from the app origin at render time. Several describe
// blocks render at collection time (before any beforeEach), so pin it here too.
process.env.NEXT_PUBLIC_APP_URL = APP
beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = APP
  db.hub_users = []
  db.seats = []
  db.locations = []
  db.missing = false
  db.throwAll = false
  for (const k of Object.keys(ownerByLocation)) delete ownerByLocation[k]
})
afterEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = saved.app
  process.env.NEXT_PUBLIC_SITE_URL = saved.site
})

const LOC = '11111111-1111-4111-8111-111111111111'
const OTHER_LOC = '22222222-2222-4222-8222-222222222222'
const JANE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PHOTO = `${JANE}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg`

const FULL: EmailSignature = {
  name: 'Jane Smith',
  title: 'Owner & Lead Organizer',
  email: 'jane@beeorganized.com',
  mobile: '(303) 555-0147',
  photoPath: PHOTO,
  websiteUrl: 'https://beeorganized.com/boulder',
  facebookUrl: 'https://www.facebook.com/beeorganizedboulder',
  instagramUrl: 'https://www.instagram.com/beeorganizedboulder',
  linkedinUrl: 'https://www.linkedin.com/company/bee-organized-boulder',
}

// ── Structural guard helpers ────────────────────────────────────────────
// Every tag in signature HTML must be one the layout itself writes, carrying
// only attributes the layout writes, each a double-quoted value with no raw
// quote or angle bracket inside. Anything an owner smuggled in as markup
// would show up here as an unknown tag, an unknown attribute, or a broken
// attribute string.
const OK_TAGS = new Set(['table', 'tr', 'td', 'div', 'a', 'img', 'p', 'br'])
const OK_ATTRS = new Set(['role', 'cellpadding', 'cellspacing', 'border', 'style', 'valign', 'href', 'src', 'width', 'height', 'alt'])
function assertOnlyLayoutMarkup(html: string) {
  const tagRe = /<\/?([a-zA-Z0-9]+)([^>]*)>/g
  let m: RegExpExecArray | null
  let consumed = ''
  while ((m = tagRe.exec(html)) !== null) {
    const [, name, rest] = m
    expect(OK_TAGS.has(name.toLowerCase()), `unexpected tag <${name}>`).toBe(true)
    const attrs = rest.replace(/\s*\/$/, '')
    const leftover = attrs.replace(/\s+([a-z-]+)="([^"<>]*)"/g, (_all, a: string) => {
      expect(OK_ATTRS.has(a), `unexpected attribute ${a} on <${name}>`).toBe(true)
      return ''
    })
    expect(leftover.trim(), `unparsed attribute text on <${name}>: ${leftover}`).toBe('')
    consumed += m[0]
  }
  // Outside tags there must be no raw "<" at all.
  const textOnly = html.replace(tagRe, '')
  expect(textOnly.includes('<'), `raw "<" in text: ${textOnly}`).toBe(false)
  expect(textOnly.includes('>'), `raw ">" in text: ${textOnly}`).toBe(false)
  // Every link and image points only where the layout means it to.
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    expect(/^(https?:\/\/|mailto:|tel:)/.test(href), `bad href ${href}`).toBe(true)
  }
  for (const [, src] of html.matchAll(/src="([^"]*)"/g)) {
    expect(src.startsWith(`${APP}/`), `image not on our domain: ${src}`).toBe(true)
  }
  // …and no dangerous scheme inside any real tag (escaped TEXT may show one).
  expect(/<[^>]*(javascript:|data:|vbscript:)/i.test(html)).toBe(false)
  return consumed
}

// ─────────────────────────────────────────────────────────────────────────
describe('a person with everything set renders the full layout', () => {
  const html = buildSignatureHtml(FULL)

  it('headshot on the left: square, fixed size, from OUR domain, alt = their name', () => {
    expect(html).toContain(`<img src="${APP}${SIGNATURE_PHOTO_ROUTE}/${PHOTO}" width="80" height="80" alt="Jane Smith"`)
    expect(html).not.toContain('supabase.co')
    // photo cell comes before the text cell
    expect(html.indexOf(SIGNATURE_PHOTO_ROUTE)).toBeLessThan(html.indexOf('Jane Smith</div>'))
  })

  it('a vertical rule between photo and text', () => {
    expect(html).toMatch(/border-left:2px solid #A8C9C4;/)
  })

  it('name in the pale green brand colour, larger and bold', () => {
    expect(html).toContain(`<div style="font-size:18px;line-height:1.3;font-weight:bold;color:${SIGNATURE_NAME_COLOR};">Jane Smith</div>`)
  })

  it('title bold italic grey', () => {
    expect(html).toContain(`font-weight:bold;font-style:italic;color:${SIGNATURE_TITLE_COLOR};`)
    expect(html).toContain('Owner &amp; Lead Organizer')
  })

  it('email linked, "m:" then the mobile linked, website linked', () => {
    expect(html).toContain('href="mailto:jane@beeorganized.com"')
    expect(html).toContain('>jane@beeorganized.com</a>')
    expect(html).toContain('m:&nbsp;<a href="tel:3035550147"')
    expect(html).toContain('>(303) 555-0147</a>')
    expect(html).toContain('href="https://beeorganized.com/boulder"')
    expect(html).toContain('>beeorganized.com/boulder</a>')
  })

  it('Facebook, Instagram and LinkedIn icons in a row, in that order, each alt-labelled', () => {
    const fb = html.indexOf('alt="Facebook"')
    const ig = html.indexOf('alt="Instagram"')
    const li = html.indexOf('alt="LinkedIn"')
    expect(fb).toBeGreaterThan(-1)
    expect(ig).toBeGreaterThan(fb)
    expect(li).toBeGreaterThan(ig)
    expect(html).toContain(`src="${APP}/email-signature/facebook.png" width="24" height="24"`)
    expect(html).toContain('href="https://www.instagram.com/beeorganizedboulder"')
  })

  it('field order: name, title, email, mobile, website, socials', () => {
    const order = ['Jane Smith', 'Owner &amp;', 'mailto:', 'm:&nbsp;', 'beeorganized.com/boulder</a>', 'alt="Facebook"'].map((s) => html.indexOf(s))
    expect(order.every((v) => v > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('only the layout’s own markup', () => {
    assertOnlyLayoutMarkup(html)
  })

  it('the plain-text half reads properly on its own', () => {
    expect(buildSignatureText(FULL)).toBe(
      [
        'Jane Smith',
        'Owner & Lead Organizer',
        'jane@beeorganized.com',
        'm: (303) 555-0147',
        'beeorganized.com/boulder',
        'Facebook: https://www.facebook.com/beeorganizedboulder',
        'Instagram: https://www.instagram.com/beeorganizedboulder',
        'LinkedIn: https://www.linkedin.com/company/bee-organized-boulder',
      ].join('\n'),
    )
  })
})

describe('a person with no photo still renders and reads properly', () => {
  const html = buildSignatureHtml({ ...FULL, photoPath: null })

  it('no photo cell and no orphan rule — the text stands alone', () => {
    expect(html).not.toContain(SIGNATURE_PHOTO_ROUTE)
    expect(html).not.toContain('border-left')
    expect(html).not.toContain('alt="Jane Smith"')
  })

  it('everything else is still there', () => {
    for (const s of ['Jane Smith', 'Owner &amp; Lead Organizer', 'mailto:jane@beeorganized.com', 'tel:3035550147', 'beeorganized.com/boulder', 'alt="LinkedIn"']) {
      expect(html).toContain(s)
    }
    assertOnlyLayoutMarkup(html)
  })

  it('a photo path that is not one our upload route minted is treated as no photo', () => {
    for (const bad of ['https://evil.example/x.jpg', '../../secret.jpg', `${JANE}/x.jpg`, `${PHOTO}?x=1`, `${JANE}/cccccccc-cccc-4ccc-8ccc-cccccccccccc.gif`]) {
      const h = buildSignatureHtml({ ...FULL, photoPath: bad })
      expect(h, bad).not.toContain('<img src="https://evil')
      expect(h, bad).not.toContain(SIGNATURE_PHOTO_ROUTE)
    }
  })

  it('a name alone is still a signature; nothing at all is empty', () => {
    const nameOnly = buildSignatureHtml({ ...EMPTY_SIGNATURE, name: 'Bee Organized Boulder' })
    expect(nameOnly).toContain('>Bee Organized Boulder</div>')
    expect(buildSignatureHtml(EMPTY_SIGNATURE)).toBe('')
    expect(buildSignatureText(EMPTY_SIGNATURE)).toBe('')
  })
})

describe('the website and social links are the LOCATION’s, not corporate’s', () => {
  const person = {
    id: JANE, full_name: 'Jane Smith', email: 'jane@beeorganized.com', phone: '303-555-0147',
    is_active: true, disabled_at: null, location_id: LOC, signature_title: null, signature_photo_path: null,
  }

  it('the location’s links fill the signature', () => {
    const sig = assembleSignature(person, {
      website_url: 'https://beeorganized.com/boulder',
      facebook_url: 'https://facebook.com/boulderbees',
      instagram_url: null,
      linkedin_url: null,
    }, 'Boulder')
    const html = buildSignatureHtml(sig)
    expect(html).toContain('href="https://beeorganized.com/boulder"')
    expect(html).toContain('href="https://facebook.com/boulderbees"')
    expect(html).not.toContain('alt="Instagram"')
    expect(html).not.toContain('alt="LinkedIn"')
  })

  it('a location with no links shows none — never the corporate website', () => {
    const html = buildSignatureHtml(assembleSignature(person, { website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null }, 'Boulder'))
    expect(html).not.toContain(DRIP_WEBSITE_URL)
    expect(html).not.toContain('alt="Facebook"')
    expect(html).toContain('Jane Smith')
  })

  it('end to end through the resolver: the links come from THIS lead’s location row', async () => {
    db.hub_users = [{ ...person }]
    db.locations = [
      { id: LOC, website_url: 'https://beeorganized.com/boulder', facebook_url: null, instagram_url: 'https://instagram.com/boulder', linkedin_url: null },
      { id: OTHER_LOC, website_url: 'https://beeorganized.com/denver', facebook_url: 'https://facebook.com/denver', instagram_url: null, linkedin_url: null },
    ]
    const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
    expect(sig.websiteUrl).toBe('https://beeorganized.com/boulder')
    expect(sig.instagramUrl).toBe('https://instagram.com/boulder')
    expect(sig.facebookUrl).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the fallback chain: assignee active HERE → primary owner active HERE → the location', () => {
  const cand = (over: Record<string, any> = {}, seats: string[] = []): SignatureCandidate => ({
    person: { id: JANE, full_name: 'Jane Smith', email: null, phone: null, is_active: true, disabled_at: null, location_id: LOC, ...over },
    seatLocationIds: seats,
  })
  const owner = (over: Record<string, any> = {}): SignatureCandidate => ({
    person: { id: OWNER, full_name: 'Olivia Owner', email: null, phone: null, is_active: true, disabled_at: null, location_id: LOC, ...over },
    seatLocationIds: [],
  })

  it('an active assignee at this location signs', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: cand(), owner: owner() })?.id).toBe(JANE)
  })

  it('an INACTIVE assignee falls through to the owner', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: cand({ is_active: false }), owner: owner() })?.id).toBe(OWNER)
  })

  it('an access-removed assignee falls through to the owner', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: cand({ disabled_at: '2026-09-01T00:00:00Z' }), owner: owner() })?.id).toBe(OWNER)
  })

  it('an assignee at the WRONG location falls through to the owner', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: cand({ location_id: OTHER_LOC }), owner: owner() })?.id).toBe(OWNER)
  })

  it('a corporate import stamp (no location) falls through to the owner', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: cand({ location_id: null }), owner: owner() })?.id).toBe(OWNER)
  })

  it('an active seat at this location counts even when hub_users.location_id points elsewhere', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: cand({ location_id: OTHER_LOC }, [LOC]), owner: owner() })?.id).toBe(JANE)
  })

  it('an owner who is ALSO not active here is skipped too → nobody', () => {
    expect(chooseSignaturePerson({ locationId: LOC, assignee: null, owner: owner({ is_active: false }) })).toBeNull()
    expect(chooseSignaturePerson({ locationId: LOC, assignee: null, owner: owner({ location_id: OTHER_LOC }) })).toBeNull()
  })

  it('nobody → the location signs: "Bee Organized <Location>", with the location’s links', () => {
    const sig = assembleSignature(null, { website_url: 'https://beeorganized.com/boulder', facebook_url: null, instagram_url: null, linkedin_url: null }, 'Boulder')
    expect(sig.name).toBe('Bee Organized Boulder')
    expect(sig.email).toBeNull()
    expect(sig.photoPath).toBeNull()
    expect(sig.websiteUrl).toBe('https://beeorganized.com/boulder')
    expect(assembleSignature(null, { website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null }, 'Bee Organized Denver').name).toBe('Bee Organized Denver')
    expect(assembleSignature(null, { website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null }, null).name).toBe('Bee Organized')
  })

  describe('through the real resolver', () => {
    beforeEach(() => {
      db.hub_users = [
        { id: JANE, full_name: 'Jane Smith', email: 'jane@beeorganized.com', phone: '303-555-0147', is_active: true, disabled_at: null, location_id: LOC, signature_title: 'Lead Organizer', signature_photo_path: PHOTO },
        { id: OWNER, full_name: 'Olivia Owner', email: 'olivia@beeorganized.com', phone: '303-555-0100', is_active: true, disabled_at: null, location_id: LOC, signature_title: 'Owner', signature_photo_path: null },
      ]
      db.locations = [{ id: LOC, website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null }]
      ownerByLocation[LOC] = OWNER
    })

    it('active assignee: their name, title, email, mobile and photo', async () => {
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
      expect(sig).toMatchObject({ name: 'Jane Smith', title: 'Lead Organizer', email: 'jane@beeorganized.com', mobile: '303-555-0147', photoPath: PHOTO })
    })

    it('inactive assignee → the owner signs', async () => {
      db.hub_users[0].is_active = false
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
      expect(sig).toMatchObject({ name: 'Olivia Owner', title: 'Owner', email: 'olivia@beeorganized.com' })
    })

    it('assignee at the wrong location → the owner signs', async () => {
      db.hub_users[0].location_id = OTHER_LOC
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
      expect(sig.name).toBe('Olivia Owner')
    })

    it('no assignee at all → the owner signs', async () => {
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: null })
      expect(sig.name).toBe('Olivia Owner')
    })

    it('nothing set — no eligible person, no owner — → "Bee Organized Boulder", never blank', async () => {
      db.hub_users[0].is_active = false
      ownerByLocation[LOC] = null
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
      expect(sig.name).toBe('Bee Organized Boulder')
      expect(sig.email).toBeNull()
      expect(buildSignatureHtml(sig)).toContain('>Bee Organized Boulder</div>')
    })

    it('before the migration runs: name, email and mobile only — no title, no photo, no links', async () => {
      db.missing = true
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
      expect(sig).toMatchObject({ name: 'Jane Smith', email: 'jane@beeorganized.com', mobile: '303-555-0147', title: null, photoPath: null, websiteUrl: null })
    })

    it('never throws — a dead database still yields the location signature', async () => {
      db.throwAll = true
      const sig = await resolveEmailSignature({ locationId: LOC, locationName: 'Boulder', assigneeUserId: JANE })
      expect(sig.name).toBe('Bee Organized Boulder')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('{{signature}} in a subject line is empty', () => {
  const tpl = { subject: 'A note from {{signature}} at {{location_name}}', body: 'Hi {{first_name}},\n\nThank you,\n{{signature}}' }

  it('with the marker option (client email sends)', () => {
    const r = renderTemplate(tpl, { first_name: 'John', location_name: 'Boulder' }, { signatureMarker: true })
    expect(r.subject).toBe('A note from  at Boulder')
    expect(r.subject).not.toContain(SIGNATURE_MARKER)
    expect(r.body).toBe(`Hi John,\n\nThank you,\n${SIGNATURE_MARKER}`)
  })

  it('without it (every other caller) the tag is simply empty, body and subject alike', () => {
    const r = renderTemplate(tpl, { first_name: 'John', location_name: 'Boulder' })
    expect(r.subject).toBe('A note from  at Boulder')
    expect(r.body).toBe('Hi John,\n\nThank you,\n')
    expect(r.body).not.toContain(SIGNATURE_MARKER)
  })

  it('a subject that is ONLY the tag renders blank — which the send-time subject guard then holds', () => {
    expect(renderTemplate({ subject: '{{signature}}', body: 'x' }, {}, { signatureMarker: true }).subject.trim()).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('both email layouts render it — where it was typed, once, and nowhere else', () => {
  const body = renderTemplate(
    { subject: 's', body: 'Hi {{first_name}},\n\nThanks for reaching out.\n\nThank you,\n{{signature}}\n\nBe sure to check out our Google Reviews!' },
    { first_name: 'John' },
    { signatureMarker: true },
  ).body
  const brandCtx = { location_name: 'Boulder', location_phone: '(303) 555-0100', reviews_link: null, signature: FULL }
  const count = (h: string, s: string) => h.split(s).length - 1

  function checkPlacement(html: string) {
    expect(count(html, '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 18px;">')).toBe(1)
    const thanks = html.indexOf('Thank you,')
    const sig = html.indexOf(SIGNATURE_PHOTO_ROUTE)
    const reviews = html.indexOf('Be sure to check out')
    expect(thanks).toBeGreaterThan(-1)
    expect(sig).toBeGreaterThan(thanks)
    expect(reviews).toBeGreaterThan(sig)
    // signs ONCE: the name appears exactly once (alt text aside)
    expect(count(html, 'Jane Smith</div>')).toBe(1)
    expect(html).not.toContain(SIGNATURE_MARKER)
  }

  it('branded layout (drips, estimate follow-ups): HTML and text', () => {
    checkPlacement(buildBrandedDripHtml(body, brandCtx))
    const text = buildBrandedDripText(body, brandCtx)
    expect(text).toContain('Thank you,\nJane Smith\nOwner & Lead Organizer\njane@beeorganized.com\nm: (303) 555-0147')
    expect(text).not.toContain(SIGNATURE_MARKER)
  })

  it('plain layout (bodyToHtml — 3- and 12-month follow-ups, welcome)', () => {
    checkPlacement(bodyToHtml(body, FULL))
  })

  it('both follow-up paths through renderStageEmailContent', () => {
    for (const key of ['opp_closed_job_3mo', 'opp_closed_job_12mo', 'opp_organizing_estimate_3d']) {
      const { html, text } = renderStageEmailContent(key, body, brandCtx)
      checkPlacement(html)
      expect(text).toContain('Jane Smith\nOwner & Lead Organizer')
      expect(text).not.toContain(SIGNATURE_MARKER)
    }
  })

  it('no tag in the body → byte-identical to before (no signature, no stray marker)', () => {
    const plain = 'Hi John,\n\nThank you,\nJane'
    expect(bodyToHtml(plain, FULL)).toBe(bodyToHtml(plain))
    expect(buildBrandedDripHtml(plain, brandCtx)).toBe(buildBrandedDripHtml(plain, { ...brandCtx, signature: null }))
  })

  it('a marker with no resolved signature is dropped, never shown', () => {
    for (const h of [bodyToHtml(body, null), buildBrandedDripHtml(body, { ...brandCtx, signature: null }), buildBrandedDripText(body, { ...brandCtx, signature: null })]) {
      expect(h).not.toContain(SIGNATURE_MARKER)
      expect(h).not.toContain('')
      expect(h).toContain('Thank you,')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// PIN THIS HARDEST: nothing an owner typed is ever rendered as HTML.
describe('nothing an owner typed is ever rendered as HTML', () => {
  const HOSTILE: EmailSignature = {
    name: '<script>alert("name")</script><img src=x onerror=alert(1)>',
    title: '"><b onmouseover="alert(1)">Boss</b><a href="javascript:alert(1)">x</a>',
    email: 'jane@evil.com"><script>alert(1)</script>',
    mobile: '<img src=x onerror=alert(2)> 303 555 0147',
    photoPath: '"><script>alert(3)</script>',
    websiteUrl: 'javascript:alert(4)',
    facebookUrl: 'https://facebook.com/x"onmouseover="alert(5)',
    instagramUrl: 'data:text/html,<script>alert(6)</script>',
    linkedinUrl: 'https://linkedin.com/in/x?a=<script>alert(7)</script>',
  }
  const html = buildSignatureHtml(HOSTILE)

  it('only the layout’s own tags and attributes survive — no script, no handler, no foreign link', () => {
    assertOnlyLayoutMarkup(html)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i) // no handler attribute inside any real tag
  })

  it('a hostile name WITH a real photo: the alt text is escaped too', () => {
    const withPhoto = buildSignatureHtml({ ...HOSTILE, photoPath: PHOTO })
    assertOnlyLayoutMarkup(withPhoto)
    expect(withPhoto).toContain('alt="&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;')
  })

  it('the hostile text is SHOWN, escaped, not executed', () => {
    expect(html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&quot;&gt;&lt;b onmouseover=&quot;alert(1)&quot;&gt;Boss&lt;/b&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt; 303 555 0147')
  })

  it('bad links and a bad email are dropped, not rendered; hostile characters in a real link are percent-encoded', () => {
    expect(html).not.toContain('mailto:jane@evil.com')
    expect(safeHttpUrl('javascript:alert(4)')).toBeNull()
    expect(safeHttpUrl('data:text/html,x')).toBeNull()
    expect(html).not.toContain('alt="Instagram"')
    expect(html).toContain('href="https://facebook.com/x%22onmouseover=%22alert(5)"')
    expect(html).toContain('href="https://linkedin.com/in/x?a=%3Cscript%3Ealert(7)%3C/script%3E"')
  })

  it('the plain-text half carries the hostile text as text (text/plain is never rendered as HTML)', () => {
    const text = buildSignatureText(HOSTILE)
    expect(text.split('\n')[0]).toBe(HOSTILE.name)
    // rejected links are left out of the text version too
    expect(text).not.toContain('javascript:alert(4)')
    expect(text).not.toContain('data:text/html')
  })

  it('owner-typed BODY text around the tag is escaped by both layouts, and only the layout’s markup is unescaped', () => {
    const body = renderTemplate(
      { subject: 's', body: '<b>Hi</b> {{first_name}} <img src=x onerror=alert(8)>\n\nThank you,\n{{signature}}\n\n<table><tr><td>fake sig</td></tr></table>' },
      { first_name: '<script>alert(9)</script>' },
      { signatureMarker: true },
    ).body
    for (const out of [
      bodyToHtml(body, HOSTILE),
      buildBrandedDripHtml(body, { location_name: 'Boulder', signature: HOSTILE }),
      renderStageEmailContent('opp_closed_job_3mo', body, { location_name: 'Boulder', signature: HOSTILE }).html,
    ]) {
      expect(out).not.toMatch(/<script/i)
      expect(out).not.toMatch(/<img src=x/i)
      expect(out).not.toMatch(/<[^>]*\son[a-z]+\s*=/i) // no handler attribute inside any real tag
      expect(out).not.toContain('<b>Hi</b>')
      expect(out).not.toContain('<td>fake sig</td>')
      expect(out).toContain('&lt;b&gt;Hi&lt;/b&gt;')
      expect(out).toContain('&lt;script&gt;alert(9)&lt;/script&gt;')
      // exactly one signature table, and it is the layout's
      expect(out.split('border-collapse:collapse;margin:0 0 18px;').length - 1).toBe(1)
    }
  })

  it('an owner cannot TYPE the placeholder to smuggle markup: a typed marker only ever yields our own signature', () => {
    const typed = `hello ${SIGNATURE_MARKER} <i>x</i>`
    const out = bodyToHtml(typed, FULL)
    expect(out).toContain('&lt;i&gt;x&lt;/i&gt;')
    expect(out).not.toContain('<i>x</i>')
  })
})
