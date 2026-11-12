// @vitest-environment happy-dom
//
// THE SIGNATURE, TO KEVIN'S REDESIGN (2026-10-31; replaces the Lovable version
// built earlier the same day).
//
// The email (lib/email-signature.ts): a 90×112 photo box on #E6EFED, then the
// text behind a 4px sage bar — name 22px bold sage, title 16px bold italic
// grey, email / "m:" phone / website 15px bold italic, and the socials as 28px
// sage-framed squares each holding the network's symbol as a sage outline mark
// (Kevin's call: no dark circle, no letters). Always light.
//
// The screen (EmailSignatureSection): last on the page, one column — fields,
// then the real signature HTML in a card underneath.
//
// Part C's LinkedIn rule and "the screen's preview and a sent email are one
// HTML string" run the real route and resolver, so they live with that
// harness in lib/beta-signature-edit-target.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const state = { queue: [] as { table: string; data: any }[], updates: [] as any[] }
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const data = idx >= 0 ? state.queue.splice(idx, 1)[0].data : null
    const b: any = {}
    for (const m of ['select', 'insert', 'upsert', 'eq', 'is', 'limit', 'order']) b[m] = () => b
    b.update = (p: any) => { state.updates.push({ table, patch: p }); return b }
    b.maybeSingle = () => Promise.resolve({ data, error: null })
    b.single = () => Promise.resolve({ data, error: null })
    b.then = (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej)
    return b
  }
  return { state, makeBuilder, reset: () => { state.queue = []; state.updates = [] } }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(async () => ({})),
  getHubUser: vi.fn(async () => ({ role: 'owner', location_id: 'loc-1' })),
  isAdmin: (r: string) => r === 'super_admin' || r === 'admin',
}))

import {
  buildSignatureHtml, buildSignatureText, signatureInitials, instagramUrl, EMPTY_SIGNATURE,
  SIGNATURE_ICON_PATHS, SIGNATURE_SAGE, SIGNATURE_EMAIL_LINK, SIGNATURE_PHOTO_ROUTE, isValidSignaturePhotoPath, isPortraitSignaturePhotoPath,
  type EmailSignature,
} from './email-signature'
import { DRIP_BRAND_TEAL } from './drip-email-layout'
import { PATCH as locationPATCH } from '@/app/api/locations/[id]/route'
import { EmailSignatureSection, ET, EmailsFonts, signatureFromData } from '@/components/settings/EmailsScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const APP = 'https://beehive.beeorganized.com'
process.env.NEXT_PUBLIC_APP_URL = APP

const JANE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SQUARE = `${JANE}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`        // uploaded before 2026-10-31
const PORTRAIT = `${JANE}/cccccccc-cccc-4ccc-8ccc-cccccccccccc-p.jpg`    // uploaded since
const FULL: EmailSignature = {
  name: 'Jane Smith', title: 'Owner', email: 'jane@beeorganized.com', mobile: '(303) 555-0147', photoPath: PORTRAIT,
  websiteUrl: 'https://beeorganized.com/boulder', facebookUrl: 'https://www.facebook.com/beeboulder',
  instagramUrl: 'https://www.instagram.com/beeboulder', linkedinUrl: 'https://www.linkedin.com/company/bee-boulder',
  locationName: 'Boulder',
}
const NO_PHOTO = { ...FULL, photoPath: null }
const html = buildSignatureHtml(FULL)
const safe = (out: string) => {
  expect(/<(script|iframe|style|svg)/i.test(out)).toBe(false)
  expect(/ on\w+=/i.test(out)).toBe(false)
  expect(out.replace(/<[^>]*>/g, '').includes('<')).toBe(false)
}
const BOX = '<td width="90" height="112" align="center" valign="middle" bgcolor="#E6EFED" style="width:90px;height:112px;background:#E6EFED;">'
// Just enough PNG decoding for our own 8-bit RGBA files (filters 0-4).
const readPng = (file: string) => {
  const d = readFileSync(file); let i = 8, w = 0, h = 0; const idat: Buffer[] = []
  while (i < d.length) {
    const n = d.readUInt32BE(i), t = d.toString('latin1', i + 4, i + 8), c = d.subarray(i + 8, i + 8 + n); i += 12 + n
    if (t === 'IHDR') { w = c.readUInt32BE(0); h = c.readUInt32BE(4); expect([c[8], c[9]]).toEqual([8, 6]) }
    else if (t === 'IDAT') idat.push(c)
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, px = new Uint8Array(w * h * 4)
  for (let y = 0, p = 0; y < h; y++) {
    const f = raw[p++]
    for (let x = 0; x < stride; x++, p++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0
      const pr = (() => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c })()
      px[y * stride + x] = (raw[p] + [0, a, b, (a + b) >> 1, pr][f]) & 255
    }
  }
  return { w, h, px }
}
const socials = (out: string) => Array.from(out.matchAll(/<a href="([^"]*)" aria-label="([^"]*)" style="([^"]*)"><img src="([^"]*)" width="(\d+)" height="(\d+)"/g))

// ─── type ───────────────────────────────────────────────────────────────
describe('the text', () => {
  it('name 22px bold sage; title 16px bold italic grey', () => {
    expect(html).toContain('<td style="padding:0 0 8px 0;font-size:22px;line-height:28px;font-weight:bold;color:#A8C9C4;">Jane Smith</td>')
    expect(html).toContain('<td style="padding:0 0 10px 0;font-size:16px;line-height:22px;font-weight:bold;font-style:italic;color:#7A7C79;">Owner, Bee Organized Boulder</td>')
  })
  it('sits behind a 4px sage bar, padded 8px 0 8px 18px', () => {
    expect(html).toContain('<td valign="top" style="border-left:4px solid #A8C9C4;padding:8px 0 8px 18px;">')
  })
  it('Arial, grey, light — the outer table', () => {
    expect(html.startsWith('<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="dm-text" style="margin:8px 0;font-family:Arial, Helvetica, sans-serif;color:#7A7C79;">')).toBe(true)
  })
  it('contact rows 15px bold italic, wrapping; email dark teal underlined, website grey underlined', () => {
    const row = 'font-size:15px;line-height:22px;font-weight:bold;font-style:italic;word-break:break-word;overflow-wrap:anywhere;'
    expect(html.split(`<td style="padding:0 0 10px 0;${row}">`).length - 1).toBe(3)
    expect(html).toContain('<a href="mailto:jane@beeorganized.com" style="color:#054E4A;text-decoration:underline;">jane@beeorganized.com</a>')
    expect(html).toContain('<a href="https://beeorganized.com/boulder" style="color:#7A7C79;text-decoration:underline;">beeorganized.com/boulder</a>')
  })
  it('the phone row reads "m:" in sage, then the number in grey', () => {
    expect(html).toContain('<span style="color:#A8C9C4;">m:</span> <a href="tel:+13035550147" style="color:#7A7C79;text-decoration:underline;">(303) 555-0147</a>')
    // a number too short to dial still shows, grey, unlinked
    expect(buildSignatureHtml({ ...FULL, mobile: '555-01' })).toContain('<span style="color:#A8C9C4;">m:</span> <span style="color:#7A7C79;">555-01</span>')
  })
  // 2026-11-12: sage on white is 1.78:1, unreadable as 15px text in an email
  // real clients receive. The address alone moved to the palette's dark teal.
  it('the email address is readable on white: 4.5:1 or better, from the email palette, and nothing else moved', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const onWhite = (hex: string) => 1.05 / (lum(hex) + 0.05)
    const link = html.match(/<a href="mailto:[^"]*" style="color:(#[0-9A-Fa-f]{6});/)![1]
    expect(link).toBe(SIGNATURE_EMAIL_LINK)
    expect(link).toBe('#054E4A')
    expect(link).toBe(DRIP_BRAND_TEAL)
    expect(onWhite(link)).toBeGreaterThanOrEqual(4.5)
    expect(onWhite(link).toFixed(2)).toBe('9.57')
    expect(onWhite(SIGNATURE_SAGE).toFixed(2)).toBe('1.78')   // why it moved
    // …and it is the ONLY thing painted that colour: once, on the address.
    expect(html.split('#054E4A').length - 1).toBe(1)
    expect(buildSignatureHtml({ ...FULL, email: null })).not.toContain('#054E4A')
  })
  it('nothing renders a dark palette beyond the address: the three light colours plus its teal, no dark-mode rules', () => {
    for (const out of [html, buildSignatureHtml(NO_PHOTO)]) {
      const colours = new Set(Array.from(out.matchAll(/#[0-9A-Fa-f]{6}\b/g)).map(m => m[0].toUpperCase()))
      expect(Array.from(colours).sort()).toEqual(['#054E4A', '#7A7C79', '#A8C9C4', '#E6EFED'])
      expect(out).not.toMatch(/prefers-color-scheme|data-ogsc|data-ogsb|dark/i)
    }
  })
})

// ─── the photo box ──────────────────────────────────────────────────────
describe('the photo box', () => {
  it('an owner with a photo: it renders at 90 by 112, in the box', () => {
    expect(html).toContain(`<td valign="top" style="padding:6px 16px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${BOX}<img src="${APP}${SIGNATURE_PHOTO_ROUTE}/${PORTRAIT}" width="90" height="112" alt="Jane Smith" style="display:block;width:90px;height:112px;border:0;"></td>`)
  })
  it('a photo uploaded before the redesign (square): 90×90 in the same box, never stretched', () => {
    const sq = buildSignatureHtml({ ...FULL, photoPath: SQUARE })
    expect(sq).toContain(`${BOX}<img src="${APP}${SIGNATURE_PHOTO_ROUTE}/${SQUARE}" width="90" height="90"`)
    expect(sq).not.toContain('height="112" alt')
  })
  it('the two shapes are told apart by the path the upload route mints', () => {
    expect(isValidSignaturePhotoPath(PORTRAIT)).toBe(true)
    expect(isPortraitSignaturePhotoPath(PORTRAIT)).toBe(true)
    expect(isPortraitSignaturePhotoPath(SQUARE)).toBe(false)
    for (const bad of [`${JANE}/x-p.jpg`, `${JANE}/cccccccc-cccc-4ccc-8ccc-cccccccccccc-q.jpg`, `${PORTRAIT}?x`]) expect(isValidSignaturePhotoPath(bad), bad).toBe(false)
    const route = readFileSync(join(process.cwd(), 'app/api/signature/photo/route.ts'), 'utf8')
    expect(route).toContain("const portrait = body.shape === 'portrait' ? '-p' : ''")
    const upload = readFileSync(join(process.cwd(), 'lib/signature-photo.js'), 'utf8')
    expect(upload).toContain("shape: 'portrait'")
    expect(upload).toContain('canvas.width = ow')
    expect(upload).toContain('canvas.height = oh')
  })
  it('no photo: the initials on #E6EFED at 90 by 112, sage, 30px bold', () => {
    const out = buildSignatureHtml(NO_PHOTO)
    expect(out).toContain(`${BOX}<span style="font-size:30px;line-height:30px;font-weight:bold;color:#A8C9C4;">JS</span></td>`)
    expect(out).not.toContain(SIGNATURE_PHOTO_ROUTE)
  })
  it('Lovable’s initials rule: the first letter of the first two words, uppercased', () => {
    expect(signatureInitials('Jane Smith')).toBe('JS')
    expect(signatureInitials('jane mary smith')).toBe('JM')
    expect(signatureInitials('  (Jane)   o’neill ')).toBe('JO')
    expect(signatureInitials('Bee Organized Boulder')).toBe('BO')
  })
  for (const name of ['???', '— —', '🐝 🐝', null]) {
    it(`no usable initials (${JSON.stringify(name)}): no photo cell, the rest still renders`, () => {
      const out = buildSignatureHtml({ ...NO_PHOTO, name })
      expect(out).not.toContain('#E6EFED')
      expect(out).not.toContain('padding:6px 16px 0 0')
      expect(out).toContain('border-left:4px solid #A8C9C4')
      expect(out).toContain('mailto:jane@beeorganized.com')
      safe(out)
    })
  }
})

// ─── the socials ────────────────────────────────────────────────────────
describe('the socials', () => {
  it('each a 28px square with a 2px sage border holding a 20px mark, in order', () => {
    const s = socials(html)
    expect(s.map(m => m[2])).toEqual(['Facebook', 'Instagram', 'LinkedIn'])
    s.forEach((m, i) => {
      expect(m[3]).toBe('display:inline-block;width:28px;height:28px;line-height:28px;margin:0 7px 0 0;border:2px solid #A8C9C4;border-radius:6px;text-align:center;text-decoration:none;')
      expect(m[4]).toBe(`${APP}${Object.values(SIGNATURE_ICON_PATHS)[i]}`)
      expect([m[5], m[6]]).toEqual(['20', '20'])
    })
    expect(html).toContain('<tr><td style="padding:8px 0 0 0;"><a href=')
    // never the design's letters
    expect(html).not.toMatch(/>(f|ig|in)<\/a>/)
  })
  it('the marks are three NEW files; the dark-circle logos and the email / phone / website icons are gone', () => {
    expect(SIGNATURE_ICON_PATHS).toEqual({
      facebook: '/email-signature/facebook-mark.png', instagram: '/email-signature/instagram-mark.png', linkedin: '/email-signature/linkedin-mark.png',
    })
    const dir = readdirSync(join(process.cwd(), 'public/email-signature')).sort()
    expect(dir).toEqual(['facebook-mark.png', 'instagram-mark.png', 'linkedin-mark.png'])
  })
  it('each mark is a 40×40 (2× of 20px) sage symbol on transparent — no dark circle, no other colour', () => {
    for (const p of Object.values(SIGNATURE_ICON_PATHS)) {
      const { w, h, px } = readPng(join(process.cwd(), 'public', p))
      expect([w, h], p).toEqual([40, 40])
      let ink = 0
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue
        ink++
        expect([px[i], px[i + 1], px[i + 2]], p).toEqual([0xA8, 0xC9, 0xC4])   // sage, only
      }
      // A symbol, not a filled disc (a 40px disc fills ~0.6 of the square),
      // and all four corners are see-through.
      expect(ink / (w * h), p).toBeLessThan(0.55)
      expect(ink / (w * h), p).toBeGreaterThan(0.1)
      for (const [x, y] of [[0, 0], [39, 0], [0, 39], [39, 39]]) expect(px[(y * w + x) * 4 + 3], `${p} ${x},${y}`).toBe(0)
    }
  })
  it('a social with no link is omitted; none at all, no row', () => {
    expect(socials(buildSignatureHtml({ ...FULL, instagramUrl: null })).map(m => m[2])).toEqual(['Facebook', 'LinkedIn'])
    const none = buildSignatureHtml({ ...FULL, facebookUrl: null, instagramUrl: '', linkedinUrl: 'not a link' })
    expect(socials(none)).toEqual([])
    expect(none).not.toContain('padding:8px 0 0 0')
  })
  it('all three survive: Facebook, Instagram and LinkedIn', () => {
    expect(socials(html)).toHaveLength(3)
    expect(html).toContain('href="https://www.linkedin.com/company/bee-boulder"')
  })
})

describe('the marks changed nothing else in the signature', () => {
  // sha256 of buildSignatureHtml / buildSignatureText taken on the redesign
  // just BEFORE the marks replaced the dark-circle logos (2026-10-31). With
  // the new file names put back to the old ones — and the email address put
  // back to sage (it went dark teal 2026-11-12) — every byte must match.
  const BEFORE: Record<string, [string, string]> = {
    full:         ['63c8880c02a6c16e1307efe700d70320564f4ecfdc62f62dee65308faf279ac2', '2e86edd1561cfe1f2098147ebba81bec8f47dfc5ef13e47443899f2911d39536'],
    square:       ['044f0a124c3765b04629652adebd6e6d88b9d0f649ead6401e622225bf9823fd', '2e86edd1561cfe1f2098147ebba81bec8f47dfc5ef13e47443899f2911d39536'],
    initials:     ['ce210f66a13b8b8eebc01b73257e337b0314152edccd47fcc704bc6cb308508f', '2e86edd1561cfe1f2098147ebba81bec8f47dfc5ef13e47443899f2911d39536'],
    noInitials:   ['6dfbaf4b2147eb9209fcdb01ffb07b5d11daf17834a9b3eb455fbab21cafa75c', '3eb971c4058600d9af9e18f00b986cae6067cdf70bf8e4eb6db6245bf872a310'],
    handleOnly:   ['b8abf48283dcc7ad63fc2b85002ccb15f2e659d3a286aad45f2219cca2017a07', '48f01374191a02480c8836b74c7e5df06b62fc0807faa5267ac079a3c1f6052c'],
    linkedinOnly: ['bf7cd6460a5612ee3c3d9ebf36f1cd76afb66ead1dd01c16d14a2cdb9a740208', 'f6d095b521c58e77ecc3e72185363eb9700a531171ad0880d29a2c8afb39a9ca'],
    noSocials:    ['1b529816c279b7d8e11a4537de58a26feedd3a1377337fd50ba2dca13894520f', '4a985bd5fe64dcb5d7cf0264c577e21e3c92fa1760f8d40e94ad07babdada51b'],
  }
  const SQ = `${JANE}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`
  const CASES: Record<string, EmailSignature> = {
    full: FULL,
    square: { ...FULL, photoPath: SQ },
    initials: NO_PHOTO,
    noInitials: { ...NO_PHOTO, name: '—' },
    handleOnly: { ...FULL, facebookUrl: null, linkedinUrl: null, instagramUrl: '@beeboulder' },
    linkedinOnly: { ...FULL, facebookUrl: null, instagramUrl: null },
    noSocials: { ...FULL, facebookUrl: null, instagramUrl: null, linkedinUrl: null },
  }
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')
  const oldNames = (t: string) => t.replace(/\/email-signature\/(facebook|instagram|linkedin)-mark\.png/g, '/email-signature/$1.png')
    .replace(/(<a href="mailto:[^"]*" style="color:)#054E4A;/g, '$1#A8C9C4;')
  for (const [k, sig] of Object.entries(CASES)) {
    it(`${k}: only the file names and the email address colour differ`, () => {
      const out = buildSignatureHtml(sig)
      expect(sha(oldNames(out)), k).toBe(BEFORE[k][0])
      expect(sha(buildSignatureText(sig)), `${k} text`).toBe(BEFORE[k][1])
    })
  }
})

// ─── Instagram ──────────────────────────────────────────────────────────
describe('Instagram', () => {
  it('@handle resolves to the full address, in the email and its text half', () => {
    expect(instagramUrl('@beeboulder')).toBe('https://instagram.com/beeboulder')
    expect(instagramUrl('  @bee.boulder_co  ')).toBe('https://instagram.com/bee.boulder_co')
    const sig = { ...FULL, instagramUrl: '@beeboulder' }
    expect(buildSignatureHtml(sig)).toContain('<a href="https://instagram.com/beeboulder" aria-label="Instagram"')
    expect(buildSignatureText(sig)).toContain('Instagram: https://instagram.com/beeboulder')
  })
  it('a full address still resolves', () => {
    expect(instagramUrl('https://www.instagram.com/beeboulder')).toBe('https://www.instagram.com/beeboulder')
    expect(instagramUrl('instagram.com/beeboulder')).toBe('https://instagram.com/beeboulder')
    expect(html).toContain('href="https://www.instagram.com/beeboulder"')
  })
  it('anything else is no link, never a broken one', () => {
    for (const bad of ['@', '@bee boulder', '@bee<x>', 'javascript:alert(1)']) {
      expect(instagramUrl(bad), bad).toBeNull()
      expect(buildSignatureHtml({ ...FULL, instagramUrl: bad })).not.toContain('aria-label="Instagram"')
    }
  })
  const req = (body: any) => new Request('http://test/api/locations/loc-1', { method: 'PATCH', body: JSON.stringify(body) }) as any
  it('saving the location: "@handle" is stored as the full address', async () => {
    h.reset()
    h.state.queue.push({ table: 'locations', data: { id: 'loc-1' } })
    const res = await locationPATCH(req({ instagram_url: '@beeboulder' }), { params: { id: 'loc-1' } })
    expect(res.status).toBe(200)
    expect(h.state.updates.find(u => u.table === 'locations')!.patch.instagram_url).toBe('https://instagram.com/beeboulder')
  })
  it('…and only for Instagram: "@page" as a Facebook address is still refused', async () => {
    h.reset()
    expect((await locationPATCH(req({ facebook_url: '@beeboulder' }), { params: { id: 'loc-1' } })).status).toBe(400)
  })
})

describe('a signature with no email address renders safely', () => {
  for (const email of [null, '', 'not an address', 'jane@', '"><script>@x.com']) {
    it(JSON.stringify(email), () => {
      const out = buildSignatureHtml({ ...NO_PHOTO, email })
      expect(out).not.toContain('mailto:')
      expect(out).toContain('Jane Smith</td>')
      expect(out).toContain('>m:</span>')
      safe(out)
    })
  }
  it('a name alone: the initials and the name, nothing empty', () => {
    const out = buildSignatureHtml({ ...EMPTY_SIGNATURE, name: 'Jane Smith' })
    expect(out).toContain('>JS</span>')
    expect(out).toContain('>Jane Smith</td>')
    expect(out).not.toMatch(/<td[^>]*><\/td>/)
    expect(out).not.toContain('padding:8px 0 0 0')
  })
})

// ─── the screen ─────────────────────────────────────────────────────────
let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const DATA = (person: any = {}) => ({
  target: { targetId: 'u1', isSelf: true, canEdit: true, heading: 'Your signature', explainer: null },
  person: { id: 'u1', name: 'Jane Smith', email: 'jane@beeorganized.com', mobile: '(303) 555-0147', title: 'Owner', photoPath: null, photoUrl: null, ...person },
  location: { id: 'loc-1', name: 'Boulder' },
  links: { website_url: 'https://beeorganized.com/boulder', facebook_url: null, instagram_url: 'https://instagram.com/beeboulder', linkedin_url: null },
  preview: { html: buildSignatureHtml(NO_PHOTO), text: '' },
  storageReady: { person: true, links: true },
})
const mount = async (data: any) => {
  await act(async () => { root.render(<div data-emails-ui><EmailsFonts /><EmailSignatureSection locationId="loc-1" sig={{ data, error: null, reload: () => {} }} /></div>) })
}
const field = (label: string) => Array.from(container.querySelectorAll('label')).find(l => l.querySelector('span')?.textContent?.startsWith(label))!
const labels = () => Array.from(container.querySelectorAll('[data-sig-field]')).map(f => f.closest('label')!.querySelector('span')!.textContent)
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === label) as HTMLElement

describe('the screen’s signature section', () => {
  it('one column: the fields, then the preview underneath — no side rail', async () => {
    await mount(DATA())
    expect(container.querySelector('[data-sig-rail]')).toBeNull()
    expect(container.querySelector('[data-sig-grid]')).toBeNull()
    const block = container.querySelector('[data-sig-preview-block]') as HTMLElement
    const lastField = Array.from(container.querySelectorAll('[data-sig-field]')).pop()!
    expect(lastField.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(block.textContent).toContain('How it looks in your emails')
    expect(block.querySelector('svg')).toBeTruthy()
  })
  it('the preview is the route’s signature HTML, untouched, in a frame inside a 512px white card', async () => {
    const data = DATA()
    await mount(data)
    const card = container.querySelector('[data-sig-card]') as HTMLElement
    expect(card.style.maxWidth).toBe('512px')
    expect(card.style.overflowX).toBe('auto')
    expect(card.style.padding).toBe('12px 16px')
    expect(card.style.borderRadius).toBe('8px')
    expect(card.style.border).toContain('1px solid')
    expect(card.style.boxShadow).not.toBe('')
    expect((card.querySelector('iframe[data-sig-preview]') as HTMLIFrameElement).getAttribute('srcdoc')).toBe(data.preview.html)
  })
  it('sage-tinted, titled "How you sign off"', async () => {
    await mount(DATA())
    const sec = container.querySelector('#signature') as HTMLElement
    expect(sec.textContent).toContain('How you sign off')
    expect(sec.style.background || sec.style.backgroundColor).toMatch(/rgba\(228, 242, 240, 0\.6\)|#E4F2F099/i)
  })
  it('the social fields show the same sage marks the email uses', async () => {
    await mount(DATA())
    const imgs = Array.from(container.querySelectorAll('[data-sig-trio] img')).map(i => i.getAttribute('src'))
    expect(imgs.slice(0, 3)).toEqual(Object.values(SIGNATURE_ICON_PATHS))
    expect(container.innerHTML).not.toMatch(/email-signature\/(facebook|instagram|linkedin)\.png/)
  })
  it('photo row: a 64×56 sage chip — initials without a photo, "Add a photo", a real upload', async () => {
    await mount(DATA())
    const chip = container.querySelector('[data-sig-chip]') as HTMLElement
    expect([chip.style.width, chip.style.height, chip.style.borderRadius]).toEqual(['64px', '56px', '8px'])
    expect(chip.textContent).toBe('JS')
    expect(container.querySelector('[data-sig-photo-row]')!.textContent).toContain('Profile photo')
    expect(button('Add a photo')).toBeTruthy()
    expect(container.querySelector('[data-sig-photo-row] input[type="file"]')).toBeTruthy()
  })
  it('…a person icon when there are no initials either', async () => {
    await mount(DATA({ name: '???' }))
    expect(container.querySelector('[data-sig-chip] svg')).toBeTruthy()
  })
  it('…with a photo: the photo, and "Remove photo", which clears it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    await mount(DATA({ photoUrl: 'https://x.example/p.jpg' }))
    expect(container.querySelector('[data-sig-chip] img')!.getAttribute('src')).toBe('https://x.example/p.jpg')
    expect(button('Change photo')).toBeUndefined()
    await act(async () => { button('Remove photo').click() })
    const [url, opts] = fetchMock.mock.calls[0] as any[]
    expect(url).toBe('/api/signature')
    expect(JSON.parse(opts.body)).toMatchObject({ signature_photo_path: '' })
  })
  it('fields in the design’s order, the email the account’s and read-only, the placeholders', async () => {
    await mount(DATA())
    expect(labels()).toEqual(['Name', 'Job title', 'Email', 'Phone', 'Website', 'Facebook', 'Instagram', 'LinkedIn'])
    const email = field('Email').querySelector('input') as HTMLInputElement
    expect(email.value).toBe('jane@beeorganized.com')
    expect(email.readOnly).toBe(true)
    expect((field('Facebook').querySelector('input') as HTMLInputElement).placeholder).toBe('Facebook page address')
    expect((field('Instagram').querySelector('input') as HTMLInputElement).placeholder).toBe('@yourhandle')
    expect((field('LinkedIn').querySelector('input') as HTMLInputElement).placeholder).toBe('LinkedIn profile address')
    expect(container.textContent).toContain('Contact details')
    expect(container.textContent).toContain('Social links · Optional')
  })
  it('all three social fields in one grid, three columns from 640px; pairs two from 480px', async () => {
    await mount(DATA())
    const trio = field('Facebook').closest('[data-sig-trio]')!
    expect(trio).toBe(field('LinkedIn').closest('[data-sig-trio]'))
    const css = container.querySelector('style')!.textContent!
    expect(css).toContain('@media (min-width:640px){[data-sig-trio]{grid-template-columns:repeat(3,minmax(0,1fr))}}')
    expect(css).toContain('@media (min-width:480px){[data-sig-pair]{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}')
    expect(css).not.toContain('data-sig-rail')
  })
  it('every field: 44px, bordered, its icon inside the border, the focus ring on the wrapper', async () => {
    await mount(DATA())
    for (const f of Array.from(container.querySelectorAll('[data-sig-field]')) as HTMLElement[]) {
      expect(f.style.minHeight).toBe('44px')
      expect(f.style.border).toContain('1px solid')
      expect(f.hasAttribute('data-efield')).toBe(true)
      expect(f.firstElementChild!.tagName).toMatch(/IMG|svg/i)
    }
    // no field points at an icon file that no longer exists
    for (const img of Array.from(container.querySelectorAll('[data-sig-field] img')) as HTMLImageElement[]) {
      expect(img.getAttribute('src')).toMatch(/^\/email-signature\/(facebook|instagram|linkedin)-mark\.png$/)
    }
    const css = container.querySelector('style')!.textContent!
    expect(css).toContain('[data-efield]:focus-within{box-shadow:0 0 0 2px')
    expect(css).toContain('[data-efield] input:focus-visible{box-shadow:none!important}')
  })
  it('last on the page, and last in the jump nav', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    expect(src.indexOf('<EmailSignatureSection')).toBeGreaterThan(src.indexOf('<ESection id="masters"'))
    expect(src.indexOf('<EmailSignatureSection')).toBeGreaterThan(src.indexOf('<ESection id="emails"'))
    expect(src.match(/<EmailSignatureSection/g)!.length).toBe(1)
    const nav = readFileSync(join(process.cwd(), 'components/settings/EmailsScreen.jsx'), 'utf8')
    expect(nav).toMatch(/\['masters', 'Bee Organized versions'\]\] : \[\]\), \['signature', 'Signature'\]\]/)
  })
  it('the sage stays the email’s #A8C9C4; the screen’s token is #A2C7C1 (known, left alone)', () => {
    expect(SIGNATURE_SAGE).toBe('#A8C9C4')
    expect(ET.sage).toBe('#A2C7C1')
  })
})

describe('the screen’s LinkedIn: the location’s for everyone, a person’s own only as a fallback', () => {
  const ready = (over: any = {}) => ({ ...DATA(), storageReady: { person: true, links: true, personLinkedin: true }, ...over })
  const own = () => Array.from(container.querySelectorAll('label')).find(l => /own LinkedIn/.test(l.querySelector('span')?.textContent || ''))
  it('the location has one: shown, said to be in everyone’s signature, and no personal field even once it could be offered', async () => {
    const d = ready()
    d.links = { ...d.links, linkedin_url: 'https://www.linkedin.com/company/bee-boulder' }
    await mount(d)
    expect((field('LinkedIn').querySelector('input') as HTMLInputElement).value).toBe('https://www.linkedin.com/company/bee-boulder')
    expect(field('LinkedIn').textContent).toContain('In everyone’s signature at this location.')
    expect(own()).toBeUndefined()
  })
  it('the location has none: the person is offered their own, in the same grid, said to be theirs alone', async () => {
    await mount(ready({ person: { ...DATA().person, linkedinUrl: 'https://www.linkedin.com/in/jane' } }))
    const f = own()!
    expect(f.querySelector('span')!.textContent).toBe('Your own LinkedIn')
    expect((f.querySelector('input') as HTMLInputElement).value).toBe('https://www.linkedin.com/in/jane')
    expect(f.textContent).toContain('Only in your signature, while the location has no LinkedIn.')
    expect(f.closest('[data-sig-trio]')).toBe(field('Facebook').closest('[data-sig-trio]'))
  })
  it('before migrations/signature_linkedin.sql: the personal field is hidden and the rest works', async () => {
    await mount(DATA())
    expect(own()).toBeUndefined()
    expect(field('LinkedIn')).toBeTruthy()
    expect(container.querySelector('iframe[data-sig-preview]')).toBeTruthy()
  })
  it('the screen’s own email previews follow the same rule', () => {
    const body = { person: { name: 'Jane', linkedinUrl: 'https://www.linkedin.com/in/jane' }, links: { linkedin_url: 'https://www.linkedin.com/company/x' }, location: { name: 'B' } }
    expect(signatureFromData(body)!.linkedinUrl).toBe('https://www.linkedin.com/company/x')
    expect(signatureFromData({ ...body, links: { linkedin_url: '  ' } })!.linkedinUrl).toBe('https://www.linkedin.com/in/jane')
    expect(signatureFromData({ ...body, links: {}, person: { name: 'Jane' } })!.linkedinUrl).toBeNull()
  })
})
