// @vitest-environment node
//
// THE SHAPE OF AN EMAIL BODY (2026-11-13, slice 2a of the rich-text editor:
// the groundwork, with no screen change).
//
// A body is plain text (every body today) or the editor's small set of HTML
// tags, and its row says which (body_format). Pinned here:
//
//   • every existing body round-trips load → save with no merge tag altered
//     (the seeded bodies always; every LIVE body when LIVE_BODIES_JSON points
//     at a dump — see the note at that test)
//   • a plain body renders byte-identical through the send path, and is
//     byte-identical again after being opened and saved as html
//   • nothing but the whitelisted tags survives a save, proven server-side
//     (through the routes, not just the function)
//   • a body that is already html is not processed twice
//   • merge values dropped into an html body are escaped
//   • read-only people cannot save a body: the server refuses
//   • the migration only adds a column; no body is written
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = { queue: [] as { table: string; resp: Resp }[], updates: [] as any[], inserts: [] as any[], deletes: [] as string[], role: 'owner' }
  const enqueue = (table: string, data: any, error: any = null) => state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'in', 'limit', 'order']) b[m] = () => b
    b.update = (patch: any) => { state.updates.push({ table, patch: { ...patch } }); return b }
    b.insert = (rows: any) => { state.inserts.push({ table, rows: JSON.parse(JSON.stringify(rows)) }); return b }
    b.delete = () => { state.deletes.push(table); return b }
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, enqueue, makeBuilder, reset: () => { state.queue = []; state.updates = []; state.inserts = []; state.deletes = []; state.role = 'owner' } }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u1', role: h.state.role, location_id: 'loc-1' }, error: null }) }) }) }),
  }),
}))

import {
  sanitizeEmailHtml, plainBodyToHtml, htmlBodyToText, parseEmailHtml, mergeTagsIn, bodyFormatOf, allowedHref,
} from './email-body-html'
import { bodyForSave, isMissingBodyFormatColumn } from './email-body-save'
import { buildBrandedDripHtml, buildBrandedDripText } from './drip-email-layout'
import { SIGNATURE_MARKER } from './email-signature'
import { renderTemplate } from './resend'
import { parseStepExtras, extrasNeedingMissingColumns, stepExtrasForInsert, stepExtrasFromRow, STEP_EXTRA_COLUMNS } from './drip-step-extras'
import { PATCH as stepPATCH } from '@/app/api/drip-path-steps/[stepId]/route'
import { PATCH as stepsPATCH } from '@/app/api/drip-paths/[id]/steps/route'
import { PATCH as templatePATCH } from '@/app/api/templates/[id]/route'
import { POST as templatePOST } from '@/app/api/templates/route'
import { POST as duplicatePOST } from '@/app/api/templates/[id]/duplicate/route'

beforeEach(() => h.reset())
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 16)

// Everything a saved body may contain: the eleven tags, one style, one href.
const ONLY_WHITELIST = /^(?:<(?:p|h2|h3)(?: style="text-align:(?:center|right)")?>|<\/(?:p|h2|h3|strong|em|u|ul|ol|li|a)>|<(?:br|strong|em|u|ul|ol|li)>|<a href="[^"<>]*">|[^<>])*$/

// ─── the bodies the repo seeds: every master wording ────────────────────
// Every quoted SQL string in the seed files that reads like a body (a merge
// tag and a line break). Not the live table — that is the gated test below.
const SEED_FILES = ['seed_master_drip_paths.sql', 'seed_returning_drip_path.sql', 'returning_drip_path_variants.sql', 'drips_infrastructure.sql']
const SEEDED: string[] = Array.from(new Set(SEED_FILES.flatMap(f =>
  Array.from(read(`migrations/${f}`).matchAll(/'((?:[^']|'')*)'/g)).map(m => m[1].replace(/''/g, "'")).filter(b => b.includes('{{') && b.includes('\n') && b.length > 80))))

const SIG = { name: 'Lynette Ewy', title: 'Owner', email: 'lynette@example.com', mobile: '(303) 555-0142', photoPath: null, websiteUrl: 'https://beeorganized.com', facebookUrl: null, instagramUrl: null, linkedinUrl: null }
const VALUES = {
  first_name: 'Jordan', location_name: 'Central Denver', owner_name: 'Lynette Ewy', owner_first_name: 'Lynette', organizer_name: 'Lynette',
  phone: '3035550142', location_phone: '3035550142', rate_per_hour: '$95', service_area: 'Denver, CO', location_owner_name: 'Lynette Ewy',
  booking_link: 'https://cal.example.com/home?a=1&b=2', book_assessment_link: 'https://cal.example.com/home?a=1&b=2',
  owner_booking_link: 'https://cal.example.com/own', discovery_booking_link: 'https://cal.example.com/discovery',
  virtual_booking_link: 'https://cal.example.com/video', reviews_link: 'https://g.page/r/x', partner_name: 'Pat',
}
const CTXS = [
  { name: 'bare', ctx: {} },
  { name: 'signature', ctx: { signature: SIG } },
  { name: 'button', ctx: { button: { label: 'Book a discovery call', href: 'https://cal.example.com/discovery' } } },
  { name: 'button + signature, right, rounded', ctx: { signature: SIG, style: 'rounded', button: { label: 'Go', href: 'https://cal.example.com/discovery', align: 'right' } } },
  { name: 'reviews line', ctx: { reviews_link: 'https://g.page/r/x', signature: SIG } },
]
const base = { location_name: 'Central Denver', location_phone: '(303) 555-0142', heading: 'Thank you for reaching out!', style: 'soft' }

// One body through the send path, both ways: as the plain row it is today,
// and as the html row it becomes when the editor opens it and saves it.
//
// THE ONE DIFFERENCE, on purpose: blank lines at the very END (or start) of a
// body. The plain path sends them — a trailing blank line is an empty
// paragraph, a trailing newline a dangling line break. Nobody typed those to
// be seen, and the html path does not send them. So the html email is held
// against the plain email OF THE SAME BODY WITH ITS EDGE NEWLINES TRIMMED,
// byte for byte. 4 of the 262 live bodies end that way (2026-11-13).
const edgeTrimmed = (body: string) => body.replace(/^\n+|\n+$/g, '')
function bothWays(body: string, ctx: any) {
  const plain = renderTemplate({ subject: 'S', body: edgeTrimmed(body) }, VALUES as any, { signatureMarker: true })
  const saved = bodyForSave(plainBodyToHtml(body), 'html')
  const html = renderTemplate({ subject: 'S', body: saved.body }, VALUES as any, { signatureMarker: true, bodyFormat: 'html' })
  const c = { ...base, ...ctx }
  return {
    saved: saved.body,
    plainHtml: buildBrandedDripHtml(plain.body, c), plainText: buildBrandedDripText(plain.body, c),
    htmlHtml: buildBrandedDripHtml(html.body, { ...c, bodyFormat: 'html' }), htmlText: buildBrandedDripText(html.body, { ...c, bodyFormat: 'html' }),
  }
}
// What a body's text is once runs of blank lines are one blank line — the
// only thing load → save is allowed to change.
// (and a doubled space before a link's brackets, "here:  (link)", which the
// send has always dropped along with the brackets)
const norm = (s: string) => s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\((?=https?:\/\/|\{\{)/g, ' (')

function roundTrip(bodies: string[]) {
  const tagsChanged: string[] = [], textChanged: string[] = [], notWhitelist: string[] = [], notStable: string[] = [], sendDiffers: string[] = []
  for (const body of bodies) {
    const saved = bodyForSave(plainBodyToHtml(body), 'html').body
    const id = sha(body)
    if (JSON.stringify(mergeTagsIn(saved)) !== JSON.stringify(mergeTagsIn(body))) tagsChanged.push(id)
    if (htmlBodyToText(saved) !== norm(body)) textChanged.push(id)   // every character, edge newlines included
    if (!ONLY_WHITELIST.test(saved)) notWhitelist.push(id)
    if (sanitizeEmailHtml(saved) !== saved) notStable.push(id)
    for (const { name, ctx } of CTXS) {
      const r = bothWays(body, ctx)
      if (r.plainHtml !== r.htmlHtml || norm(r.plainText) !== norm(r.htmlText)) sendDiffers.push(`${id} (${name})`)
    }
  }
  return { tagsChanged, textChanged, notWhitelist, notStable, sendDiffers }
}

describe('every existing body round-trips load → save', () => {
  it('there are seeded bodies to check, and they carry merge tags', () => {
    expect(SEEDED.length).toBeGreaterThanOrEqual(30)
    expect(SEEDED.every(b => mergeTagsIn(b).length > 0)).toBe(true)
    expect(SEEDED.some(b => /\(\{\{\w+\}\}\)/.test(b))).toBe(true)   // "HERE ({{book_assessment_link}})"
  })
  it('seeded bodies: no merge tag altered, no word altered, only whitelisted tags, and the sent email is byte for byte the same', () => {
    expect(roundTrip(SEEDED)).toEqual({ tagsChanged: [], textChanged: [], notWhitelist: [], notStable: [], sendDiffers: [] })
  })
  // THE LIVE BODIES. They are owners' own wording, so they are not kept in
  // the repo. Dump drip_path_steps.body + templates.body (email rows) to a
  // JSON array of strings, read-only, and point LIVE_BODIES_JSON at it:
  //   LIVE_BODIES_JSON=/path/bodies.json npx vitest run lib/beta-email-body-format.test.ts
  it.skipIf(!process.env.LIVE_BODIES_JSON)('LIVE bodies: the same, for every one of them', () => {
    const bodies: string[] = JSON.parse(readFileSync(process.env.LIVE_BODIES_JSON!, 'utf8'))
    const r = roundTrip(bodies)
    process.stdout.write(`\n[live round trip] ${bodies.filter(b => b !== edgeTrimmed(b)).length} bodies have blank lines at an edge\n[live round trip] ${bodies.length} bodies, ${bodies.reduce((n, b) => n + mergeTagsIn(b).length, 0)} merge tags, ${bodies.length * CTXS.length} sends compared; tags changed ${r.tagsChanged.length}, text changed ${r.textChanged.length}, outside whitelist ${r.notWhitelist.length}, send differs ${r.sendDiffers.length}\n`)
    expect(r).toEqual({ tagsChanged: [], textChanged: [], notWhitelist: [], notStable: [], sendDiffers: [] })
  })
})

describe('a plain body is sent exactly as before', () => {
  const BODY = 'Hi {{first_name}},\n\nClick HERE ({{book_assessment_link}}) to book, or see https://beeorganized.com\nSecond line & more <3\n\nThank you,\n{{signature}}\n\nP.S. Be sure to look.'
  it('bodyFormat absent, null and "plain" are the same email', () => {
    const r = renderTemplate({ subject: 'S', body: BODY }, VALUES as any, { signatureMarker: true })
    const a = buildBrandedDripHtml(r.body, { ...base, signature: SIG })
    expect(buildBrandedDripHtml(r.body, { ...base, signature: SIG, bodyFormat: null })).toBe(a)
    expect(buildBrandedDripHtml(r.body, { ...base, signature: SIG, bodyFormat: 'plain' })).toBe(a)
    expect(buildBrandedDripText(r.body, { ...base, signature: SIG, bodyFormat: 'plain' })).toBe(buildBrandedDripText(r.body, { ...base, signature: SIG }))
    expect(a).toContain('Second line &amp; more &lt;3')
  })
  it('renderTemplate without the option fills values unescaped, as it always did', () => {
    const v = { first_name: 'Tom & <Jerry>' } as any
    expect(renderTemplate({ subject: '{{first_name}}', body: 'Hi {{first_name}}' }, v).body).toBe('Hi Tom & <Jerry>')
    expect(renderTemplate({ subject: '{{first_name}}', body: 'Hi {{first_name}}' }, v, { bodyFormat: 'plain' }).body).toBe('Hi Tom & <Jerry>')
  })
  it('opened and saved as html, it is still the same email — every look, with and without a button and a signature', () => {
    for (const { name, ctx } of CTXS) {
      const r = bothWays(BODY, ctx)
      expect(r.htmlHtml, name).toBe(r.plainHtml)
      expect(r.htmlText, name).toBe(r.plainText)
    }
  })
})

describe('a merge tag that fills in as nothing leaves no hole', () => {
  const BODY = 'Hi {{first_name}},\n\n{{owner_first_name}}\n\nThank you,\n{{owner_name}}\nBee Organized {{location_name}}'
  const run = (values: any) => {
    const plain = renderTemplate({ subject: 'S', body: BODY }, values, { signatureMarker: true })
    const html = renderTemplate({ subject: 'S', body: bodyForSave(plainBodyToHtml(BODY), 'html').body }, values, { signatureMarker: true, bodyFormat: 'html' })
    return [buildBrandedDripHtml(plain.body, base), buildBrandedDripHtml(html.body, { ...base, bodyFormat: 'html' })]
  }
  it('a paragraph that is only a blank tag is not sent as an empty paragraph, and a blank line inside one is not a dangling break — same as plain', () => {
    const [plain, html] = run({ first_name: 'Jordan', location_name: 'Denver' })
    expect(html).toBe(plain)
    expect(html).not.toMatch(/<p [^>]*><\/p>/)
    expect(html).toContain('>Thank you,</p>')
    expect(html).toContain('>Bee Organized Denver</p>')
  })
  it('with every value present it is the same email too', () => {
    const [plain, html] = run({ first_name: 'Jordan', location_name: 'Denver', owner_first_name: 'Lynette', owner_name: 'Lynette Ewy' })
    expect(html).toBe(plain)
    expect(html).toContain('>Thank you,<br />Lynette Ewy<br />Bee Organized Denver</p>')
  })
  it('blank lines at the end of a body are not sent (the plain path sends an empty paragraph there)', () => {
    const plain = buildBrandedDripHtml('Hello\n\n', base)
    const html = buildBrandedDripHtml(plainBodyToHtml('Hello\n\n'), { ...base, bodyFormat: 'html' })
    expect(plain).toMatch(/>Hello<\/p>\n<p [^>]*><\/p>/)
    expect(html).not.toMatch(/<p [^>]*><\/p>/)
    expect(html).toBe(buildBrandedDripHtml('Hello', base))
  })
})

describe('a body that is already html is not processed twice', () => {
  const HTML = '<p>Hi {{first_name}},</p><h2>What we do</h2><ul><li>One <strong>bold</strong></li><li>Two</li></ul><ol><li>First</li></ol><p style="text-align:center">See <a href="{{discovery_booking_link}}">my <em>calendar</em></a> &amp; <u>more</u></p>'
  const sent = (body: string, ctx: any = {}) => {
    const r = renderTemplate({ subject: 'S', body }, VALUES as any, { signatureMarker: true, bodyFormat: 'html' })
    return buildBrandedDripHtml(r.body, { ...base, ...ctx, bodyFormat: 'html' })
  }
  it('its tags reach the email as tags, never as escaped text', () => {
    const out = sent(HTML)
    expect(out).not.toMatch(/&lt;(p|strong|ul|li|a|h2|em|u)\b/)
    expect(out).toContain('<strong style="font-weight:700;">bold</strong>')   // the body is weight 300; bold has to say 700 to look bold
    expect(out).toContain('<em>calendar</em>')
    expect(out).toContain('<u>more</u>')
    expect(out).toMatch(/<a href="https:\/\/cal\.example\.com\/discovery" style="[^"]*text-decoration:underline;">my <em>calendar<\/em><\/a> &amp; /)
  })
  it('every block carries its own inline style, as email needs — a list, a heading, a centred paragraph', () => {
    const out = sent(HTML)
    expect(out).toMatch(/<h2 class="dm-text" style="[^"]*font-size:22px[^"]*">What we do<\/h2>/)
    expect(out).toMatch(/<ul style="margin:0 0 20px 0;padding:0 0 0 24px;"><li class="dm-text" style="[^"]*font-size:17px[^"]*">One /)
    expect(out).toMatch(/<ol style="[^"]*"><li [^>]*>First<\/li><\/ol>/)
    expect(out).toMatch(/<p class="dm-text" style="[^"]*font-size:17px[^"]*text-align:center;">See /)
  })
  it('the same row read as plain WOULD show its tags — which is why the format is a column, not a guess', () => {
    const r = renderTemplate({ subject: 'S', body: HTML }, VALUES as any, { signatureMarker: true })
    expect(buildBrandedDripHtml(r.body, base)).toContain('&lt;strong&gt;bold&lt;/strong&gt;')
  })
  it('a plain body with a "<" in it stays text: "a < b" is not markup', () => {
    const r = renderTemplate({ subject: 'S', body: 'If a < b and <b>c</b>' }, VALUES as any, { signatureMarker: true })
    expect(buildBrandedDripHtml(r.body, base)).toContain('If a &lt; b and &lt;b&gt;c&lt;/b&gt;')
  })
  it('the text half reads as text: lists, links as "words (address)", no tags', () => {
    const r = renderTemplate({ subject: 'S', body: HTML }, VALUES as any, { signatureMarker: true, bodyFormat: 'html' })
    const text = buildBrandedDripText(r.body, { ...base, bodyFormat: 'html' })
    expect(text).not.toMatch(/<\/?[a-z]/)
    expect(text).toContain('- One bold\n- Two')
    expect(text).toContain('1. First')
    expect(text).toContain('See my calendar (https://cal.example.com/discovery) & more')
  })
  it('even if a row marked html holds something the editor never wrote, only the whitelist is sent', () => {
    const out = sent('<p onclick="x()">Hi<script>alert(1)</script><img src=x onerror=alert(1)></p><iframe src="https://evil.example"></iframe><p><a href="javascript:alert(1)">click</a></p>')
    expect(out).not.toMatch(/onclick|<script|alert\(1\)|<img src=x|<iframe|javascript:/)
    expect(out).toContain('>Hi</p>')
  })
  it('{{signature}} in an html body is laid out once, after "Thank you," — and the button goes before both', () => {
    const body = '<p>Message</p><p>Thank you,</p><p>{{signature}}</p><p>P.S. more</p>'
    const out = sent(body, { signature: SIG, button: { label: 'Go', href: 'https://cal.example.com/x' } })
    expect(out.split('Lynette Ewy</td>').length).toBe(2)
    expect(out).not.toContain(SIGNATURE_MARKER)
    const at = (s: string) => out.indexOf(s)
    expect(at('>Message</p>')).toBeLessThan(at('>Go</a>'))
    expect(at('>Go</a>')).toBeLessThan(at('>Thank you,</p>'))
    expect(at('>Thank you,</p>')).toBeLessThan(at('Lynette Ewy</td>'))
    expect(at('Lynette Ewy</td>')).toBeLessThan(at('>P.S. more</p>'))
  })
})

describe('merge values dropped into an html body are escaped', () => {
  const v = { ...VALUES, first_name: 'Tom <b>&</b> "Jerry"', discovery_booking_link: 'https://cal.example.com/d?a=1&b="2"' } as any
  it('a name with markup in it is text', () => {
    const r = renderTemplate({ subject: 'Hi {{first_name}}', body: '<p>Hi {{first_name}}</p>' }, v, { bodyFormat: 'html' })
    expect(r.body).toBe('<p>Hi Tom &lt;b&gt;&amp;&lt;/b&gt; &quot;Jerry&quot;</p>')
    expect(r.subject).toBe('Hi Tom <b>&</b> "Jerry"')   // a subject is always text
    const out = buildBrandedDripHtml(r.body, { ...base, bodyFormat: 'html' })
    expect(out).toContain('Hi Tom &lt;b&gt;&amp;&lt;/b&gt; &quot;Jerry&quot;</p>')
    expect(out).not.toContain('<b>')
  })
  it('a link value cannot break out of its href', () => {
    const r = renderTemplate({ subject: 'S', body: '<p><a href="{{discovery_booking_link}}">Book</a></p>' }, v, { bodyFormat: 'html' })
    const out = buildBrandedDripHtml(r.body, { ...base, bodyFormat: 'html' })
    expect(out).not.toMatch(/href="[^"]*"2"/)
    expect(out).not.toMatch(/<a href="[^"]*" [^s]/)
  })
  it('an address typed as the words of a link is one link, not a link inside a link', () => {
    const r = renderTemplate({ subject: 'S', body: '<p><a href="https://one.example.com/x">https://one.example.com/x</a></p>' }, {} as any, { bodyFormat: 'html' })
    const out = buildBrandedDripHtml(r.body, { ...base, bodyFormat: 'html' })
    expect(out.split('<a href="https://one.example.com/x"').length).toBe(2)
  })
  it('a saved link with no https:// is shown as words and its address, not dropped and not made a dead link', () => {
    const r = renderTemplate({ subject: 'S', body: '<p>Click <a href="{{discovery_booking_link}}">HERE</a></p>' }, { discovery_booking_link: 'calendly.com/kc' } as any, { bodyFormat: 'html' })
    const out = buildBrandedDripHtml(r.body, { ...base, bodyFormat: 'html' })
    expect(out).toContain('Click HERE (calendly.com/kc)</p>')
    expect(out).not.toContain('href="calendly.com/kc"')
  })
})

describe('what a save keeps: the whitelist, rebuilt', () => {
  const NASTY = [
    '<p class="MsoNormal" style="margin:0in;font-family:Calibri"><span style="color:red;font-size:11pt">Hello<o:p></o:p></span></p>',
    '<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--><p>Hi</p><style>p{color:red}</style>',
    '<div><table><tr><td><font face="Arial">Cell</font></td></tr></table></div>',
    '<p>Hi<script>alert(1)</script></p><img src="x" onerror="alert(1)"><svg onload="x"><circle/></svg>',
    '<p style="text-align:center;background:url(javascript:alert(1))" onclick="x()" id="a" class="b">Centred</p>',
    '<h1>Big</h1><h4>Small</h4><blockquote>Quote</blockquote><pre>code</pre><hr>',
    '<ul><li><p>One</p><p>Two</p></li><li>Three<ul><li>Nested</li></ul></li></ul>',
    '<p><b>B</b><i>I</i><u>U</u><s>S</s><sub>x</sub><mark>m</mark><code>c</code></p>',
    '<a href="https://ok.example/x?a=1&amp;b=2" target="_blank" rel="x" onclick="y()">ok</a> loose text <br> more',
    '<p>unclosed <strong>bold <em>both',
    '<p>a &lt; b &amp;&amp; c &gt; d &quot;q&quot; &#39;s&#39; &nbsp;</p>',
    '< p >not a tag</ p > 5 < 6 > 4',
    '<p title="a > b">attr with gt</p><p data-x=\'<script>\'>y</p>',
    '<P ALIGN="RIGHT">Shout</P><BR/><STRONG>Loud</STRONG>',
  ]
  it('whatever comes in, only the eleven tags, text-align and href come out — and a second pass changes nothing', () => {
    for (const html of NASTY) {
      const out = sanitizeEmailHtml(html)
      expect(out, html).toMatch(ONLY_WHITELIST)
      expect(sanitizeEmailHtml(out), html).toBe(out)
      expect(out, html).not.toMatch(/script|onerror|onclick|onload|javascript:|class=|font|Mso|<span|<div|<table|<img|<svg|alert\(1\)/i)
    }
  })
  it('the words survive: a Word paste keeps its text and loses everything else', () => {
    expect(sanitizeEmailHtml(NASTY[0])).toBe('<p>Hello</p>')
    expect(sanitizeEmailHtml(NASTY[1])).toBe('<p>Hi</p>')
    expect(sanitizeEmailHtml(NASTY[2])).toBe('<p>Cell</p>')
    expect(sanitizeEmailHtml(NASTY[5])).toBe('<h2>Big</h2><h3>Small</h3><p>Quotecode</p>')
    expect(sanitizeEmailHtml(NASTY[6])).toBe('<ul><li>One<br>Two</li><li>Three</li><li>Nested</li></ul>')
    expect(sanitizeEmailHtml(NASTY[7])).toBe('<p><strong>B</strong><em>I</em><u>U</u>Sxmc</p>')
    expect(sanitizeEmailHtml(NASTY[13])).toBe('<p style="text-align:right">Shout</p><p><br><strong>Loud</strong></p>')
  })
  it('text-align: centre and right are kept, left and anything else are not', () => {
    expect(sanitizeEmailHtml('<p style="text-align: center">a</p><h2 style="text-align:right;color:red">b</h2><p style="text-align:left">c</p><p style="text-align:justify">d</p>'))
      .toBe('<p style="text-align:center">a</p><h2 style="text-align:right">b</h2><p>c</p><p>d</p>')
    // the old align attribute (Word, Outlook) is read the same way, and no wider
    expect(sanitizeEmailHtml('<p align="center">a</p><p align="justify">b</p><p align="left">c</p><p align="x&quot; onclick=&quot;y">d</p>'))
      .toBe('<p style="text-align:center">a</p><p>b</p><p>c</p><p>d</p>')
  })
  describe('a link', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'mailto:a@b.com', 'tel:5551234', '/relative', 'calendly.com/kc', 'ftp://files.example.com', 'https://a b.com', '{{first_name}} x', '']) {
      it(`href "${bad}" → the link is dropped, the words stay`, () => {
        expect(sanitizeEmailHtml(`<p>see <a href="${bad.replace(/"/g, '&quot;')}">these words</a> now</p>`)).toBe('<p>see these words now</p>')
        expect(allowedHref(bad)).toBeNull()
      })
    }
    it('http, https and exactly one merge tag are kept', () => {
      expect(sanitizeEmailHtml('<a href="https://a.example/x?y=1&amp;z=2">a</a><a href="http://b.example">b</a><a href="{{book_assessment_link}}">c</a>'))
        .toBe('<p><a href="https://a.example/x?y=1&amp;z=2">a</a><a href="http://b.example">b</a><a href="{{book_assessment_link}}">c</a></p>')
    })
  })
  it('a merge tag is the same characters before and after, wherever it sits', () => {
    const html = '<p>Hi {{first_name}}, <strong>{{location_name}}</strong> <a href="{{booking_link}}">{{owner_name}}</a></p><ul><li>{{rate_per_hour}}</li></ul><p>{{signature}}</p>'
    expect(mergeTagsIn(sanitizeEmailHtml(html))).toEqual(['{{first_name}}', '{{location_name}}', '{{booking_link}}', '{{owner_name}}', '{{rate_per_hour}}', '{{signature}}'])
  })
})

describe('opening a plain body', () => {
  it('paragraphs, line breaks, and text that looks like markup stays text', () => {
    expect(plainBodyToHtml('One\ntwo\n\nIf a < b & c > d\n\n\n\nLast')).toBe('<p>One<br>two</p><p>If a &lt; b &amp; c &gt; d</p><p>Last</p>')
  })
  it('"word (address)" becomes a real link on the word; a merge tag in the brackets too; a bare address links itself', () => {
    expect(plainBodyToHtml('Click HERE (https://cal.example.com/x?a=1&b=2) or HERE ({{book_assessment_link}}) or https://beeorganized.com'))
      .toBe('<p>Click <a href="https://cal.example.com/x?a=1&amp;b=2">HERE</a> or <a href="{{book_assessment_link}}">HERE</a> or <a href="https://beeorganized.com">https://beeorganized.com</a></p>')
  })
  it('and reads back as the text it came from', () => {
    const body = 'Hi {{first_name}},\n\nClick HERE ({{book_assessment_link}}) now.\nOr https://beeorganized.com\n\nThank you,\n{{signature}}'
    expect(htmlBodyToText(plainBodyToHtml(body))).toBe(body)
  })
  it('a missing column, null, or an unknown value is plain', () => {
    expect([bodyFormatOf(null), bodyFormatOf({}), bodyFormatOf({ body_format: null }), bodyFormatOf({ body_format: 'markdown' }), bodyFormatOf({ body_format: 'html' })])
      .toEqual(['plain', 'plain', 'plain', 'plain', 'html'])
  })
  it('parsing never throws on rubbish', () => {
    for (const x of [null, undefined, '', '<', '<<<>>>', '<a', '</p></p></li></ul>', '<li>orphan', '&#xZZ; &#99999999; &bogus;']) expect(() => parseEmailHtml(x as any)).not.toThrow()
  })
})

// ─── the server ─────────────────────────────────────────────────────────
const DIRTY = '<p class="x" onclick="y()">Hi <b>there</b><script>alert(1)</script> <a href="javascript:alert(1)">bad</a> <a href="{{book_assessment_link}}">good</a></p>'
const CLEAN = '<p>Hi <strong>there</strong> bad <a href="{{book_assessment_link}}">good</a></p>'
const req = (url: string, body: any, method = 'PATCH') => new NextRequest(`http://x${url}`, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const stepLookup = () => h.enqueue('drip_path_steps', { id: 's1', drip_path_id: 'p1', channel: 'email', master_template_id: null, drip_paths: { id: 'p1', is_master: false, location_uuid: 'loc-1' } })
const MISSING = { message: 'Could not find the \'body_format\' column of \'drip_path_steps\' in the schema cache' }
const lastPatch = (table: string) => h.state.updates.filter(u => u.table === table).pop()?.patch

describe('saving one drip email (PATCH /api/drip-path-steps/:id)', () => {
  it('an html body is rebuilt from the whitelist on the server, and marked html', async () => {
    stepLookup(); h.enqueue('drip_path_steps', { id: 's1' })
    const res = await stepPATCH(req('/api/drip-path-steps/s1', { body: DIRTY, body_format: 'html' }), { params: { stepId: 's1' } })
    expect(res.status).toBe(200)
    expect(lastPatch('drip_path_steps')).toMatchObject({ body: CLEAN, body_format: 'html' })
    expect(lastPatch('drip_path_steps').body).toMatch(ONLY_WHITELIST)
  })
  it('a plain body is stored exactly as typed — even one that looks like html — and marked plain', async () => {
    stepLookup(); h.enqueue('drip_path_steps', { id: 's1' })
    await stepPATCH(req('/api/drip-path-steps/s1', { body: DIRTY }), { params: { stepId: 's1' } })
    expect(lastPatch('drip_path_steps')).toMatchObject({ body: DIRTY, body_format: 'plain' })
  })
  it('any other format word is plain', async () => {
    stepLookup(); h.enqueue('drip_path_steps', { id: 's1' })
    await stepPATCH(req('/api/drip-path-steps/s1', { body: 'x', body_format: 'markdown' }), { params: { stepId: 's1' } })
    expect(lastPatch('drip_path_steps')).toMatchObject({ body: 'x', body_format: 'plain' })
  })
  it('a save that does not touch the body does not touch the format', async () => {
    stepLookup(); h.enqueue('drip_path_steps', { id: 's1' })
    await stepPATCH(req('/api/drip-path-steps/s1', { delay_days: 3, body_format: 'html' }), { params: { stepId: 's1' } })
    expect(lastPatch('drip_path_steps')).not.toHaveProperty('body_format')
    expect(lastPatch('drip_path_steps')).not.toHaveProperty('body')
  })
  it('before the migration: a plain save goes through without the mark', async () => {
    stepLookup(); h.enqueue('drip_path_steps', null, MISSING); h.enqueue('drip_path_steps', { id: 's1' })
    const res = await stepPATCH(req('/api/drip-path-steps/s1', { body: 'Hello' }), { params: { stepId: 's1' } })
    expect(res.status).toBe(200)
    expect(h.state.updates.length).toBe(2)
    expect(h.state.updates[1].patch).toMatchObject({ body: 'Hello' })
    expect(h.state.updates[1].patch).not.toHaveProperty('body_format')
  })
  it('before the migration: an html save is refused, and is not retried as plain', async () => {
    stepLookup(); h.enqueue('drip_path_steps', null, MISSING)
    const res = await stepPATCH(req('/api/drip-path-steps/s1', { body: CLEAN, body_format: 'html' }), { params: { stepId: 's1' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('not_set_up_yet')
    expect(h.state.updates.length).toBe(1)
  })
  for (const role of ['lite_user', 'manager']) {
    it(`a ${role} cannot save a body, plain or html: the server refuses before writing anything`, async () => {
      for (const payload of [{ body: 'Hello' }, { body: CLEAN, body_format: 'html' }]) {
        h.reset(); h.state.role = role; stepLookup(); h.enqueue('drip_path_steps', { id: 's1' })
        const res = await stepPATCH(req('/api/drip-path-steps/s1', payload), { params: { stepId: 's1' } })
        expect(res.status).toBe(403)
        expect((await res.json()).error).toBe('forbidden_read_only')
        expect(h.state.updates).toEqual([])
      }
    })
  }
  it('an owner cannot save into another location’s email', async () => {
    h.enqueue('drip_path_steps', { id: 's1', drip_path_id: 'p1', channel: 'email', master_template_id: null, drip_paths: { id: 'p1', is_master: false, location_uuid: 'loc-2' } })
    const res = await stepPATCH(req('/api/drip-path-steps/s1', { body: CLEAN, body_format: 'html' }), { params: { stepId: 's1' } })
    expect(res.status).toBe(403)
    expect(h.state.updates).toEqual([])
  })
})

const TPL = (over: any = {}) => ({ id: 't1', type: 'email', subject: 'Welcome', body: 'B', location_uuid: 'loc-1', ...over })
describe('saving a template (PATCH /api/templates/:id)', () => {
  it('html is rebuilt and marked; plain is stored as typed and marked', async () => {
    h.enqueue('templates', TPL()); h.enqueue('templates', TPL())
    await templatePATCH(req('/api/templates/t1', { body: DIRTY, body_format: 'html' }), { params: { id: 't1' } })
    expect(lastPatch('templates')).toMatchObject({ body: CLEAN, body_format: 'html' })
    h.reset(); h.enqueue('templates', TPL()); h.enqueue('templates', TPL())
    await templatePATCH(req('/api/templates/t1', { body: DIRTY }), { params: { id: 't1' } })
    expect(lastPatch('templates')).toMatchObject({ body: DIRTY, body_format: 'plain' })
  })
  for (const type of ['sms', 'call']) {
    it(`a ${type} template can never be html`, async () => {
      h.enqueue('templates', TPL({ type, subject: null }))
      const res = await templatePATCH(req('/api/templates/t1', { body: CLEAN, body_format: 'html' }), { params: { id: 't1' } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('html_only_for_email')
      expect(h.state.updates).toEqual([])
    })
  }
  it('before the migration: plain goes through without the mark, html is refused', async () => {
    const missing = { message: 'column templates.body_format does not exist' }
    h.enqueue('templates', TPL()); h.enqueue('templates', null, missing); h.enqueue('templates', TPL())
    expect((await templatePATCH(req('/api/templates/t1', { body: 'Hello' }), { params: { id: 't1' } })).status).toBe(200)
    expect(h.state.updates[1].patch).not.toHaveProperty('body_format')
    h.reset(); h.enqueue('templates', TPL()); h.enqueue('templates', null, missing)
    expect((await templatePATCH(req('/api/templates/t1', { body: CLEAN, body_format: 'html' }), { params: { id: 't1' } })).status).toBe(409)
    expect(h.state.updates.length).toBe(1)
  })
  for (const role of ['lite_user', 'manager']) {
    it(`a ${role} cannot save a template body`, async () => {
      h.state.role = role; h.enqueue('templates', TPL())
      const res = await templatePATCH(req('/api/templates/t1', { body: CLEAN, body_format: 'html' }), { params: { id: 't1' } })
      expect(res.status).toBe(403)
      expect(h.state.updates).toEqual([])
    })
  }
})

describe('creating and copying templates', () => {
  it('a new html email template is rebuilt and marked; a new plain one names no format at all', async () => {
    h.enqueue('templates', TPL())
    await templatePOST(req('/api/templates', { name: 'N', type: 'email', subject: 'S', body: DIRTY, body_format: 'html' }, 'POST'))
    expect(h.state.inserts[0].rows).toMatchObject({ body: CLEAN, body_format: 'html' })
    h.reset(); h.enqueue('templates', TPL())
    await templatePOST(req('/api/templates', { name: 'N', type: 'email', subject: 'S', body: DIRTY }, 'POST'))
    expect(h.state.inserts[0].rows.body).toBe(DIRTY)
    expect(h.state.inserts[0].rows).not.toHaveProperty('body_format')
  })
  it('a new text-message template cannot be html', async () => {
    const res = await templatePOST(req('/api/templates', { name: 'N', type: 'sms', body: CLEAN, body_format: 'html' }, 'POST'))
    expect(res.status).toBe(400)
    expect(h.state.inserts).toEqual([])
  })
  it('a copy of an html template is html; a copy of a plain one names no format', async () => {
    h.enqueue('templates', TPL({ location_uuid: null, name: 'Welcome', body: CLEAN, body_format: 'html' })); h.enqueue('templates', TPL())
    await duplicatePOST(req('/api/templates/t1/duplicate', {}, 'POST'), { params: { id: 't1' } })
    expect(h.state.inserts[0].rows).toMatchObject({ body: CLEAN, body_format: 'html' })
    h.reset(); h.enqueue('templates', TPL({ location_uuid: null, name: 'Welcome' })); h.enqueue('templates', TPL())
    await duplicatePOST(req('/api/templates/t1/duplicate', {}, 'POST'), { params: { id: 't1' } })
    expect(h.state.inserts[0].rows).not.toHaveProperty('body_format')
  })
})

describe('saving a whole sequence (it deletes every step and writes them again)', () => {
  const step = (over: any = {}) => ({ id: 'a', step_order: 1, delay_days: 0, channel: 'email', master_template_id: null, subject: 'S', body: 'Hello', origin: 'master', is_active: true, ...over })
  const run = async (steps: any[], prior: any[] | null, cols: any = { body_format: 'plain' }) => {
    h.enqueue('drip_paths', { id: 'p1', location_uuid: 'loc-1', is_master: false })
    h.enqueue('drip_path_steps', [{ id: 'x', ...cols }])            // which columns exist
    if (prior) h.enqueue('drip_path_steps', prior)                  // the steps as stored
    h.enqueue('drip_path_steps', null)                              // delete
    h.enqueue('drip_path_steps', [])                                // insert
    return stepsPATCH(req('/api/drip-paths/p1/steps', { steps }), { params: { id: 'p1' } })
  }
  const inserted = () => h.state.inserts.find(i => i.table === 'drip_path_steps')!.rows
  it('a step that says html is rebuilt from the whitelist and written back html', async () => {
    await run([step({ body: DIRTY, body_format: 'html' })], [])
    expect(inserted()[0]).toMatchObject({ body: CLEAN, body_format: 'html' })
  })
  it('a step that says nothing, and was stored html with this same body, stays html', async () => {
    await run([step({ body: CLEAN })], [{ id: 'a', body: CLEAN, body_format: 'html' }])
    expect(inserted()[0]).toMatchObject({ body: CLEAN, body_format: 'html' })
  })
  it('a step that says nothing and whose body changed is plain, stored as typed', async () => {
    await run([step({ body: 'Typed fresh <b>' })], [{ id: 'a', body: CLEAN, body_format: 'html' }])
    expect(inserted()[0]).toMatchObject({ body: 'Typed fresh <b>', body_format: 'plain' })
  })
  it('before the migration: an html step is refused before anything is deleted', async () => {
    const res = await run([step({ body: CLEAN, body_format: 'html' })], null, {})
    expect(res.status).toBe(409)
    expect((await res.json()).columns).toEqual(['body_format'])
    expect(h.state.deletes).toEqual([])
    expect(h.state.inserts).toEqual([])
  })
  it('before the migration: plain steps save as they always did, with no format named', async () => {
    await run([step()], null, {})
    expect(inserted()[0]).not.toHaveProperty('body_format')
  })
  it('the step helpers know the column: parsed, checked, inserted, and copied on clone', () => {
    expect(STEP_EXTRA_COLUMNS).toContain('body_format')
    expect(parseStepExtras({ body_format: 'html' })).toEqual({ body_format: 'html' })
    expect(parseStepExtras({ body_format: 'nonsense' })).toEqual({})
    expect(extrasNeedingMissingColumns([{ body_format: 'html' }], new Set())).toEqual(['body_format'])
    expect(extrasNeedingMissingColumns([{ body_format: 'plain' }, {}], new Set())).toEqual([])
    expect(stepExtrasForInsert({}, new Set(['body_format'] as any))).toEqual({ body_format: 'plain' })
    expect(stepExtrasFromRow({ body_format: 'html', body: 'x' })).toEqual({ body_format: 'html' })
  })
})

describe('the column-missing check', () => {
  it('recognises both ways the database says it', () => {
    expect(isMissingBodyFormatColumn({ message: 'column drip_path_steps.body_format does not exist' })).toBe(true)
    expect(isMissingBodyFormatColumn(MISSING)).toBe(true)
    expect(isMissingBodyFormatColumn({ message: 'column button_align does not exist' })).toBe(false)
    expect(isMissingBodyFormatColumn(null)).toBe(false)
  })
})

describe('the senders read the format from the row the body came from', () => {
  it('each sender passes it to the merge fill AND to the layout', () => {
    for (const f of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'app/api/emails/test-send/route.ts']) {
      const src = read(f)
      expect(src, f).toMatch(/bodyFormatOf\(/)
      expect(src, f).toMatch(/signatureMarker: true, bodyFormat/)
      expect((src.match(/\bbodyFormat\b/g) || []).length, f).toBeGreaterThanOrEqual(3)
    }
    expect(read('lib/drip-send.ts')).toContain('bodyFormatOf((step.body != null ? step : linkedTpl)')
    expect(read('lib/welcome-email.ts')).toContain('bodyFormatOf((fork?.body != null ? fork : master)')
    expect(read('lib/stage-emails.ts')).toContain('bodyFormatOf((fork?.body != null ? fork : master)')
  })
  it('the linked template is read with every column, so the format comes along once it exists and is absent before', () => {
    expect(read('lib/drip-send.ts')).toContain('templates:master_template_id ( * )')
    expect(read('app/api/emails/test-send/route.ts')).toContain('templates:master_template_id ( * )')
    for (const f of ['lib/drip-send.ts', 'lib/welcome-email.ts', 'lib/stage-emails.ts', 'app/api/emails/test-send/route.ts', 'lib/template-fork.ts', 'lib/email-send-options.ts']) {
      expect(read(f), f).not.toMatch(/select\([^)]*body_format/)
    }
  })
  it('the plain paragraph builder is called from one place, behind the format check', () => {
    const src = read('lib/drip-email-layout.ts')
    const calls = src.split('\n').filter(l => /bodyParagraphsHtml/.test(l) && !/^\s*\/\/|^function /.test(l))
    expect(calls.length).toBe(3)
    const a = src.indexOf("if (ctx.bodyFormat === 'html') {"), b = src.indexOf('} else if (button) {')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(src.slice(a, b)).not.toContain('bodyParagraphsHtml')
    for (const l of calls) expect(src.indexOf(l)).toBeGreaterThan(b)
  })
})

describe('no body changes in the database', () => {
  it('the migration only adds a column to each table, defaulting to plain', () => {
    const sql = read('migrations/email_body_format.sql').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    const statements = sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
    expect(statements).toEqual([
      "alter table public.drip_path_steps add column if not exists body_format text not null default 'plain' check (body_format in ('plain','html'))",
      "alter table public.templates add column if not exists body_format text not null default 'plain' check (body_format in ('plain','html'))",
    ])
    expect(sql).not.toMatch(/\b(update|insert|delete|truncate)\b/i)
  })
  it('the undo only drops that column', () => {
    const sql = read('migrations/email_body_format_undo.sql').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(sql.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean)).toEqual([
      'alter table public.drip_path_steps drop column if exists body_format',
      'alter table public.templates drop column if exists body_format',
    ])
  })
  it('the seeded wording is what it was: the four seed files, by fingerprint', () => {
    expect(Object.fromEntries(SEED_FILES.map(f => [f, sha(read(`migrations/${f}`))]))).toEqual({
      'seed_master_drip_paths.sql': 'e99fe439085bc668',
      'seed_returning_drip_path.sql': '59062314bd16cd84',
      'returning_drip_path_variants.sql': 'f76ba3017dddf0f3',
      'drips_infrastructure.sql': '7b59351ea82ccef8',
    })
  })
  it('no other migration was added or changed alongside it', () => {
    const mine = readdirSync(join(process.cwd(), 'migrations')).filter(f => /body_format/.test(f)).sort()
    expect(mine).toEqual(['email_body_format.sql', 'email_body_format_undo.sql'])
  })
  it('the column record lists body_format on both tables, last', () => {
    const snap = read('lib/db-columns.snapshot.txt')
    expect(snap).toMatch(/^drip_path_steps:.*,button_align,body_format$/m)
    expect(snap).toMatch(/^templates:.*,button_align,body_format$/m)
    expect((snap.match(/body_format/g) || []).length).toBe(2)
  })
})
