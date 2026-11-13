// @vitest-environment happy-dom
//
// Settings slice 5 (2026-11-13): Call scripts, in the new look, with real
// content.
//
// A reskin AND a small data change. What is pinned here:
//
//   1 · HOW A SCRIPT IS HELD. Its shape (when to use, minutes, stages) is
//       plain text inside `templates.body` — no new columns, no route
//       changed. The reader never fails: any text is a script.
//   2 · THE SEED. migrations/seed_call_script_masters.sql adds the export's
//       five scripts, word for word, as Bee Organized's own (no location),
//       in one statement that is safe to run twice and touches no existing
//       row. Nobody but Kevin runs it.
//   3 · THE PAGE. The five show for every owner; a location's own show
//       first; one opens at a time; stages are numbered and named.
//   4 · {{BRACES}} ARE NOT MERGE TAGS. Shown as written, never filled in,
//       and the page says who fills them in.
//   5 · WHAT AN OWNER COULD DO, THEY STILL CAN: write, change and delete
//       their own, through the same three routes. One of Bee Organized's can
//       be copied, never changed or deleted by an owner.
//   6 · WHO SEES IT is who saw it before: owners. Not a manager.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHubModule from '@/components/BeeHub'
import { parseCallScript, serializeCallScript, callScriptSummary, cleanMins } from '@/lib/call-script'
import { listCallScripts, BRACES_LINE, NOT_SENT_LINE, CALL_SCRIPTS_CSS } from '@/components/settings/CallScripts'
import * as Shell from '@/components/settings/SettingsShell'

const { SettingsScreen, CurrentUserContext } = BeeHubModule as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const noComments = (src: string) => src.split('\n').filter(l => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('--')).join('\n')
const HUB = read('components/BeeHub.jsx')
const SETTINGS = HUB.slice(HUB.indexOf('export function SettingsScreen('), HUB.indexOf('\nfunction ', HUB.indexOf('export function SettingsScreen(') + 200000) > 0 ? undefined : undefined)
const PAGE = read('components/settings/CallScripts.jsx')
const PAGE_CODE = noComments(PAGE)
const LIB_CODE = noComments(read('lib/call-script.ts'))
const SEED = read('migrations/seed_call_script_masters.sql')
const SEED_CODE = noComments(SEED)
const UNDO_CODE = noComments(read('migrations/seed_call_script_masters_undo.sql'))

// The export's five scripts (pages.tsx, SCRIPTS), copied out by hand so the
// seed is checked against the design and not against itself.
const EXPORT: Array<{ id: string; title: string; when: string; mins: number; lines: Array<[string, string]> }> = [
  { id: 'call_new_lead_callback', title: 'New lead callback', when: 'Within 5 minutes of a website lead', mins: 4, lines: [
    ['Open', "Hi {{first_name}}, this is {{owner_name}} with Bee Organized — you just reached out on our website, so I wanted to call while it's fresh. Is now a good time?"],
    ['Discover', "Tell me a little about the space. What's bugging you most about it right now?"],
    ['Value', "That's exactly what we do every day. We'll sort, edit, and set up systems so it stays that way — and we haul off donations for you."],
    ['Close', 'The next step is a quick assessment. I have Tuesday at 10 or Thursday at 2 — which works better?'],
  ] },
  { id: 'call_past_client_check_in', title: 'Past client check-in', when: '6–12 months after a finished job', mins: 3, lines: [
    ['Open', "Hi {{first_name}}! It's {{owner_name}} from Bee Organized. I was thinking about your {{project}} and wanted to see how it's holding up."],
    ['Discover', "Is there another room that's been on your mind — garage, closets, the kitchen?"],
    ['Offer', 'Returning clients get first pick of our calendar this season, and a refresh session is a great way to reset.'],
    ['Close', 'Want me to pencil you in for a quick walk-through?'],
  ] },
  { id: 'call_realtor_partnership_intro', title: 'Realtor partnership intro', when: 'Cold call to local agents', mins: 3, lines: [
    ['Open', "Hi, is this {{agent_name}}? I'm {{owner_name}}, I own Bee Organized here in {{city}}. Got 60 seconds?"],
    ['Value', 'We help sellers declutter and stage-ready their homes, and help buyers unpack and settle in fast. Agents tell us it shortens time on market.'],
    ['Offer', "I'd love to offer your clients a closing gift — a gift card toward an organizing session, co-branded with you."],
    ['Close', 'Could I drop off a few cards and our info at your office this week?'],
  ] },
  { id: 'call_quote_follow_up', title: 'Quote follow-up', when: '3 days after sending an estimate', mins: 2, lines: [
    ['Open', "Hi {{first_name}}, {{owner_name}} here from Bee Organized. I'm following up on the plan I sent for your {{project}}."],
    ['Discover', "Did you have any questions, or is there anything you'd change?"],
    ['Handle', 'If budget is the concern, we can start with the one space that would make the biggest difference and go from there.'],
    ['Close', "I'm holding a spot on {{date}} for you — shall I lock it in?"],
  ] },
  { id: 'call_senior_move_downsizing', title: 'Senior move & downsizing', when: 'Leads from families or senior communities', mins: 5, lines: [
    ['Open', "Hi, this is {{owner_name}} with Bee Organized. I understand you're helping {{loved_one}} with a move — that's a big job, and we're here to make it easier."],
    ['Discover', "What's the timeline, and is the new place smaller than the current home?"],
    ['Value', 'We plan the layout of the new space, help decide what comes along, and handle donations, family keepsakes, and setup — so move-in day feels like home.'],
    ['Close', 'Would it help if I came by for a free consultation with you both?'],
  ] },
]
// The rows the seed would add, read out of the SQL file itself.
const SEEDED = Array.from(SEED_CODE.matchAll(/\('([^']+)', '([^']+)', '([^']+)', '([^']+)', (null|'[^']*'), \$cs\$([\s\S]*?)\$cs\$, (true|false), (null|'[^']*')\)/g))
  .map(m => ({ legacy_id: m[1], name: m[2], type: m[3], tag: m[4], subject: m[5], body: m[6], is_active: m[7], location_uuid: m[8] }))
// The one call script that existed before this slice (production, read 2026-11-13).
const T8 = 'Hi, may I speak with {{first_name}}?\n\n[If available]: Hi {{first_name}}, this is {{organizer_name}} calling from Bee Organized {{location_name}}. You recently reached out about getting organized - I just wanted to connect.\n\n[If voicemail]: Hi {{first_name}}, give me a call back!'

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HOW A SCRIPT IS HELD
// ═══════════════════════════════════════════════════════════════════════════
describe('a script’s shape is plain text inside body', () => {
  const full = { when: 'Within 5 minutes of a website lead', mins: 4, stages: [{ name: 'Open', text: 'Hi {{first_name}}.' }, { name: 'Close', text: 'Tuesday or Thursday?\n\nIf neither: offer next week.' }] }

  it('writes a short outline a person can read', () => {
    expect(serializeCallScript(full)).toBe('When to use: Within 5 minutes of a website lead\nAbout: 4 min\n\n## Open\nHi {{first_name}}.\n\n## Close\nTuesday or Thursday?\n\nIf neither: offer next week.')
  })

  it('reads back exactly what it wrote', () => {
    expect(parseCallScript(serializeCallScript(full))).toEqual(full)
    for (const s of [
      { when: '', mins: null, stages: [{ name: 'Open', text: 'Hello.' }] },
      { when: 'Any time', mins: null, stages: [{ name: '', text: 'Just words.' }] },
      { when: '', mins: 12, stages: [{ name: '', text: 'before any heading' }, { name: 'A', text: 'one' }, { name: 'C', text: '' }] },
    ]) expect(parseCallScript(serializeCallScript(s)), JSON.stringify(s)).toEqual(s)
  })

  it('text that follows no convention is one script with one unnamed stage, shown as written', () => {
    const p = parseCallScript(T8)
    expect(p.when).toBe(''); expect(p.mins).toBeNull()
    expect(p.stages).toEqual([{ name: '', text: T8 }])
    // square brackets are the writer's own words, never a stage
    expect(p.stages[0].text).toContain('[If available]:')
  })

  it('never fails: nothing, null, a number, only blank lines', () => {
    for (const v of [undefined, null, '', '   \n\n ', 42, {}]) {
      const p = parseCallScript(v as any)
      expect(p.when).toBe(''); expect(p.mins).toBeNull()
      expect(Array.isArray(p.stages)).toBe(true)
    }
    expect(parseCallScript('').stages).toEqual([])
    expect(parseCallScript('\n \n').stages).toEqual([])
  })

  it('the two top lines only count at the very top, once each, in either order', () => {
    expect(parseCallScript('About: 3 min\nWhen to use: After a job\n\n## Open\nHi')).toMatchObject({ when: 'After a job', mins: 3 })
    const later = parseCallScript('## Open\nHi\nWhen to use: not a heading here\nAbout: 9 min')
    expect(later.when).toBe(''); expect(later.mins).toBeNull()
    expect(later.stages[0].text).toBe('Hi\nWhen to use: not a heading here\nAbout: 9 min')
    const twice = parseCallScript('When to use: first\nWhen to use: second\n## Open\nHi')
    expect(twice.when).toBe('first')
    expect(twice.stages[0]).toEqual({ name: '', text: 'When to use: second' })
  })

  it('words that look like a heading survive a save and a reload as words', () => {
    const tricky = { when: '', mins: null, stages: [{ name: '', text: 'When to use: say this first\nthen this' }, { name: 'Notes', text: '## not a stage\nAbout: 5 min' }] }
    const body = serializeCallScript(tricky)
    expect(parseCallScript(body)).toEqual(tricky)
    expect(parseCallScript(body).stages.length).toBe(2)
    // …in the middle of a stage too, where no trimming could hide the difference
    const mid = { when: 'Any time', mins: null, stages: [{ name: 'Notes', text: 'first line\n## not a stage\nAbout: 5 min\nlast line' }] }
    expect(serializeCallScript(mid)).toContain('\n ## not a stage\n')
    expect(parseCallScript(serializeCallScript(mid))).toEqual(mid)
  })

  it('Windows line endings and stray spaces read the same', () => {
    expect(parseCallScript('When to use:   After a job  \r\nAbout: ~ 3 mins\r\n\r\n##   Open  \r\nHi\r\n')).toEqual({ when: 'After a job', mins: 3, stages: [{ name: 'Open', text: 'Hi' }] })
  })

  it('minutes are a whole number from 1 to 120, or nothing', () => {
    expect([cleanMins(4), cleanMins('4'), cleanMins(' 12 '), cleanMins(120)]).toEqual([4, 4, 12, 120])
    expect([cleanMins(0), cleanMins(121), cleanMins(''), cleanMins('soon'), cleanMins(null), cleanMins(-3)]).toEqual([null, null, null, null, null, null])
    expect(serializeCallScript({ when: 'x', mins: 999, stages: [{ name: 'Open', text: 'Hi' }] })).not.toContain('About:')
  })

  it('the line under a title is whichever parts exist', () => {
    expect(callScriptSummary({ when: 'After a job', mins: 3, stages: [] })).toBe('After a job · ~3 min')
    expect(callScriptSummary({ when: 'After a job', mins: null, stages: [] })).toBe('After a job')
    expect(callScriptSummary({ when: '', mins: 3, stages: [] })).toBe('~3 min')
    expect(callScriptSummary({ when: '', mins: null, stages: [] })).toBe('')
  })

  it('no new columns, and no route changed: the table and the three routes are what they were', () => {
    const atHead = (f: string) => execSync(`git show HEAD:"${f}"`, { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 }).toString()
    for (const f of ['lib/db-columns.snapshot.txt', 'app/api/templates/route.ts', 'app/api/templates/[id]/route.ts', 'app/api/templates/[id]/duplicate/route.ts']) expect(read(f), f).toBe(atHead(f))
    expect(read('lib/db-columns.snapshot.txt')).toMatch(/^templates:id,legacy_id,name,type,tag,subject,body,is_active,created_at,updated_at,location_uuid,cloned_from_id,created_by,button_text,button_link,button_align$/m)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE SEED
// ═══════════════════════════════════════════════════════════════════════════
describe('the seed adds the export’s five scripts as Bee Organized’s own', () => {
  it('five rows, in the export’s order, each a call script with no location, switched on', () => {
    expect(SEEDED.map(r => [r.legacy_id, r.name])).toEqual(EXPORT.map(e => [e.id, e.title]))
    for (const r of SEEDED) expect([r.type, r.tag, r.subject, r.is_active, r.location_uuid], r.name).toEqual(['call', 'call', 'null', 'true', 'null'])
    expect(new Set(SEEDED.map(r => r.legacy_id)).size).toBe(5)
  })

  it('word for word: when to use, minutes, every stage name and every line', () => {
    for (const e of EXPORT) {
      const row = SEEDED.find(r => r.legacy_id === e.id)!
      expect(parseCallScript(row.body), e.title).toEqual({ when: e.when, mins: e.mins, stages: e.lines.map(([name, text]) => ({ name, text })) })
      // and it is the text the page's own editor would write for it
      expect(serializeCallScript(parseCallScript(row.body)), e.title).toBe(row.body)
    }
  })

  it('one statement, safe to run twice, and it changes nothing that is already there', () => {
    expect(SEED_CODE.match(/;/g)!.length).toBe(1)
    expect(SEED_CODE.trim().startsWith('insert into public.templates (legacy_id, name, type, tag, subject, body, is_active, location_uuid)')).toBe(true)
    expect(SEED_CODE).toContain('on conflict (legacy_id) do nothing')
    expect(SEED_CODE).toMatch(/returning legacy_id, name;\s*$/)
    // (the scripts' own words are taken out first: one of them says "drop off a few cards")
    expect(SEED_CODE.replace(/\$cs\$[\s\S]*?\$cs\$/g, "''")).not.toMatch(/\b(alter|update|delete|drop|truncate|create)\b/i)
    // the one script that was already there is not named in anything that runs
    expect(SEED_CODE).not.toContain('t8')
    expect(SEED).toContain("('t8', \"Call Prompt Script\"")
  })

  it('the undo removes those five and only those, and never a location’s copy', () => {
    expect(UNDO_CODE.match(/;/g)!.length).toBe(1)
    expect(UNDO_CODE.trim().startsWith('delete from public.templates')).toBe(true)
    expect(UNDO_CODE).toContain('where location_uuid is null')
    expect(UNDO_CODE).toContain("and type = 'call'")
    expect(UNDO_CODE.replace(/\s+/g, ' ')).toMatch(/^ ?delete from public\.templates where location_uuid is null and type = 'call' and legacy_id in \(('call_[a-z_]+', ){4}'call_[a-z_]+'\) returning legacy_id, name; ?$/)
    for (const e of EXPORT) expect(UNDO_CODE).toContain(`'${e.id}'`)
    expect(UNDO_CODE.match(/'call_[a-z_]+'/g)!.length).toBe(5)
    expect(UNDO_CODE).not.toContain('t8')
  })

  it('no code runs it: the app never names the seed file or writes a script on its own', () => {
    expect(HUB).not.toContain('seed_call_script_masters')
    expect(PAGE_CODE).not.toMatch(/fetch\(|supabase/)
    expect(LIB_CODE).not.toMatch(/fetch\(|supabase|import /)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE PAGE, MOUNTED IN SETTINGS
// ═══════════════════════════════════════════════════════════════════════════
const LOC = '2b3c4d5e-1111-4222-8333-444455556666'
const OTHER = '9a9a9a9a-1111-4222-8333-444455556666'
const user = { id: 'u-owner', email: 'riley@bee.test', name: 'Riley Park', role: 'franchise', locationId: LOC, first_name: 'Riley', last_name: 'Park', phone: '', booking_link: null }
const loc = { id: LOC, name: 'Seattle', owner: 'Riley Park', street: '101 Pine St', city: 'Seattle', state: 'WA', zip: '98101', timezone: 'Pacific Time (PT)', crmStatus: 'active' }
const MASTERS = SEEDED.map((r, i) => ({ id: `m${i}`, legacy_id: r.legacy_id, name: r.name, type: 'call', tag: 'call', subject: null, body: r.body, is_active: true, location_uuid: null, is_master: true, is_own_custom: false }))
const own = (id: string, name: string, body: string, over: any = {}) => ({ id, legacy_id: null, name, type: 'call', tag: 'custom', subject: null, body, is_active: true, location_uuid: LOC, is_master: false, is_own_custom: true, ...over })
const NEVER_SHOWN = [
  { id: 'x1', legacy_id: 't8', name: 'Call Prompt Script', type: 'call', tag: 'call', subject: null, body: T8, is_active: false, location_uuid: null, is_master: true, is_own_custom: false },
  { id: 'x2', legacy_id: null, name: 'Another location’s script', type: 'call', tag: 'custom', subject: null, body: '## Open\nNot yours', is_active: true, location_uuid: OTHER, is_master: false, is_own_custom: false },
  { id: 'x3', legacy_id: 'welcome', name: 'Welcome email', type: 'email', tag: 'welcome', subject: 'Welcome', body: 'Hello {{first_name}}', is_active: true, location_uuid: null, is_master: true, is_own_custom: false },
  { id: 'x4', legacy_id: null, name: 'Switched-off own script', type: 'call', tag: 'custom', subject: null, body: '## Open\nOff', is_active: false, location_uuid: LOC, is_master: false, is_own_custom: true },
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: Array<{ url: string; method: string; body: any }>
let alerts: string[]
let confirms: number
let templates: any[] = []
let fail: Record<string, { status: number; body: any }> = {}
let listFails = false

const res = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body })
beforeEach(() => {
  calls = []; alerts = []; confirms = 0; templates = [...MASTERS, ...NEVER_SHOWN]; fail = {}; listFails = false
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const url = String(u); const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method, body })
    if (url === '/api/templates' && method === 'GET') return listFails ? res({}, false, 500) : res({ templates })
    const f = fail[method]
    if (f && url.startsWith('/api/templates')) return res(f.body, false, f.status)
    if (url === '/api/templates' && method === 'POST') return res({ template: own('new-1', body.name, body.body) })
    if (/^\/api\/templates\/[^/]+\/duplicate$/.test(url)) { const src = templates.find(t => t.id === url.split('/')[3]); return res({ template: own('copy-1', `${src.name} (Copy)`, src.body, { cloned_from_id: src.id }) }) }
    if (url.startsWith('/api/templates/') && method === 'PATCH') { const cur = templates.find(t => t.id === url.split('/')[3]); return res({ template: { ...cur, name: body.name, body: body.body } }) }
    if (url.startsWith('/api/templates/') && method === 'DELETE') return res({ ok: true })
    return res({})
  }))
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  vi.stubGlobal('confirm', () => { confirms++; return true })
  window.history.replaceState(null, '', '/')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const settle = async (ms = 15) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }
const mount = async (props: Record<string, any> = {}, location: any = loc) => {
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={user}>
        <SettingsScreen initialSection="scripts" franchiseRole="owner" selectedLoc={location} {...props} />
      </CurrentUserContext.Provider>,
    )
  })
  await settle()
}
const page = () => container.querySelector('[data-call-scripts]') as HTMLElement
const q = (sel: string, within: Element = page()) => within.querySelector(sel) as HTMLElement | null
const all = (sel: string, within: Element = page()) => Array.from(within.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const type = async (input: Element | null | undefined, value: string) => {
  if (!input) throw new Error('no input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const cards = () => all('[data-cs-card]')
const titles = () => cards().map(c => q('[data-cs-title]', c)!.textContent)
const cardOf = (title: string) => cards().find(c => q('[data-cs-title]', c)!.textContent === title)!
const isOpen = (c: Element) => q('[data-cs-head]', c)!.getAttribute('aria-expanded') === 'true'
const openCard = async (title: string) => { const c = cardOf(title); if (!isOpen(c)) await click(q('[data-cs-head]', c)); return cardOf(title) }
const stagesOf = (c: Element) => all('[data-cs-stage]', c).map(s => [q('[data-cs-stage-name]', s)?.textContent ?? null, q('[data-cs-stage-text]', s)!.textContent])
const buttonsOf = (c: Element) => all('button', c).filter(b => !b.hasAttribute('data-cs-head')).map(b => b.textContent)
const editor = () => q('[data-cs-editor]')!
const field = (name: string, n = 0) => all(`[data-cs-field="${name}"]`, editor())[n] as HTMLInputElement
const writes = () => calls.filter(c => c.method !== 'GET')
const NO_ACCESS = "You don't have access to this section"

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WHAT THE PAGE SHOWS
// ═══════════════════════════════════════════════════════════════════════════
describe('a location with no scripts of its own sees Bee Organized’s five', () => {
  it('the heading, the two sentences, the count and the five titles', async () => {
    await mount()
    const pane = page().closest('[data-settings-ui]')!
    expect(pane.querySelector('h1')!.textContent).toBe('Call scripts')
    expect(pane.textContent).toContain('Talking points for winning new business. Nothing here is sent to anyone.')
    expect(NOT_SENT_LINE).toBe('Talking points for winning new business. Nothing here is sent to anyone.')
    expect(q('[data-cs-braces]')!.textContent).toBe('Words in {{braces}} are filled in by you on the call.')
    expect(q('[data-cs-count]')!.textContent).toBe('5 scripts')
    expect(titles()).toEqual(['New lead callback', 'Past client check-in', 'Quote follow-up', 'Realtor partnership intro', 'Senior move & downsizing'])
    for (const c of cards()) { expect(c.dataset.csKind).toBe('master'); expect(q('[data-cs-pill]', c)!.textContent).toBe('Bee Organized') }
    expect(q('[data-cs-hint]')!.textContent).toContain('These are Bee Organized’s scripts.')
  })

  it('each says when to use it and about how long it takes', async () => {
    await mount()
    expect(cards().map(c => q('[data-cs-summary]', c)!.textContent)).toEqual([
      'Within 5 minutes of a website lead · ~4 min', '6–12 months after a finished job · ~3 min', '3 days after sending an estimate · ~2 min',
      'Cold call to local agents · ~3 min', 'Leads from families or senior communities · ~5 min',
    ])
  })

  it('the first is open; its stages are numbered, named, and word for word', async () => {
    await mount()
    expect(cards().map(isOpen)).toEqual([true, false, false, false, false])
    const first = cards()[0]
    expect(stagesOf(first)).toEqual(EXPORT[0].lines)
    expect(all('[data-cs-stage]', first).map(s => s.firstElementChild!.textContent)).toEqual(['1', '2', '3', '4'])
    expect(q('ol[data-cs-stages]', first)).toBeTruthy()
    // a closed one draws no stages at all
    expect(all('[data-cs-stage]', cards()[1]).length).toBe(0)
  })

  it('every script’s every stage is what the export has, including Offer and Handle', async () => {
    await mount()
    for (const e of EXPORT) expect(stagesOf(await openCard(e.title)), e.title).toEqual(e.lines)
    expect(stagesOf(await openCard('Past client check-in')).map(s => s[0])).toEqual(['Open', 'Discover', 'Offer', 'Close'])
    expect(stagesOf(await openCard('Quote follow-up')).map(s => s[0])).toEqual(['Open', 'Discover', 'Handle', 'Close'])
  })

  it('one is open at a time, and the open one can be closed', async () => {
    await mount()
    await click(q('[data-cs-head]', cardOf('Quote follow-up')))
    expect(cards().map(isOpen)).toEqual([false, false, true, false, false])
    await click(q('[data-cs-head]', cardOf('Quote follow-up')))
    expect(cards().map(isOpen)).toEqual([false, false, false, false, false])
    // each header names the block it opens
    const head = q('[data-cs-head]', await openCard('Senior move & downsizing'))!
    expect(q(`#${head.getAttribute('aria-controls')}`, page())).toBeTruthy()
  })

  it('never listed: a switched-off script (the old one), another location’s, an email template', async () => {
    await mount()
    for (const hidden of ['Call Prompt Script', 'Another location’s script', 'Welcome email', 'Switched-off own script']) expect(page().textContent, hidden).not.toContain(hidden)
    expect(listCallScripts([...MASTERS, ...NEVER_SHOWN].map(r => ({ ...r, isActive: r.is_active, isMaster: r.is_master, isOwnCustom: r.is_own_custom, locationUuid: r.location_uuid }))).all.length).toBe(5)
  })

  it('before the seed is run the page is empty and says so, with a way to write one', async () => {
    templates = [...NEVER_SHOWN]
    await mount()
    expect(q('[data-cs-count]')!.textContent).toBe('0 scripts')
    expect(q('[data-cs-none]')!.textContent).toBe('No call scripts yetWrite your first one with New script.')
    expect(q('[data-cs-new]')).toBeTruthy()
    expect(q('[data-cs-braces]')!.textContent).toBe(BRACES_LINE)
  })

  it('a list that will not load says so, and shows no count that could be read as "none"', async () => {
    listFails = true
    await mount()
    expect(q('[data-cs-load-error]')!.textContent).toBe('Your scripts could not be loaded. Reload the page to try again.')
    expect(q('[data-cs-count]')).toBeNull()
    expect(q('[data-cs-none]')).toBeNull()
  })
})

describe('a location with scripts of its own', () => {
  const MINE = [own('o2', 'Voicemail', T8), own('o1', 'Follow-up after a no-show', '## Open\nHi {{first_name}}, sorry we missed you.')]

  it('its own come first, marked Yours, then Bee Organized’s', async () => {
    templates = [...MASTERS, ...MINE, ...NEVER_SHOWN]
    await mount()
    expect(q('[data-cs-count]')!.textContent).toBe('7 scripts')
    expect(titles().slice(0, 2)).toEqual(['Follow-up after a no-show', 'Voicemail'])
    expect(cards().map(c => q('[data-cs-pill]', c)!.textContent)).toEqual(['Yours', 'Yours', 'Bee Organized', 'Bee Organized', 'Bee Organized', 'Bee Organized', 'Bee Organized'])
    expect(q('[data-cs-hint]')).toBeNull()
    expect(isOpen(cards()[0])).toBe(true)
  })

  it('a script written as plain words (as the old one was) shows as one unnamed stage, line breaks kept', async () => {
    templates = [own('o2', 'Voicemail', T8)]
    await mount()
    expect(q('[data-cs-count]')!.textContent).toBe('1 script')
    const c = await openCard('Voicemail')
    expect(stagesOf(c)).toEqual([[null, T8]])
    expect(q('[data-cs-summary]', c)).toBeNull()
    expect(q('[data-cs-stage-text]', c)!.style.whiteSpace).toBe('pre-wrap')
  })

  it('a long script: many stages, a long title and a word with no spaces all stay inside the card', async () => {
    const stages = Array.from({ length: 10 }, (_, i) => ({ name: `Stage number ${i + 1}`, text: `Hi {{first_name}} {{a_very_long_blank_with_no_spaces_in_it_${'x'.repeat(60)}}} `.repeat(4).trim() }))
    const title = 'Returning client who has not booked in over a year and is unsure what they need this time around'
    templates = [own('o9', title, serializeCallScript({ when: 'When a past client calls back after a long gap', mins: 12, stages }))]
    await mount()
    const c = await openCard(title)
    expect(stagesOf(c).length).toBe(10)
    expect(stagesOf(c)[9]).toEqual(['Stage number 10', stages[9].text])
    expect(q('[data-cs-title]', c)!.style.overflowWrap).toBe('anywhere')
    expect((q('[data-cs-stage-text]', c)!.parentElement as HTMLElement).style.overflowWrap).toBe('anywhere')
    expect(q('[data-cs-summary]', c)!.textContent).toBe('When a past client calls back after a long gap · ~12 min')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · {{BRACES}} ARE NOT MERGE TAGS
// ═══════════════════════════════════════════════════════════════════════════
describe('{{braces}} are shown as written and never filled in', () => {
  it('every blank in every script is on the page exactly as it is in the script', async () => {
    await mount()
    for (const e of EXPORT) {
      const text = (await openCard(e.title)).textContent || ''
      for (const blank of e.lines.flatMap(([, t]) => t.match(/\{\{[a-z_]+\}\}/g) || [])) expect(text, `${e.title} ${blank}`).toContain(blank)
    }
    // even the two that share a name with a real merge tag
    const first = await openCard('New lead callback')
    expect(first.textContent).toContain('Hi {{first_name}}, this is {{owner_name}} with Bee Organized')
    expect(first.textContent).not.toContain('Riley')       // the owner's real name is known to Settings and is NOT put in
    expect(first.textContent).not.toMatch(/Hi (Sarah|Jane|there),/)
  })

  it('the sentence that says who fills them in is on the list and in the editor', async () => {
    await mount()
    expect(q('[data-cs-braces]')!.textContent).toBe('Words in {{braces}} are filled in by you on the call.')
    await click(q('[data-cs-new]'))
    expect(editor().textContent).toContain('Words in {{braces}} are filled in by you on the call. Bee Hub never fills them in and never sends a script to anyone.')
  })

  it('nothing on the page can reach the merge-tag code or the sample-values preview', () => {
    expect(PAGE_CODE).not.toMatch(/preview-vars|buildPreviewVars|RenderedTemplatePreview|TemplatePreviewModal|merge-tags|mergeTags|renderTemplate|substitut|\.replace\(\s*\/\\?\{/i)
    expect(LIB_CODE).not.toMatch(/preview-vars|buildPreviewVars|merge|\\\{\\\{|\{\{/)
    expect(PAGE_CODE.match(/^import .*$/gm)!.map(l => l.replace(/.* from /, ''))).toEqual(["'react'", "'@/components/design/tokens'", "'@/components/ui/icons'", "'@/components/settings/SettingsShell'", "'@/lib/call-script'"])
    // …and Settings no longer mounts the pop-up that previewed a script with a sample client's details
    const settings = HUB.slice(HUB.indexOf('export function SettingsScreen('), HUB.indexOf('function TextsComingSoon') > HUB.indexOf('export function SettingsScreen(') ? HUB.indexOf('function TextsComingSoon') : HUB.indexOf('export function SettingsScreen(') + 400000)
    expect(settings).not.toMatch(/<TemplatePreviewModal|setPreviewTemplate|<TemplateEditorPopup|setEditingTemplate/)
  })

  it('opening the page asks the server for the list and nothing else', async () => {
    await mount()
    for (const e of EXPORT) await openCard(e.title)
    expect(calls.filter(c => c.url.startsWith('/api/templates')).map(c => `${c.method} ${c.url}`)).toEqual(['GET /api/templates'])
    expect(writes()).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · WHAT AN OWNER CAN DO
// ═══════════════════════════════════════════════════════════════════════════
describe('an owner can still write, change and delete their own', () => {
  it('WRITE: New script opens a blank editor; saving posts one call script for this location', async () => {
    await mount()
    await click(q('[data-cs-new]'))
    expect(field('name').value).toBe('')
    expect(field('stage-name').value).toBe('Open')
    expect((q('[data-cs-save]') as HTMLButtonElement).disabled).toBe(true)        // nothing written yet
    await type(field('name'), '  Referral thank-you  ')
    await type(field('when'), 'The day a referral books')
    await type(field('mins'), '3')
    await type(field('stage-text'), 'Hi {{first_name}}, thank you for sending {{friend}} our way.')
    await click(q('[data-cs-add-stage]'))
    expect(field('stage-name', 1).value).toBe('Discover')                         // the next name nobody has used
    await type(field('stage-name', 1), 'Close')
    await type(field('stage-text', 1), 'Can I send you a small thank-you?')
    calls = []
    await click(q('[data-cs-save]'))
    expect(writes().map(c => `${c.method} ${c.url}`)).toEqual(['POST /api/templates'])
    expect(writes()[0].body).toEqual({
      name: 'Referral thank-you', type: 'call', subject: null, tag: 'custom', location_uuid: LOC,
      body: 'When to use: The day a referral books\nAbout: 3 min\n\n## Open\nHi {{first_name}}, thank you for sending {{friend}} our way.\n\n## Close\nCan I send you a small thank-you?',
    })
    // the editor is gone and the new script is in the list, open, marked Yours
    expect(q('[data-cs-editor]')).toBeNull()
    const c = cardOf('Referral thank-you')
    expect(isOpen(c)).toBe(true)
    expect(q('[data-cs-pill]', c)!.textContent).toBe('Yours')
    expect(stagesOf(c)).toEqual([['Open', 'Hi {{first_name}}, thank you for sending {{friend}} our way.'], ['Close', 'Can I send you a small thank-you?']])
    expect(q('[data-cs-count]')!.textContent).toBe('6 scripts')
    expect(alerts).toEqual([])
  })

  it('WRITE: a title and at least one stage with words are needed; minutes must be a sensible number', async () => {
    await mount()
    await click(q('[data-cs-new]'))
    const save = () => q('[data-cs-save]') as HTMLButtonElement
    await type(field('name'), 'Only a title')
    expect(save().disabled).toBe(true)
    await type(field('stage-text'), 'Hello.')
    expect(save().disabled).toBe(false)
    await type(field('mins'), 'soon')
    expect(save().disabled).toBe(true)
    expect(q('[data-cs-mins-error]')!.textContent).toBe('A whole number from 1 to 120, or leave it empty.')
    await type(field('mins'), '')
    expect(save().disabled).toBe(false)
    await type(field('name'), '   ')
    expect(save().disabled).toBe(true)
    calls = []
    await click(save())
    expect(writes()).toEqual([])
  })

  it('WRITE: Cancel writes nothing and leaves the list as it was', async () => {
    await mount()
    await click(q('[data-cs-new]'))
    await type(field('name'), 'Never saved')
    calls = []
    await click(q('[data-cs-cancel]'))
    expect(q('[data-cs-editor]')).toBeNull()
    expect(writes()).toEqual([])
    expect(titles().length).toBe(5)
  })

  it('CHANGE: Edit opens the script’s own words; saving sends one PATCH to that script', async () => {
    templates = [...MASTERS, own('o1', 'My callback', MASTERS[0].body)]
    await mount()
    await click(q('[data-cs-edit]', await openCard('My callback')))
    expect(field('name').value).toBe('My callback')
    expect(field('when').value).toBe('Within 5 minutes of a website lead')
    expect(field('mins').value).toBe('4')
    expect(all('[data-cs-field="stage-name"]', editor()).map(i => (i as HTMLInputElement).value)).toEqual(['Open', 'Discover', 'Value', 'Close'])
    expect(field('stage-text', 3).value).toBe(EXPORT[0].lines[3][1])
    await type(field('stage-text', 3), 'I have Monday at 9 — does that work?')
    // remove the third stage
    await click(all('[data-cs-remove-stage]', editor())[2])
    expect(all('[data-cs-field="stage-name"]', editor()).map(i => (i as HTMLInputElement).value)).toEqual(['Open', 'Discover', 'Close'])
    calls = []
    await click(q('[data-cs-save]'))
    expect(writes().map(c => `${c.method} ${c.url}`)).toEqual(['PATCH /api/templates/o1'])
    expect(writes()[0].body).toEqual({
      name: 'My callback', type: 'call', subject: null,
      body: `When to use: Within 5 minutes of a website lead\nAbout: 4 min\n\n## Open\n${EXPORT[0].lines[0][1]}\n\n## Discover\n${EXPORT[0].lines[1][1]}\n\n## Close\nI have Monday at 9 — does that work?`,
    })
    expect(stagesOf(cardOf('My callback')).map(s => s[0])).toEqual(['Open', 'Discover', 'Close'])
    expect(stagesOf(cardOf('My callback'))[2][1]).toBe('I have Monday at 9 — does that work?')
  })

  it('CHANGE: a plain-words script opens as one stage and saves back the same words', async () => {
    templates = [own('o2', 'Voicemail', T8)]
    await mount()
    await click(q('[data-cs-edit]', await openCard('Voicemail')))
    expect(field('stage-name').value).toBe('')
    expect(field('stage-text').value).toBe(T8)
    calls = []
    await click(q('[data-cs-save]'))
    expect(writes()[0].body.body).toBe(T8)
  })

  it('DELETE: asks first, on the page; "Keep it" deletes nothing', async () => {
    templates = [...MASTERS, own('o1', 'My callback', MASTERS[0].body)]
    await mount()
    const c = await openCard('My callback')
    calls = []
    await click(q('[data-cs-delete]', c))
    expect(q('[data-cs-confirm]', cardOf('My callback'))!.textContent).toContain('Delete “My callback”? It cannot be brought back.')
    expect(writes()).toEqual([])
    await click(q('[data-cs-keep]', cardOf('My callback')))
    expect(q('[data-cs-confirm]', cardOf('My callback'))).toBeNull()
    expect(writes()).toEqual([])
    expect(titles()).toContain('My callback')
    expect(confirms).toBe(0)                      // the browser's own pop-up is not used
  })

  it('DELETE: "Delete script" sends one DELETE and the script leaves the list', async () => {
    templates = [...MASTERS, own('o1', 'My callback', MASTERS[0].body)]
    await mount()
    await click(q('[data-cs-delete]', await openCard('My callback')))
    calls = []
    await click(q('[data-cs-delete-yes]', cardOf('My callback')))
    expect(writes().map(c => `${c.method} ${c.url}`)).toEqual(['DELETE /api/templates/o1'])
    expect(titles()).not.toContain('My callback')
    expect(q('[data-cs-count]')!.textContent).toBe('5 scripts')
  })

  it('a refused save, change or delete says so on the page and changes nothing on screen', async () => {
    templates = [...MASTERS, own('o1', 'My callback', MASTERS[0].body)]
    await mount()
    fail = { POST: { status: 403, body: { error: 'forbidden_read_only' } }, PATCH: { status: 403, body: { error: 'forbidden_wrong_location' } }, DELETE: { status: 409, body: { error: 'template_in_use', detail: 'This script is used somewhere else.' } } }
    await click(q('[data-cs-new]'))
    await type(field('name'), 'Refused'); await type(field('stage-text'), 'Hello.')
    await click(q('[data-cs-save]'))
    expect(q('[data-cs-error]', editor())!.textContent).toBe('Your login cannot change call scripts.')
    expect(q('[data-cs-editor]')).toBeTruthy()             // still open, words still there
    expect(field('name').value).toBe('Refused')
    await click(q('[data-cs-cancel]'))
    expect(titles()).not.toContain('Refused')

    await click(q('[data-cs-edit]', await openCard('My callback')))
    await type(field('name'), 'Renamed')
    await click(q('[data-cs-save]'))
    expect(q('[data-cs-error]', editor())!.textContent).toBe('That script belongs to another location.')
    await click(q('[data-cs-cancel]'))
    expect(titles()).toContain('My callback'); expect(titles()).not.toContain('Renamed')

    await click(q('[data-cs-delete]', await openCard('My callback')))
    await click(q('[data-cs-delete-yes]', cardOf('My callback')))
    expect(q('[data-cs-error]', cardOf('My callback'))!.textContent).toBe('This script is used somewhere else.')
    expect(titles()).toContain('My callback')
    expect(alerts).toEqual([])
  })
})

describe('one of Bee Organized’s can be copied, never changed or deleted by an owner', () => {
  it('its only button is "Make my own copy"', async () => {
    await mount()
    for (const e of EXPORT) {
      const c = await openCard(e.title)
      expect(buttonsOf(c), e.title).toEqual(['Make my own copy'])
      expect(q('[data-cs-edit], [data-cs-delete], [data-cs-edit-master]', c)).toBeNull()
    }
  })

  it('the copy is made on the server for this location, lands in the list as Yours, and opens for editing', async () => {
    await mount()
    calls = []
    await click(q('[data-cs-copy]', await openCard('Quote follow-up')))
    expect(writes().map(c => `${c.method} ${c.url}`)).toEqual(['POST /api/templates/m3/duplicate'])
    expect(writes()[0].body).toEqual({ location_uuid: LOC })
    expect(field('name').value).toBe('Quote follow-up (Copy)')
    expect(all('[data-cs-field="stage-name"]', editor()).map(i => (i as HTMLInputElement).value)).toEqual(['Open', 'Discover', 'Handle', 'Close'])
    await click(q('[data-cs-cancel]'))
    expect(titles()[0]).toBe('Quote follow-up (Copy)')
    expect(q('[data-cs-pill]', cardOf('Quote follow-up (Copy)'))!.textContent).toBe('Yours')
    // Bee Organized's own is still there, untouched
    expect(q('[data-cs-pill]', cardOf('Quote follow-up'))!.textContent).toBe('Bee Organized')
    expect(q('[data-cs-count]')!.textContent).toBe('6 scripts')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · WHO SEES IT
// ═══════════════════════════════════════════════════════════════════════════
describe('who sees the page is who saw it before', () => {
  it('a manager and a read-only login do not get the page or the menu item', async () => {
    for (const franchiseRole of ['manager', 'viewer']) {
      await act(async () => root.unmount()); container.remove()
      container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
      await mount({ franchiseRole })
      expect(page(), franchiseRole).toBeNull()
      expect(container.textContent, franchiseRole).toContain(NO_ACCESS)
      expect(container.querySelector('[data-settings-nav="rail"] [data-section="scripts"]'), franchiseRole).toBeNull()
      expect(container.textContent, franchiseRole).not.toContain('New lead callback')
    }
  })

  it('the menu item is where it was, for an owner, under the same gate', async () => {
    await mount()
    const item = container.querySelector('[data-settings-nav="rail"] [data-section="scripts"]')!
    expect(item.textContent).toBe('Call scripts')
    expect(item.getAttribute('aria-current')).toBe('page')
    expect(HUB).toContain("{ key:'scripts', label:'Call scripts',   icon:'📞' },")
    expect(HUB).toContain("{ title:'Client messages', items: ownerConfig ? [")
  })

  it('an old "texts" link still lands here', async () => {
    await mount({ initialSection: 'texts' })
    expect(page()).toBeTruthy()
    expect(titles().length).toBe(5)
  })

  it('a super admin, as themselves, may also change one of Bee Organized’s — and is told it is for everyone', async () => {
    await mount({ isSuperAdmin: true, appRole: 'super_admin' })
    const c = await openCard('Quote follow-up')
    expect(buttonsOf(c)).toEqual(['Make my own copy', 'Edit for every location'])
    await click(q('[data-cs-edit-master]', c))
    expect(q('[data-cs-master-warning]', editor())!.textContent).toBe('This is one of Bee Organized’s scripts. A change here changes it for every location.')
    await type(field('when'), '2 days after sending an estimate')
    calls = []
    await click(q('[data-cs-save]'))
    expect(writes().map(c => `${c.method} ${c.url}`)).toEqual(['PATCH /api/templates/m3'])
    expect(q('[data-cs-summary]', cardOf('Quote follow-up'))!.textContent).toBe('2 days after sending an estimate · ~2 min')
  })

  it('an owner never gets that button, and neither does a super admin viewing as someone else', async () => {
    await mount({ isSuperAdmin: false, appRole: 'super_admin' })
    expect(buttonsOf(await openCard('Quote follow-up'))).toEqual(['Make my own copy'])
  })

  it('corporate is handed every location’s scripts and sees only the location they are looking at', async () => {
    // What the server gives corporate: nothing flagged as "own", every location's rows.
    templates = [...MASTERS, own('o1', 'Seattle’s own', '## Open\nHi', { is_own_custom: false }), ...NEVER_SHOWN]
    await mount({ appRole: 'corporate' })
    expect(titles()[0]).toBe('Seattle’s own')
    expect(q('[data-cs-pill]', cardOf('Seattle’s own'))!.textContent).toBe('Yours')
    expect(page().textContent).not.toContain('Another location’s script')
    expect(buttonsOf(await openCard('Seattle’s own'))).toEqual(['Edit', 'Delete'])
  })

  it('corporate with no location chosen can read Bee Organized’s but has nowhere to write one', async () => {
    templates = [...MASTERS, own('o1', 'Seattle’s own', '## Open\nHi', { is_own_custom: false })]
    await mount({ appRole: 'corporate' }, null)
    expect(titles().length).toBe(5)
    expect(q('[data-cs-new]')).toBeNull()
    expect(buttonsOf(await openCard('Quote follow-up'))).toEqual([])
    expect(page().textContent).not.toContain('Seattle’s own')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE NEW LOOK, AND WHAT WAS TAKEN OUT
// ═══════════════════════════════════════════════════════════════════════════
describe('the page is in the new look and brought nothing with it', () => {
  it('it sits inside the Settings page frame, on the new page colour', async () => {
    await mount()
    expect(page().closest('[data-settings-page]')).toBeTruthy()
    expect(page().closest('[data-settings-ui]')).toBeTruthy()
    expect(Shell.REBUILT_SECTIONS).toContain('scripts')
  })

  it('its own styling cannot match anything outside the page', () => {
    const selectors = Array.from(CALL_SCRIPTS_CSS.matchAll(/([^{}@]+)\{/g)).map(m => m[1].trim()).filter(s => s && !s.startsWith('(') && !s.startsWith('media'))
    expect(selectors.length).toBeGreaterThan(5)
    for (const s of selectors) expect(s.startsWith('[data-call-scripts] '), s).toBe(true)
  })

  it('every button’s words set their own size, so the app-wide 16px button rule cannot swell them', async () => {
    await mount()
    for (const b of all('button')) {
      const texts = Array.from(b.querySelectorAll('span')).filter(s => s.children.length === 0 && (s.textContent || '').trim())
      expect(texts.length, b.textContent || '').toBeGreaterThan(0)
      for (const s of texts) expect((s as HTMLElement).style.fontSize, s.textContent || '').toMatch(/^\d+px$/)
      expect(Array.from(b.childNodes).every(n => n.nodeType === 1), b.textContent || '').toBe(true)
    }
  })

  it('no new dependency: no icon package, no class-name styling', () => {
    expect(PAGE_CODE).not.toMatch(/lucide|radix|tailwind|className=/)
    const pkg = JSON.parse(read('package.json'))
    const before = JSON.parse(execSync('git show HEAD:package.json', { cwd: process.cwd() }).toString())
    expect(pkg.dependencies).toEqual(before.dependencies)
    expect(pkg.devDependencies).toEqual(before.devDependencies)
  })

  it('the old list, its pop-up editor and its sample-values preview are gone from Settings, not left unused', () => {
    for (const gone of ['renderTemplateTypeSections', 'TEMPLATE_TYPE_SECTIONS', 'tplTypeExpanded', 'function duplicateMasterTemplate(', 'async function saveTemplate(', 'async function deleteTemplate(', 'Call scripts are notes for you']) expect(HUB, gone).not.toContain(gone)
    // the two pop-ups still exist for the screens that still use them (Admin › Content)
    expect(HUB).toContain('function TemplateEditorPopup(')
    expect(HUB).toContain('function TemplatePreviewModal(')
  })
})
