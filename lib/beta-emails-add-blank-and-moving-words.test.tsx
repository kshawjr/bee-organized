// @vitest-environment happy-dom
//
// TWO THINGS KEVIN HIT ON THE EMAILS SCREEN (2026-11-12).
//
// 1. "+ Add an email here" → "A blank email" could not work. It posted a step
//    with subject '' and no editor in between; the save route refuses exactly
//    that, so the owner got a raw "Could not add it: subject_required". At
//    every location — no ready-made email is offerable, so blank was the only
//    choice. Now blank opens the editor and the step is created from a subject
//    and a message, or not at all.
//
// 2. "Moving clients: Get the same emails as organizing clients" was untrue.
//    Moving clients always get the moving emails; the choice is only whether
//    those take the same rate / booking answers as organizing. Words only —
//    what each option WRITES is pinned here, option by option, to what it
//    wrote before.
//
// Driven on the real Settings screen against a fake server that refuses a
// blank subject the way the real route does.
import { expandAllEmailGroups } from './emails-test-helpers'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const h = vi.hoisted(() => {
  const state = { inserts: [] as { table: string; rows: any }[], templates: [] as any[] }
  const from = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) b[m] = () => b
    b.insert = (rows: any) => {
      state.inserts.push({ table, rows })
      const r: any = { select: () => r, single: () => Promise.resolve({ data: { id: 'new-path', location_uuid: 'loc', path_key: 'k', name: 'n', is_active: true, is_default: false }, error: null }) }
      r.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
      return r
    }
    b.maybeSingle = () => Promise.resolve({ data: { id: 'u1', role: 'owner', location_id: LOC_ID }, error: null })
    b.single = b.maybeSingle
    b.then = (res: any, rej: any) => Promise.resolve({ data: table === 'templates' ? state.templates : [], error: null }).then(res, rej)
    return b
  }
  const LOC_ID = '2b3c4d5e-1111-4222-8333-444455556666'
  return { state, from, LOC_ID }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'auth-1' } }, error: null }) },
    from: (t: string) => h.from(t),
  }),
}))
vi.mock('@/lib/auth', () => ({ isAdmin: (r: string) => r === 'super_admin' || r === 'admin', requireAuth: vi.fn(async () => ({})), getHubUser: vi.fn(async () => ({ role: 'owner', location_id: h.LOC_ID })) }))

import * as BeeHubModule from '@/components/BeeHub'
import { POST as createPathPOST } from '@/app/api/locations/[id]/drip-paths/route'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// BeeHub.jsx is untyped JavaScript: taken as one value so this file adds
// nothing to the project's type-error count.
const { SettingsScreen, newEmailStep, stepSaveProblemInWords, appendedStepPosition, MOVING_CHOICE_WORDS, offerableStartingTemplates } = BeeHubModule as any

const LOC = h.LOC_ID
const selectedLoc = (over: any = {}) => ({
  id: LOC, name: 'Kansas City', address: '1 Main', phone: '(816) 555-0100',
  bookingLink: 'https://cal.example.com/kc', reviewsLink: 'https://g.page/r/kc', ratePerHour: '$95',
  serviceRadius: '25 miles', timezone: 'America/Chicago', assessmentType: 'in-person', smsEnabled: false,
  jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
  sendFromName: 'Bee KC', sendFromEmail: 'kc@x.com', replyToEmail: 'kc@x.com', ...over,
})

const step = (id: string, order: number, days: number, subject: string) =>
  ({ id, step_order: order, delay_days: days, channel: 'email', subject, body: `Body of ${subject}`, master_template_id: null, origin: 'master', is_active: true })
const pathRow = (key: string, word: string) => ({
  id: `path-${key}`, path_key: key, name: key, is_default: true, location_uuid: LOC,
  steps: [step(`${key}-1`, 1, 0, `${word} one`), step(`${key}-2`, 2, 5, `${word} two`), step(`${key}-3`, 3, 30, `${word} three`)],
})
const masterRow = (key: string, word: string) => ({ ...pathRow(key, `Master ${word}`), id: `master-${key}`, location_uuid: null })

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let server: { general: string; move: string | null; paths: any[]; masters: any[] }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  vi.stubGlobal('alert', vi.fn())
  h.state.inserts = []; h.state.templates = []
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

// The save route's own rule, restated: an email step whose subject is blank
// (and has no template behind it) is refused, and NOTHING is written.
const refuses = (steps: any[]) => steps.some(s => s.channel === 'email' && !(typeof s.subject === 'string' && s.subject.trim()) && !s.master_template_id)

const mount = async (opts: { general?: string; move?: string | null; owned?: string[]; failSave?: string | null } = {}) => {
  const general = opts.general ?? 'organizing-b', move = opts.move === undefined ? 'moving-b' : opts.move
  const owned = opts.owned ?? ['organizing-b', 'moving-b']
  server = {
    general, move,
    paths: owned.map(k => pathRow(k, k.startsWith('moving') ? 'Moving' : 'Organizing')),
    masters: ['a', 'b', 'c', 'd'].flatMap(l => [masterRow(`organizing-${l}`, 'organizing'), masterRow(`moving-${l}`, 'moving')]),
  }
  fetchMock = vi.fn(async (url: string, o?: any) => {
    const u = String(url)
    const ok = (j: any) => ({ ok: true, status: 200, json: async () => j })
    if (u === `/api/locations/${LOC}/drip-paths` && o?.method === 'PATCH') {
      const b = JSON.parse(o.body)
      if (b.default) server.general = b.default
      if (b.default_move) server.move = b.default_move
      return ok({ ok: true })
    }
    if (u === `/api/locations/${LOC}/drip-paths`) return ok({ paths: server.paths, default_drip_path: server.general, default_move_drip_path: server.move })
    if (u === '/api/drip-paths/masters') return ok({ masters: server.masters })
    if (u === `/api/locations/${LOC}/drip-paths/clone` && o?.method === 'POST') {
      const m = server.masters.find(x => x.id === JSON.parse(o.body).master_id)
      // Idempotent, like the real clone route (commitSteps leans on that).
      const had = server.paths.find(x => x.path_key === m.path_key)
      if (had) return ok({ path: had })
      const copy = { ...m, id: `path-${m.path_key}`, location_uuid: LOC, steps: m.steps.map((s: any) => ({ ...s, id: `c-${s.id}` })) }
      server.paths.push(copy)
      return ok({ path: copy })
    }
    const m = u.match(/^\/api\/drip-paths\/([^/]+)\/steps$/)
    if (m && o?.method === 'PATCH') {
      const steps = JSON.parse(o.body).steps
      if (opts.failSave) return { ok: false, status: 400, json: async () => ({ error: opts.failSave }) }
      if (refuses(steps)) return { ok: false, status: 400, json: async () => ({ error: 'subject_required' }) }
      const p = server.paths.find(x => x.id === m[1])
      p.steps = steps.map((s: any, i: number) => ({ ...s, id: `saved-${i + 1}` }))
      return ok({ ok: true })
    }
    if (/active-lead-count$/.test(u)) return ok({ count: 0 })
    return ok({})
  })
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => { root.render(<SettingsScreen selectedLoc={selectedLoc()} initialSection="emails" />) })
  for (let i = 0; i < 4; i++) await act(async () => {})
  await expandAllEmailGroups(container, act as any)
}

const writes = (re: RegExp, method: string) => fetchMock.mock.calls
  .filter(([u, o]: any[]) => re.test(String(u)) && o?.method === method)
  .map(([u, o]: any[]) => ({ url: String(u), body: JSON.parse(o.body) }))
const stepSaves = () => writes(/^\/api\/drip-paths\/[^/]+\/steps$/, 'PATCH')
const clones = () => writes(/\/drip-paths\/clone$/, 'POST')
const variantWrites = () => writes(new RegExp(`^/api/locations/${LOC}/drip-paths$`), 'PATCH').map(w => w.body)
const fingerprint = (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
const sequences = () => fingerprint(server.paths.map(p => [p.id, p.steps]))

const click = async (el: Element | undefined | null) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => { (el as HTMLElement).click() })
  for (let i = 0; i < 3; i++) await act(async () => {})
}
const button = (label: string) => Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === label) as HTMLElement | undefined
const dialog = (label: string) => document.querySelector(`[role="dialog"][aria-label="${label}"]`) as HTMLElement | null
const type = async (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const openBlankEditor = async () => {
  await click(button('+ Add an email here'))
  expect(dialog('Add another email')).toBeTruthy()
  await click(button('Write this email'))
  const ed = dialog('Write your new email')!
  expect(ed).toBeTruthy()
  return { ed, subject: ed.querySelector('input[type="text"]') as HTMLInputElement, body: ed.querySelector('textarea') as HTMLTextAreaElement }
}
const screenText = () => document.body.textContent ?? ''

// ═════════════════════════════ 1. Add a blank email ═════════════════════════

describe('a blank email can be added, with a subject and a message, and it saves', () => {
  it('blank opens the editor; nothing is saved by the dialog itself', async () => {
    await mount()
    const before = sequences()
    await openBlankEditor()
    expect(dialog('Add another email')).toBeNull()             // the editor replaced it
    expect(stepSaves()).toEqual([])
    expect(clones()).toEqual([])
    expect(sequences()).toBe(before)
  })

  it('written and saved: ONE save, the new email last, on its day, marked as added, with the owner’s words', async () => {
    await mount()
    const { subject, body } = await openBlankEditor()
    await type(subject, '  Still thinking it over?  ')
    await type(body, 'Hi {{first_name}}, no rush at all.')
    await click(button('Add this email'))
    expect(stepSaves().length).toBe(1)
    const sent = stepSaves()[0]
    expect(sent.url).toBe('/api/drip-paths/path-organizing-b/steps')
    expect(sent.body.steps.map((s: any) => s.subject)).toEqual(['Organizing one', 'Organizing two', 'Organizing three', 'Still thinking it over?'])
    expect(sent.body.steps[3]).toMatchObject({ step_order: 4, delay_days: 44, channel: 'email', subject: 'Still thinking it over?', body: 'Hi {{first_name}}, no rush at all.', origin: 'added', master_template_id: null, is_active: true })
    // the three that were there are sent back exactly as they were
    expect(sent.body.steps.slice(0, 3).map((s: any) => [s.step_order, s.delay_days, s.subject, s.body, s.origin])).toEqual(
      pathRow('organizing-b', 'Organizing').steps.map(s => [s.step_order, s.delay_days, s.subject, s.body, s.origin]))
    expect(dialog('Write your new email')).toBeNull()           // closed: it saved
    expect(server.paths[0].steps.length).toBe(4)
    expect(screenText()).not.toContain('Could not add it')
  })

  it('the new-email editor offers no delay field — its day is fixed by where it lands', async () => {
    await mount()
    const { ed } = await openBlankEditor()
    expect(ed.querySelector('input[type="number"]')).toBeNull()
    expect(ed.textContent).not.toContain('Delay (days')
    expect(ed.querySelector('[data-new-email-note]')!.textContent).toContain('Cancel and nothing is added')
  })
})

describe('a step with an empty subject can never be created', () => {
  for (const [what, subj, msg, says] of [
    ['nothing typed at all', '', '', 'The email body can’t be empty.'],
    ['a message but no subject', '', 'Hello there', 'The email subject can’t be empty.'],
    ['a subject of spaces', '   ', 'Hello there', 'The email subject can’t be empty.'],
    ['a subject but no message', 'Hello', '   ', 'The email body can’t be empty.'],
  ] as const) {
    it(`the editor: ${what} → refused in words, nothing sent, the editor stays open`, async () => {
      await mount()
      const before = sequences()
      const { ed, subject, body } = await openBlankEditor()
      if (subj) await type(subject, subj)
      if (msg) await type(body, msg)
      await click(button('Add this email'))
      expect(stepSaves()).toEqual([])
      expect(sequences()).toBe(before)
      expect(dialog('Write your new email')).toBeTruthy()
      expect(ed.textContent).toContain(says)
    })
  }

  it('the one place a new step is built THROWS rather than build one without a subject or a message', () => {
    const steps = [{ order: 1, delay_days: 0 }, { order: 2, delay_days: 5 }]
    for (const draft of [null, undefined, {}, { subject: '', body: 'x' }, { subject: '   ', body: 'x' }, { subject: null, body: 'x' }, { subject: 5, body: 'x' }, { body: 'x' }]) {
      expect(() => newEmailStep(steps, null, draft as any), JSON.stringify(draft)).toThrow('The email subject can’t be empty.')
    }
    for (const draft of [{ subject: 'Hi' }, { subject: 'Hi', body: '' }, { subject: 'Hi', body: ' \n ' }]) {
      expect(() => newEmailStep(steps, null, draft as any), JSON.stringify(draft)).toThrow('The email body can’t be empty.')
    }
    expect(newEmailStep(steps, null, { subject: ' Hi ', body: 'There' }, 7)).toEqual({
      id: 'new_7', order: 3, type: 'email', delay: '19 days later', delay_days: 19, origin: 'added',
      templateId: null, masterTemplateId: null, subject: 'Hi', body: 'There', name: 'Hi',
    })
    // a ready-made one is still a live link, with no text of its own
    expect(newEmailStep(steps, { dbId: 't1', legacyId: 'nudge', name: 'Nudge' }, null, 7)).toMatchObject({ masterTemplateId: 't1', templateId: 'nudge', subject: null, body: null, order: 3 })
    expect(appendedStepPosition(steps)).toMatchObject({ order: 3, delay_days: 19 })
  })

  it('no source line anywhere builds an added step with an empty subject', () => {
    const src = readFileSync(join(__dirname, '..', 'components/BeeHub.jsx'), 'utf8')
    expect(src).not.toMatch(/subject:\s*template\s*\?\s*null\s*:\s*''/)
    expect(src.split("origin: 'added'").length - 1).toBe(1)   // newEmailStep's, and only it
    expect(src.split('newEmailStep(').length - 1).toBe(2)       // its definition + appendEmailStep
  })

  // The server, by every route that can write a step.
  describe('…and the server refuses one by every route that writes steps', () => {
    const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8')
    const post = (steps: any[]) => createPathPOST(
      new Request(`http://x/api/locations/${LOC}/drip-paths`, { method: 'POST', body: JSON.stringify({ path_key: 'organizing-z', name: 'Z', steps }) }) as any,
      { params: { id: LOC } },
    )
    it('creating a path with seed steps: a blank, spaces-only or missing subject is refused BEFORE anything is created', async () => {
      for (const s of [{ subject: '', body: 'x' }, { subject: '   ', body: 'x' }, { body: 'x' }, { subject: null, body: 'x' }, { subject: '', master_template_id: 'tpl-1', body: 'x' }]) {
        h.state.inserts = []; h.state.templates = [{ id: 'tpl-1', subject: 'From the template' }]
        const res = await post([{ step_order: 1, subject: 'Fine', body: 'x' }, { step_order: 2, ...s }])
        expect(res.status, JSON.stringify(s)).toBe(400)
        expect(await res.json()).toEqual({ error: 'subject_required', step_order: 2 })
        expect(h.state.inserts, 'no path row, no step rows').toEqual([])
      }
    })
    it('…a template with no subject behind it is refused too; one WITH a subject, and a text step, are let through', async () => {
      h.state.templates = [{ id: 'tpl-1', subject: '  ' }]
      expect((await post([{ master_template_id: 'tpl-1' }])).status).toBe(400)
      expect(h.state.inserts).toEqual([])
      h.state.templates = [{ id: 'tpl-1', subject: 'From the template' }]
      const res = await post([{ subject: 'Mine', body: 'x' }, { master_template_id: 'tpl-1' }, { channel: 'sms', body: 'a text' }])
      expect(res.status).toBe(201)
      expect(h.state.inserts.map(i => i.table)).toEqual(['drip_paths', 'drip_path_steps'])
    })
    it('the two step routes still carry their own refusal, before they write', () => {
      const bulk = read('app/api/drip-paths/[id]/steps/route.ts')
      expect(bulk.indexOf("error: 'subject_required'")).toBeGreaterThan(-1)
      expect(bulk.indexOf("error: 'subject_required'")).toBeLessThan(bulk.indexOf(".delete()"))
      const one = read('app/api/drip-path-steps/[stepId]/route.ts')
      expect(one.indexOf("error: 'subject_required'")).toBeGreaterThan(-1)
      expect(one.indexOf("error: 'subject_required'")).toBeLessThan(one.lastIndexOf(".update("))
    })
    it('those three are the only places step rows are inserted or updated (the clone copies a master’s, which pass the same rule)', () => {
      const { execSync } = require('node:child_process')
      let files: string[]
      try { files = execSync('grep -rlE "from\\(.drip_path_steps.\\)" app lib', { cwd: join(__dirname, '..'), encoding: 'utf8' }).split('\n').filter(Boolean) }
      catch { files = [] }
      const writers = files.filter(f => !/\.test\./.test(f)).filter(f => {
        const src = read(f)
        return /from\('drip_path_steps'\)\s*(\n\s*)?\.(insert|update|upsert)\(/.test(src)
      }).sort()
      expect(writers).toEqual([
        'app/api/drip-path-steps/[stepId]/route.ts',
        'app/api/drip-paths/[id]/steps/route.ts',
        'app/api/locations/[id]/drip-paths/clone/route.ts',
        'app/api/locations/[id]/drip-paths/route.ts',
      ])
    })
  })
})

describe('subject_required never reaches a human', () => {
  const codes = () => {
    const out = new Set<string>()
    for (const f of ['app/api/drip-paths/[id]/steps/route.ts', 'app/api/drip-path-steps/[stepId]/route.ts', 'app/api/locations/[id]/drip-paths/clone/route.ts', 'app/api/locations/[id]/drip-paths/route.ts']) {
      for (const m of Array.from(readFileSync(join(__dirname, '..', f), 'utf8').matchAll(/error: '([a-z0-9_]+)'/g))) out.add(m[1])
    }
    return Array.from(out)
  }
  it('every code the step routes can answer with becomes a sentence — no code, no bare HTTP status', () => {
    const all = [...codes(), 'HTTP 500', 'HTTP 400', '', 'some_new_code_nobody_mapped']
    expect(all).toContain('subject_required')
    expect(all.length).toBeGreaterThan(15)
    for (const c of all) {
      const words = stepSaveProblemInWords(new Error(c))
      expect(words, c).not.toMatch(/[a-z0-9]_[a-z0-9]/)
      expect(words, c).not.toMatch(/HTTP \d/)
      expect(words, c).toMatch(/ /)
    }
    expect(stepSaveProblemInWords('subject_required')).toBe('one of these emails has no subject line. Give it a subject and save again.')
    // a sentence is left as it is
    expect(stepSaveProblemInWords(new Error('The email subject can’t be empty.'))).toBe('The email subject can’t be empty.')
  })

  for (const code of ['subject_required', 'insert_failed', 'forbidden_read_only']) {
    it(`the server answers ${code}: the editor says so in words, keeps what was typed, and the sequence is as it was`, async () => {
      await mount({ failSave: code })
      const before = sequences()
      const { ed, subject, body } = await openBlankEditor()
      await type(subject, 'Hello again')
      await type(body, 'A message')
      await click(button('Add this email'))
      expect(stepSaves().length).toBe(1)
      expect(screenText()).not.toContain(code)
      expect(screenText()).not.toMatch(/[a-z]+_required|HTTP \d/)
      expect(ed.textContent).toContain('Could not add it: ')
      expect(dialog('Write your new email')).toBeTruthy()
      expect((dialog('Write your new email')!.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('Hello again')
      expect(sequences()).toBe(before)
      // …and the list shows the three it had, not a fourth painted on
      await click(button('Cancel'))
      expect(screenText()).not.toContain('Hello again')
    })
  }

  it('the old dialog line cannot show a code either', () => {
    const src = readFileSync(join(__dirname, '..', 'components/BeeHub.jsx'), 'utf8')
    expect(src).not.toContain("'Could not add it: ' + (e?.message || e)")
    expect(src.split("'Could not add it: ' + stepSaveProblemInWords(e)").length - 1).toBe(2)
  })
})

describe('abandoning the new-email editor leaves the sequence exactly as it was', () => {
  it('Cancel after typing: no save, no copy made, nothing added — and the next one starts empty', async () => {
    await mount()
    const before = sequences()
    const { subject, body } = await openBlankEditor()
    await type(subject, 'Half an idea')
    await type(body, 'Half a message')
    await click(button('Cancel'))
    expect(dialog('Write your new email')).toBeNull()
    expect(stepSaves()).toEqual([])
    expect(clones()).toEqual([])
    expect(sequences()).toBe(before)
    expect(screenText()).not.toContain('Half an idea')
    const again = await openBlankEditor()
    expect(again.subject.value).toBe('')
    expect(again.body.value).toBe('')
  })

  it('Escape does the same', async () => {
    await mount()
    const before = sequences()
    const { subject } = await openBlankEditor()
    await type(subject, 'Half an idea')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(dialog('Write your new email')).toBeNull()
    expect(stepSaves()).toEqual([])
    expect(sequences()).toBe(before)
  })

  it('a location still on the Bee Organized version: writing makes NO copy; only saving does, and backing out of the copy adds nothing', async () => {
    await mount({ owned: [] })
    const before = sequences()
    const { subject, body } = await openBlankEditor()
    await type(subject, 'Our own extra email')
    await type(body, 'Hello')
    expect(clones()).toEqual([])                                // typing forked nothing
    await click(button('Add this email'))
    expect(screenText()).toContain('Customize these emails for your location?')
    expect(clones()).toEqual([])
    await click(Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'Cancel').pop())   // the copy question's Cancel, not the editor's
    expect(clones()).toEqual([])
    expect(stepSaves()).toEqual([])
    expect(sequences()).toBe(before)
    // not left "Adding…" for ever: the editor is usable and says what happened
    const ed = dialog('Write your new email')!
    expect(ed.textContent).toContain('Nothing was added')
    expect(button('Add this email')!.hasAttribute('disabled')).toBe(false)
    // …and going through with it makes the copy, then ONE save with all four
    await click(button('Add this email'))
    await click(button('Create my copy & edit'))
    expect(clones().length).toBeGreaterThanOrEqual(1)
    expect(server.paths.filter(p => p.path_key === 'organizing-b').length).toBe(1)   // one copy
    expect(stepSaves().length).toBe(1)
    expect(stepSaves()[0].body.steps.map((s: any) => s.subject)).toEqual(['Master organizing one', 'Master organizing two', 'Master organizing three', 'Our own extra email'])
  })
})

describe('reported, not changed here: nothing ready-made is offerable', () => {
  it('the seven live master email templates are all on the exclusion list, so the dialog offers blank only', async () => {
    const live = ['welcome', 'opp_closed_job_3mo', 'opp_closed_job_12mo', 'opp_organizing_estimate_3d', 'opp_organizing_estimate_30d', 'opp_moving_estimate_3d', 'opp_moving_estimate_30d']
      .map((legacyId, i) => ({ dbId: `t${i}`, legacyId, isMaster: true, isActive: true, type: 'email', name: legacyId }))
    expect(offerableStartingTemplates(live)).toEqual([])
  })
})

// ═════════════════════════════ 2. The Moving words ══════════════════════════

const radios = () => Array.from(container.querySelectorAll('[data-moving-choice] [role="radio"]')) as HTMLElement[]
const tabs = () => Array.from(container.querySelectorAll('[data-email-view] [role="tab"]')) as HTMLElement[]

describe('the Moving choice says what it does', () => {
  it('neither option, nor anything in the box, says moving clients get the same emails', async () => {
    await mount()
    const box = container.querySelector('[data-moving-choice]') as HTMLElement
    expect(radios().map(r => r.textContent)).toEqual(['Yes, the same way as organizing', 'No, set them separately'])
    expect(box.textContent).toContain('Should the moving emails handle your hourly rate and booking the same way as your organizing emails?')
    expect(box.querySelector('[data-moving-always]')!.textContent).toBe('Moving clients always get their own emails, written for a move. They are never sent the organizing ones. Read or change them under Moving, below.')
    for (const words of Object.values(MOVING_CHOICE_WORDS)) {
      expect(words).not.toMatch(/same emails|same set|their own set of emails|Replace the moving emails/i)
    }
    expect(screenText()).not.toMatch(/Get the same emails as organizing clients|Get their own set of emails/)
  })

  it('what "the same way" means is true: the two letters match, and the moving list is still the moving wording', async () => {
    await mount({ general: 'organizing-b', move: 'moving-b' })
    expect(radios()[0].getAttribute('aria-checked')).toBe('true')
    await click(tabs()[1])
    expect(screenText()).toContain('Moving one')
    expect(screenText()).not.toContain('Organizing one')
  })

  it('the confirm, when it really switches version: says they stay the moving emails, and makes no promise that is false for a location that never changed its wording', async () => {
    await mount({ general: 'organizing-a', move: 'moving-c', owned: [] })
    await click(radios()[0])
    const dlg = container.querySelector('[data-moving-choice] [role="alertdialog"]') as HTMLElement
    expect(dlg.getAttribute('aria-label')).toBe('Switch the moving emails to match organizing?')
    expect(dlg.textContent).toContain('They are still the moving emails, with their own wording — not the organizing ones.')
    expect(dlg.textContent).toContain('Anyone partway through keeps the emails they started on.')
    // conditional, so it is true whether or not they ever edited their moving emails
    expect(dlg.textContent).toContain('If you changed the wording of the moving emails you send today, your changes are saved but won’t be sent while this is on.')
    expect(dlg.textContent).not.toMatch(/same emails as organizing|any wording you changed only in the moving emails is kept/)
  })

  it('when the two already match there is nothing to switch, so no warning is shown — and nothing is written', async () => {
    await mount({ general: 'organizing-b', move: 'moving-b' })
    await click(radios()[1])                                   // "set them separately"
    expect(radios()[1].getAttribute('aria-checked')).toBe('true')
    await click(radios()[0])                                   // back to "the same way"
    expect(container.querySelector('[data-moving-choice] [role="alertdialog"]')).toBeNull()
    expect(radios()[0].getAttribute('aria-checked')).toBe('true')
    expect(variantWrites()).toEqual([])
  })
})

describe('choosing either Moving option changes exactly the paths it changed before', () => {
  // What each click wrote on main at db4e6c7, before a word was changed:
  //   separately              → nothing
  //   the same way, split     → default_move := moving-<organizing's letter>, after the confirm
  //   the same way, not split → nothing
  //   "Keep them separate"    → nothing
  const RUNS: [string, string, string | null, (string | number)[]][] = [
    ['a/a → separately', 'organizing-a', 'moving-a', [1]],
    ['a/a → separately → same', 'organizing-a', 'moving-a', [1, 0]],
    ['b/d → same, confirmed', 'organizing-b', 'moving-d', [0, 'yes']],
    ['a/c → same, kept separate', 'organizing-a', 'moving-c', [0, 'no']],
    ['d/a → same, confirmed', 'organizing-d', 'moving-a', [0, 'yes']],
    ['c/c → same (already)', 'organizing-c', 'moving-c', [0]],
    ['a/c → separately (already)', 'organizing-a', 'moving-c', [1]],
  ]
  const EXPECTED: Record<string, { writes: any[]; general: string; move: string | null }> = {
    'a/a → separately': { writes: [], general: 'organizing-a', move: 'moving-a' },
    'a/a → separately → same': { writes: [], general: 'organizing-a', move: 'moving-a' },
    'b/d → same, confirmed': { writes: [{ default_move: 'moving-b' }], general: 'organizing-b', move: 'moving-b' },
    'a/c → same, kept separate': { writes: [], general: 'organizing-a', move: 'moving-c' },
    'd/a → same, confirmed': { writes: [{ default_move: 'moving-d' }], general: 'organizing-d', move: 'moving-d' },
    'c/c → same (already)': { writes: [], general: 'organizing-c', move: 'moving-c' },
    'a/c → separately (already)': { writes: [], general: 'organizing-a', move: 'moving-c' },
  }
  const results: Record<string, any> = {}
  for (const [name, general, move, clicks] of RUNS) {
    it(name, async () => {
      await mount({ general, move })
      const before = sequences()
      for (const c of clicks) {
        if (c === 'yes') await click(button(MOVING_CHOICE_WORDS.confirmYes))
        else if (c === 'no') await click(button('Keep them separate'))
        else await click(radios()[c as number])
      }
      const got = { writes: variantWrites(), general: server.general, move: server.move }
      results[name] = got
      expect(got).toEqual(EXPECTED[name])
      expect(stepSaves()).toEqual([])                          // no sequence is rewritten
      expect(clones()).toEqual([])                             // no copy is made
      expect(sequences()).toBe(before)                         // not one step moved
    })
  }
  it('…by fingerprint, all seven together', () => {
    expect(Object.keys(results).length).toBe(RUNS.length)
    expect(fingerprint(results)).toBe(fingerprint(EXPECTED))
    expect(fingerprint(EXPECTED)).toBe('ac6f5ec8605ea907')   // taken from main db4e6c7 with this same click script, before the wording changed
  })
})

describe('the Organizing / Moving tabs still show, and still edit, in both modes', () => {
  for (const [mode, general, move] of [['the same way', 'organizing-b', 'moving-b'], ['set separately', 'organizing-a', 'moving-c']] as const) {
    it(`${mode}: both tabs are there, Moving shows the moving wording, and editing it saves to the MOVING path only`, async () => {
      await mount({ general, move, owned: [general, move] })
      expect(radios()[mode === 'the same way' ? 0 : 1].getAttribute('aria-checked')).toBe('true')
      expect(tabs().map(t => t.textContent)).toEqual(['Organizing', 'Moving'])
      expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
      expect(screenText()).toContain('Organizing one')
      await click(tabs()[1])
      await expandAllEmailGroups(container, act as any)
      expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
      expect(screenText()).toContain('Moving one')
      expect(screenText()).not.toContain('Organizing one')
      expect(variantWrites()).toEqual([])                      // looking writes nothing
      // edit the first moving email
      const row = Array.from(container.querySelectorAll('button')).find(b => /^(Edit|Change wording)$/.test((b.textContent ?? '').trim()) || b.getAttribute('aria-label') === 'Change wording') as HTMLElement | undefined
      const opener = row ?? (Array.from(container.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('Moving one')) as HTMLElement)
      await click(opener)
      if (!document.querySelector('[role="dialog"][aria-label^="Edit step"]')) await click(button('Change wording') ?? button('Edit wording') ?? button('Edit'))
      const ed = document.querySelector('[role="dialog"][aria-label^="Edit step"]') as HTMLElement
      expect(ed, 'the step editor opened').toBeTruthy()
      await type(ed.querySelector('input[type="text"]') as HTMLInputElement, 'Moving one, reworded')
      await click(button('Save'))
      expect(stepSaves().map(s => s.url)).toEqual([`/api/drip-paths/path-${move}/steps`])
      expect(stepSaves()[0].body.steps[0].subject).toBe('Moving one, reworded')
      expect(server.paths.find(p => p.path_key === general).steps[0].subject).toBe('Organizing one')
    })
  }
})
