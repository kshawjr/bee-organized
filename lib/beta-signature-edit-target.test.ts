// WHOSE signature the Settings card edits — Kevin's option 1 (2026-09-27).
//
// The bug this pins: Kevin, signed in as HIMSELF and viewing Southwest
// Austin, uploaded a headshot and typed "Owner"; both saved onto Kevin's own
// account (a super admin with no location, who never signs a client email)
// while the preview — correctly — kept showing Raluca Sharma, whose fields
// stayed empty. Now the card shows and edits the person the preview shows,
// names them, and the server writes ONLY to that person.
//
// These tests drive the REAL route handlers (GET/PATCH /api/signature,
// POST /api/signature/photo) against a recording fake database, so "where did
// the save land" is asserted on the actual write, not on a helper. The
// headline test was mutation-tested: making PATCH write to the signed-in user
// (the bug as it stood) fails it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── People and places ─────────────────────────────────────────────────────
const SWA = 'c95aa42d-a106-4fb4-bc75-5d9a297981af' // Southwest Austin
const BOULDER = '11111111-1111-4111-8111-111111111111'
const KEVIN = '63785d40-38fe-4390-ad9e-6072ddfb6df9'
const RALUCA = '4793ff14-a42b-42aa-bc11-0ffb96b7f9a9'
const DANA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'   // owner, Boulder
const MIKE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'   // manager, Southwest Austin
const KEVIN_PHOTO = `${KEVIN}/26400a1e-7d32-4723-b87f-1fad29f1fca1.jpg`
const DANA_PHOTO = `${DANA}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`
const RALUCA_NEW_PHOTO = `${RALUCA}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`

type Row = Record<string, any>
const state: {
  users: Row[]
  locations: Row[]
  seats: Row[]
  owners: Record<string, string | null>
  bucket: Set<string>
  updates: { table: string; id: any; patch: Row }[]
  signedPaths: string[]
  caller: Row | null
  // migrations/signature_linkedin.sql not run: a select naming the column errors.
  noLinkedinColumn: boolean
} = { users: [], locations: [], seats: [], owners: {}, bucket: new Set(), updates: [], signedPaths: [], caller: null, noLinkedinColumn: false }

function reset() {
  state.users = [
    { id: KEVIN, full_name: 'Kevin Shaw', email: 'kevin@bmave.com', phone: '555-000-0000', role: 'super_admin', is_active: true, disabled_at: null, location_id: null, signature_title: 'Owner', signature_photo_path: KEVIN_PHOTO },
    { id: RALUCA, full_name: 'Raluca Sharma', email: 'raluca@beeorganized.com', phone: '8322057617', role: 'owner', is_active: true, disabled_at: null, location_id: SWA, signature_title: null, signature_photo_path: null },
    { id: DANA, full_name: 'Dana Diaz', email: 'dana@beeorganized.com', phone: '303-555-0147', role: 'owner', is_active: true, disabled_at: null, location_id: BOULDER, signature_title: 'Owner & Lead Organizer', signature_photo_path: DANA_PHOTO },
    { id: MIKE, full_name: 'Mike Moss', email: 'mike@beeorganized.com', phone: '512-555-0100', role: 'manager', is_active: true, disabled_at: null, location_id: SWA, signature_title: null, signature_photo_path: null },
  ]
  state.locations = [
    { id: SWA, name: 'Southwest Austin', website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null },
    { id: BOULDER, name: 'Boulder', website_url: null, facebook_url: null, instagram_url: null, linkedin_url: null },
  ]
  state.seats = [{ user_id: RALUCA, location_id: SWA, status: 'active' }]
  state.owners = { [SWA]: RALUCA, [BOULDER]: DANA }
  state.bucket = new Set([KEVIN_PHOTO, DANA_PHOTO, RALUCA_NEW_PHOTO])
  state.updates = []
  state.signedPaths = []
  state.caller = null
  state.noLinkedinColumn = false
}

function table(name: string): Row[] {
  if (name === 'hub_users') return state.users
  if (name === 'locations') return state.locations
  if (name === 'subscription_seats') return state.seats
  return []
}

function fakeFrom(name: string) {
  const filters: [string, any][] = []
  let patch: Row | null = null
  const rows = () => table(name).filter((r) => filters.every(([k, v]) => r[k] === v))
  let missing = false
  const b: any = {
    select(cols?: string) { if (state.noLinkedinColumn && name === 'hub_users' && /signature_linkedin_url/.test(cols || '')) missing = true; return b },
    eq(k: string, v: any) {
      filters.push([k, v])
      if (patch) {
        // update(...).eq('id', X) — record AND apply, like the database.
        state.updates.push({ table: name, id: v, patch })
        for (const r of rows()) Object.assign(r, patch)
        return Promise.resolve({ data: null, error: null })
      }
      return b
    },
    update(p: Row) { patch = p; return b },
    maybeSingle() {
      if (missing) return Promise.resolve({ data: null, error: { message: 'column hub_users.signature_linkedin_url does not exist' } })
      return Promise.resolve({ data: rows()[0] ?? null, error: null })
    },
    single() { return Promise.resolve({ data: rows()[0] ?? null, error: null }) },
    then(res: any, rej: any) { return Promise.resolve({ data: rows(), error: null }).then(res, rej) },
  }
  return b
}

function fakeStorage() {
  return {
    list: async (folder: string, opts: { search: string }) => ({
      data: [...state.bucket].filter((p) => p === `${folder}/${opts.search}`).map((p) => ({ name: p.split('/')[1] })),
      error: null,
    }),
    createSignedUploadUrl: async (path: string) => {
      state.signedPaths.push(path)
      return { data: { token: 'tok' }, error: null }
    },
  }
}

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => fakeFrom(t), storage: { from: () => fakeStorage() } },
}))
vi.mock('@/lib/auth', () => ({
  getHubUser: async () => state.caller,
  isAdmin: (role: string) => role === 'super_admin' || role === 'admin',
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: async (loc: string) => {
    const id = state.owners[loc]
    const u = state.users.find((x) => x.id === id)
    return u ? { id: u.id, email: u.email, full_name: u.full_name, phone: u.phone } : null
  },
}))

import { GET, PATCH } from '@/app/api/signature/route'
import { POST as PHOTO_POST } from '@/app/api/signature/photo/route'
import {
  signatureEditTarget,
  signatureCardHeading,
  NO_LINKS_NOTE,
} from '@/lib/email-signature-edit'
import { buildSignatureHtml, buildSignatureText, SIGNATURE_PHOTO_ROUTE, SIGNATURE_MARKER } from '@/lib/email-signature'
import { buildBrandedDripHtml, buildBrandedDripText } from '@/lib/drip-email-layout'
import { bodyToHtml } from '@/lib/drip-send'
import { assembleSignature, NO_LINKS, resolveEmailSignature } from '@/lib/email-signature-resolve'
import { signatureFromData } from '@/components/settings/EmailsScreen'

process.env.NEXT_PUBLIC_APP_URL = 'https://beehive.beeorganized.com'

const as = (id: string) => { state.caller = { ...state.users.find((u) => u.id === id)! } }
const user = (id: string) => state.users.find((u) => u.id === id)!
async function get(locationId?: string) {
  const url = `http://localhost/api/signature${locationId ? `?locationId=${locationId}` : ''}`
  const res = await GET(new NextRequest(url))
  return { status: res.status, body: await res.json() }
}
async function patch(body: Row) {
  const res = await PATCH(new NextRequest('http://localhost/api/signature', { method: 'PATCH', body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() }
}
async function signPhoto(body: Row) {
  const res = await PHOTO_POST(new NextRequest('http://localhost/api/signature/photo', { method: 'POST', body: JSON.stringify({ type: 'image/jpeg', size: 30000, ...body }) }))
  return { status: res.status, body: await res.json() }
}

beforeEach(reset)

// ─────────────────────────────────────────────────────────────────────────
describe('viewing another location edits THAT location’s signature, not your own', () => {
  it('Kevin at Southwest Austin: the title saves onto Raluca Sharma — Kevin’s own row is untouched', async () => {
    as(KEVIN)
    const r = await patch({ locationId: SWA, targetUserId: RALUCA, signature_title: 'Owner' })
    expect(r.status).toBe(200)
    expect(state.updates.map((u) => u.id)).toEqual([RALUCA])
    expect(user(RALUCA).signature_title).toBe('Owner')
    expect(state.updates.some((u) => u.id === KEVIN)).toBe(false)
  })

  it('the photo is minted into Raluca’s folder and saved onto Raluca', async () => {
    as(KEVIN)
    const signed = await signPhoto({ locationId: SWA, targetUserId: RALUCA })
    expect(signed.status).toBe(200)
    expect(signed.body.path.startsWith(`${RALUCA}/`)).toBe(true)
    expect(state.signedPaths.every((p) => !p.startsWith(`${KEVIN}/`))).toBe(true)

    const saved = await patch({ locationId: SWA, targetUserId: RALUCA, signature_photo_path: RALUCA_NEW_PHOTO })
    expect(saved.status).toBe(200)
    expect(user(RALUCA).signature_photo_path).toBe(RALUCA_NEW_PHOTO)
    expect(user(KEVIN).signature_photo_path).toBe(KEVIN_PHOTO) // unchanged
  })

  it('a photo from Kevin’s own folder can’t be put on Raluca’s signature', async () => {
    as(KEVIN)
    const r = await patch({ locationId: SWA, targetUserId: RALUCA, signature_photo_path: KEVIN_PHOTO })
    expect(r.status).toBe(400)
    expect(state.updates).toEqual([])
  })

  it('GET shows Raluca’s fields, never Kevin’s "Owner" and photo', async () => {
    as(KEVIN)
    const { body } = await get(SWA)
    expect(body.target.targetId).toBe(RALUCA)
    expect(body.person).toMatchObject({ id: RALUCA, name: 'Raluca Sharma', title: null, photoUrl: null })
    expect(body.preview.html).not.toContain('Owner')
    expect(body.preview.html).not.toContain(KEVIN)
  })

  it('a stale card (it named someone else) is refused — nothing is written', async () => {
    as(KEVIN)
    const mine = await patch({ locationId: SWA, targetUserId: KEVIN, signature_title: 'Owner' })
    expect(mine.status).toBe(409)
    const missing = await patch({ locationId: SWA, signature_title: 'Owner' })
    expect(missing.status).toBe(409)
    const photo = await signPhoto({ locationId: SWA, targetUserId: KEVIN })
    expect(photo.status).toBe(409)
    expect(state.updates).toEqual([])
    expect(state.signedPaths).toEqual([])
  })

  it('an admin (not only super_admin) may edit a location’s signer too', async () => {
    state.users.push({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', full_name: 'Corp Admin', email: 'a@b.co', phone: null, role: 'admin', is_active: true, disabled_at: null, location_id: null })
    as('ffffffff-ffff-4fff-8fff-ffffffffffff')
    const r = await patch({ locationId: BOULDER, targetUserId: DANA, signature_title: 'Founder' })
    expect(r.status).toBe(200)
    expect(state.updates.map((u) => u.id)).toEqual([DANA])
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the card names whose signature it is', () => {
  it('Kevin at Southwest Austin sees "Raluca Sharma’s signature" and is told it is not his own', async () => {
    as(KEVIN)
    const { body } = await get(SWA)
    expect(body.target.heading).toBe('Raluca Sharma’s signature')
    expect(body.target.isSelf).toBe(false)
    expect(body.target.canEdit).toBe(true)
    expect(body.target.explainer).toContain('You are editing Raluca Sharma’s signature, not your own.')
    expect(body.target.explainer).toContain('primary owner')
  })

  it('an owner at their own location sees "Your signature", with no warning', async () => {
    as(DANA)
    const { body } = await get()
    expect(body.target.heading).toBe('Your signature')
    expect(body.target.explainer).toBeNull()
  })

  it('a location with nobody who can sign names the location', async () => {
    state.users.find((u) => u.id === RALUCA)!.is_active = false
    state.users.find((u) => u.id === MIKE)!.location_id = BOULDER
    as(KEVIN)
    const { body } = await get(SWA)
    expect(body.target.targetId).toBeNull()
    expect(body.target.heading).toBe('Southwest Austin’s signature')
    expect(body.target.explainer).toContain('Bee Organized Southwest Austin')
    expect(body.preview.html).toContain('Bee Organized Southwest Austin')
  })

  it('heading wording', () => {
    expect(signatureCardHeading({ targetId: 'x', targetName: 'Raluca Sharma', isSelf: false })).toBe('Raluca Sharma’s signature')
    expect(signatureCardHeading({ targetId: 'x', targetName: 'James Moss', isSelf: false })).toBe('James Moss’ signature')
    expect(signatureCardHeading({ targetId: 'x', targetName: null, isSelf: false })).toBe('This person’s signature')
    expect(signatureCardHeading({ targetId: 'x', targetName: 'Me', isSelf: true })).toBe('Your signature')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('an owner or manager at their own location still edits their own', () => {
  it('owner: GET targets them, PATCH writes them', async () => {
    as(RALUCA)
    const { body } = await get()
    expect(body.target).toMatchObject({ targetId: RALUCA, isSelf: true, canEdit: true })
    const r = await patch({ targetUserId: RALUCA, signature_title: 'Founder' })
    expect(r.status).toBe(200)
    expect(state.updates.map((u) => u.id)).toEqual([RALUCA])
  })

  it('manager: their own too — not the owner’s', async () => {
    as(MIKE)
    const { body } = await get()
    expect(body.target).toMatchObject({ targetId: MIKE, isSelf: true, canEdit: true })
    const r = await patch({ targetUserId: MIKE, signature_title: 'Operations Manager' })
    expect(r.status).toBe(200)
    expect(state.updates.map((u) => u.id)).toEqual([MIKE])
    expect(user(RALUCA).signature_title).toBeNull()
  })

  it('a non-corporate user cannot edit anyone else — not by naming them, not by passing another location', async () => {
    as(MIKE)
    const other = await patch({ targetUserId: RALUCA, signature_title: 'x' })
    expect(other.status).toBe(409)
    const elsewhere = await patch({ locationId: BOULDER, targetUserId: DANA, signature_title: 'x' })
    expect(elsewhere.status).toBe(409) // locationId ignored for non-corporate: target is still Mike
    expect(state.updates).toEqual([])
  })

  it('pure rule: someone else’s signature is editable only by super_admin / admin', () => {
    const signer = { id: RALUCA, full_name: 'Raluca Sharma' }
    for (const role of ['owner', 'manager', 'staff', 'lite_user', '']) {
      expect(signatureEditTarget({ callerId: MIKE, callerRole: role, signer, reason: 'primary_owner' }).canEdit, role).toBe(false)
    }
    for (const role of ['super_admin', 'admin']) {
      expect(signatureEditTarget({ callerId: KEVIN, callerRole: role, signer, reason: 'primary_owner' }).canEdit, role).toBe(true)
    }
  })

  it('/api/hub_users/me no longer writes signature fields — /api/signature is the only door', () => {
    const src = readFileSync(join(__dirname, '..', 'app/api/hub_users/me/route.ts'), 'utf8')
    expect(src).not.toMatch(/patch\.signature_(title|photo_path)/)
    const uploader = readFileSync(join(__dirname, 'signature-photo.js'), 'utf8')
    expect(uploader).not.toContain("fetch('/api/hub_users/me'")
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the card and the preview always resolve to the same person', () => {
  const scenarios: [string, () => void, string | undefined, string | null][] = [
    ['Kevin viewing Southwest Austin', () => as(KEVIN), SWA, RALUCA],
    ['Kevin viewing Boulder', () => as(KEVIN), BOULDER, DANA],
    ['Raluca at her own location', () => as(RALUCA), undefined, RALUCA],
    ['Mike (manager) at his own location', () => as(MIKE), undefined, MIKE],
    ['Kevin at Southwest Austin once Raluca is deactivated', () => { user(RALUCA).is_active = false; as(KEVIN) }, SWA, null],
  ]
  for (const [label, setup, loc, expected] of scenarios) {
    it(label, async () => {
      setup()
      const { body } = await get(loc)
      expect(body.target.targetId).toBe(expected)
      if (expected) {
        const u = user(expected)
        expect(body.person.id).toBe(expected)
        // the preview is that same person: their name is the preview's name line
        expect(body.preview.html).toContain(`>${u.full_name}</td>`)
        expect(body.preview.text.split('\n')[0]).toBe(u.full_name)
      } else {
        expect(body.person).toBeNull()
      }
    })
  }

  it('after Kevin sets Raluca’s title, the preview he sees shows it', async () => {
    as(KEVIN)
    await patch({ locationId: SWA, targetUserId: RALUCA, signature_title: 'Owner' })
    const { body } = await get(SWA)
    expect(body.person.title).toBe('Owner')
    expect(body.preview.html).toContain('>Owner, Bee Organized Southwest Austin</td>')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('THE PINNED CASE: headshot + title, location with no links', () => {
  // 2026-10-30 design: round photo, no vertical rule, title names the location.
  it('the preview shows the photo and the title — and the no-links note is flagged', async () => {
    as(DANA) // Boulder has no website or social links
    const { body } = await get()
    const html: string = body.preview.html
    expect(html).toContain(`${SIGNATURE_PHOTO_ROUTE}/${DANA_PHOTO}`) // the photo
    expect(html).toContain('width="90" height="90" alt="Dana Diaz"')   // an earlier square upload, squared in the box
    expect(html).toContain('Owner &amp; Lead Organizer, Bee Organized Boulder') // the title
    expect(html).toContain('bgcolor="#E6EFED"') // the photo box
    expect(html).not.toContain('alt="Facebook"')
    expect(body.hasLinks).toBe(false)
  })

  it('the same, as Kevin viewing Southwest Austin after setting Raluca’s photo and title', async () => {
    as(KEVIN)
    await patch({ locationId: SWA, targetUserId: RALUCA, signature_title: 'Owner' })
    await patch({ locationId: SWA, targetUserId: RALUCA, signature_photo_path: RALUCA_NEW_PHOTO })
    const { body } = await get(SWA)
    expect(body.preview.html).toContain(`${SIGNATURE_PHOTO_ROUTE}/${RALUCA_NEW_PHOTO}`)
    expect(body.preview.html).toContain('>Owner, Bee Organized Southwest Austin</td>')
    expect(body.preview.html).toContain('bgcolor="#E6EFED"')
  })
})

// ─────────────────────────────────────────────────────────────────────────
describe('the no-links note: in the preview, never in an email', () => {
  it('hasLinks is false with none set, true once any one is set', async () => {
    as(DANA)
    expect((await get()).body.hasLinks).toBe(false)
    state.locations.find((l) => l.id === BOULDER)!.instagram_url = 'https://instagram.com/boulder'
    expect((await get()).body.hasLinks).toBe(true)
  })

  it('the preview component renders the note from hasLinks, outside the signature frame', () => {
    const src = readFileSync(join(__dirname, '..', 'components/settings/EmailSignatureSettings.jsx'), 'utf8')
    expect(src).toContain("data.hasLinks === false")
    expect(src).toContain('{NO_LINKS_NOTE}')
    expect(NO_LINKS_NOTE).toBe('No website or social links yet — add them under My Location → Email Signature Links.')
  })

  it('no email builder can produce it: not the signature, not either layout, not the text half', () => {
    const sig = assembleSignature({ ...user(DANA) } as any, NO_LINKS, 'Boulder')
    const body = `Thank you,\nbo-signature`
    for (const out of [
      buildSignatureHtml(sig),
      buildSignatureText(sig),
      buildBrandedDripHtml(body, { location_name: 'Boulder', signature: sig }),
      buildBrandedDripText(body, { location_name: 'Boulder', signature: sig }),
      bodyToHtml(body, sig),
    ]) {
      expect(out).not.toContain('No website or social links')
      expect(out).not.toContain('Email Signature Links')
    }
    // …and none of the send-side modules even import it.
    for (const f of ['email-signature.ts', 'email-signature-resolve.ts', 'drip-email-layout.ts', 'drip-send.ts', 'stage-emails.ts', 'welcome-email.ts', 'resend.ts']) {
      expect(readFileSync(join(__dirname, f), 'utf8'), f).not.toContain('NO_LINKS_NOTE')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2026-10-31 (Lovable's signature). The Emails screen's preview is the
// signature a client receives, byte for byte: the route's preview, the
// screen's own email previews (signatureFromData), and the sent email (the
// send-time resolver into both body builders) are one HTML string.
describe('the screen’s preview and a sent email produce the same signature HTML', () => {
  const links = {
    website_url: 'https://beeorganized.com/boulder', facebook_url: 'https://facebook.com/boulderbees',
    instagram_url: '@boulderbees', linkedin_url: 'https://linkedin.com/company/bee-boulder',
  }
  const cases: [string, () => void, string, string | undefined, string][] = [
    ['an owner with a photo (Dana, Boulder)', () => as(DANA), BOULDER, undefined, 'Boulder'],
    ['an owner with no photo (Raluca, as Kevin views Southwest Austin)', () => as(KEVIN), SWA, SWA, 'Southwest Austin'],
  ]
  for (const [label, setup, loc, query, locName] of cases) {
    it(label, async () => {
      Object.assign(state.locations.find((l) => l.id === loc)!, links)
      setup()
      const { body } = await get(query)
      const preview: string = body.preview.html
      expect(preview).toContain('alt="Instagram"')
      // The screen's own email previews build it from the same answer.
      expect(buildSignatureHtml(signatureFromData(body) as any)).toBe(preview)
      // The send side: who signs, resolved as a send resolves it…
      const sent = await resolveEmailSignature({ locationId: loc, locationName: locName, assigneeUserId: null })
      expect(buildSignatureHtml(sent)).toBe(preview)
      // …and what lands in the email, through both body builders.
      const text = `Thank you,\n${SIGNATURE_MARKER}`
      expect(buildBrandedDripHtml(text, { location_name: locName, signature: sent })).toContain(preview)
      expect(bodyToHtml(text, sent)).toContain(preview)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────
// PART C (Kevin, 2026-10-31): one LinkedIn for the location; a person's own
// only where the location has none. The OPPOSITE direction to the booking
// link's person-first fallback, on purpose.
describe('LinkedIn: the location’s for everyone, a person’s own only as a fallback', () => {
  const LOC_LI = 'https://www.linkedin.com/company/bee-southwest-austin'
  const RALUCA_LI = 'https://www.linkedin.com/in/raluca'
  const MIKE_LI = 'https://www.linkedin.com/in/mike'
  const DANA_LI = 'https://www.linkedin.com/in/dana'
  const linkedinOf = async (loc: string, name: string, assignee: string | null) =>
    (await resolveEmailSignature({ locationId: loc, locationName: name, assigneeUserId: assignee })).linkedinUrl

  it('with a location LinkedIn, every signer there gets it — their own is ignored even when set', async () => {
    state.locations.find((l) => l.id === SWA)!.linkedin_url = LOC_LI
    user(RALUCA).signature_linkedin_url = RALUCA_LI
    user(MIKE).signature_linkedin_url = MIKE_LI
    expect(await linkedinOf(SWA, 'Southwest Austin', null)).toBe(LOC_LI)            // Raluca, primary owner
    expect(await linkedinOf(SWA, 'Southwest Austin', MIKE)).toBe(LOC_LI)            // Mike, assignee
    const html = buildSignatureHtml(await resolveEmailSignature({ locationId: SWA, locationName: 'Southwest Austin', assigneeUserId: MIKE }))
    expect(html).toContain(`href="${LOC_LI}"`)
    expect(html).not.toContain(MIKE_LI)
    expect(html).toContain('alt="LinkedIn"')
  })

  it('with no location LinkedIn, the signer’s own is used', async () => {
    user(DANA).signature_linkedin_url = DANA_LI
    expect(await linkedinOf(BOULDER, 'Boulder', null)).toBe(DANA_LI)
    expect(buildSignatureHtml(await resolveEmailSignature({ locationId: BOULDER, locationName: 'Boulder', assigneeUserId: null }))).toContain(`href="${DANA_LI}"`)
  })

  it('with neither, the LinkedIn row is dropped and nothing empty renders', async () => {
    const sig = await resolveEmailSignature({ locationId: BOULDER, locationName: 'Boulder', assigneeUserId: null })
    expect(sig.linkedinUrl).toBeNull()
    const html = buildSignatureHtml(sig)
    expect(html).not.toContain('alt="LinkedIn"')
    expect(html).not.toContain('href=""')
    expect(html).not.toMatch(/<td[^>]*><\/td>/)
  })

  it('a location LinkedIn already saved still renders its icon and link, untouched', async () => {
    state.locations.find((l) => l.id === BOULDER)!.linkedin_url = 'https://www.linkedin.com/company/bee-boulder'
    const html = buildSignatureHtml(await resolveEmailSignature({ locationId: BOULDER, locationName: 'Boulder', assigneeUserId: null }))
    expect(html).toContain(`<img src="https://beehive.beeorganized.com/email-signature/linkedin-mark.png" width="20" height="20" alt="LinkedIn"`)
    expect(html).toContain('href="https://www.linkedin.com/company/bee-boulder"')
  })

  it('before migrations/signature_linkedin.sql: the location’s still works, nothing else is lost, and the field is not offered', async () => {
    state.noLinkedinColumn = true
    state.locations.find((l) => l.id === BOULDER)!.linkedin_url = 'https://www.linkedin.com/company/bee-boulder'
    as(DANA)
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.storageReady.personLinkedin).toBe(false)
    expect(body.person.title).toBe('Owner & Lead Organizer')                        // title and photo survive
    expect(body.preview.html).toContain(`${SIGNATURE_PHOTO_ROUTE}/${DANA_PHOTO}`)
    expect(body.preview.html).toContain('href="https://www.linkedin.com/company/bee-boulder"')
    state.locations.find((l) => l.id === BOULDER)!.linkedin_url = null
    expect((await resolveEmailSignature({ locationId: BOULDER, locationName: 'Boulder', assigneeUserId: null })).linkedinUrl).toBeNull()
  })

  it('after it: storageReady says so, and the person’s own comes back on GET', async () => {
    user(DANA).signature_linkedin_url = DANA_LI
    as(DANA)
    const { body } = await get()
    expect(body.storageReady.personLinkedin).toBe(true)
    expect(body.person.linkedinUrl).toBe(DANA_LI)
  })

  it('saving: your own saves onto you, as a full address', async () => {
    as(DANA)
    const r = await patch({ targetUserId: DANA, signature_linkedin_url: 'linkedin.com/in/dana' })
    expect(r.status).toBe(200)
    expect(user(DANA).signature_linkedin_url).toBe('https://linkedin.com/in/dana')
    expect((await patch({ targetUserId: DANA, signature_linkedin_url: 'not a link' })).status).toBe(400)
    expect((await patch({ targetUserId: DANA, signature_linkedin_url: '' })).status).toBe(200)
    expect(user(DANA).signature_linkedin_url).toBeNull()
  })

  it('the route’s existing rule, kept: an admin viewing a location edits its signer’s; a manager cannot edit the owner’s', async () => {
    as(KEVIN)
    expect((await patch({ locationId: SWA, targetUserId: RALUCA, signature_linkedin_url: RALUCA_LI })).status).toBe(200)
    expect(user(RALUCA).signature_linkedin_url).toBe(RALUCA_LI)
    expect(user(KEVIN).signature_linkedin_url).toBeUndefined()
    as(MIKE)
    const r = await patch({ locationId: SWA, targetUserId: RALUCA, signature_linkedin_url: MIKE_LI })
    expect(r.status).not.toBe(200)
    expect(user(RALUCA).signature_linkedin_url).toBe(RALUCA_LI)
  })

  it('preview and sent email agree on the fallback too (Dana’s own, Boulder has none)', async () => {
    user(DANA).signature_linkedin_url = DANA_LI
    as(DANA)
    const { body } = await get()
    expect(body.preview.html).toContain(`href="${DANA_LI}"`)
    expect(buildSignatureHtml(signatureFromData(body) as any)).toBe(body.preview.html)
    const sent = await resolveEmailSignature({ locationId: BOULDER, locationName: 'Boulder', assigneeUserId: null })
    expect(bodyToHtml(`Thank you,\n${SIGNATURE_MARKER}`, sent)).toContain(body.preview.html)
  })
})

// 2026-10-31, Kevin's redesign: the photo box is 90×112. New uploads are
// cropped to that portrait in the browser and the route marks their path
// "-p"; a page loaded before the change uploads a square and gets no mark.
describe('portrait uploads are marked so the signature can tell the shapes apart', () => {
  it('shape "portrait" → a "-p" path, which saves; no shape → an unmarked one', async () => {
    as(DANA)
    const p = await signPhoto({ targetUserId: DANA, shape: 'portrait' })
    expect(p.status).toBe(200)
    expect(p.body.path).toMatch(new RegExp(`^${DANA}/[0-9a-f-]{36}-p\\.jpg$`))
    state.bucket.add(p.body.path)
    expect((await patch({ targetUserId: DANA, signature_photo_path: p.body.path })).status).toBe(200)
    expect(user(DANA).signature_photo_path).toBe(p.body.path)
    expect((await get()).body.preview.html).toContain('width="90" height="112" alt="Dana Diaz"')
    const sq = await signPhoto({ targetUserId: DANA })
    expect(sq.body.path).toMatch(new RegExp(`^${DANA}/[0-9a-f-]{36}\\.jpg$`))
  })
})

