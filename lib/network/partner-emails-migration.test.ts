// Partner emails, slice 2 (2026-11-22): THE MASTER SEQUENCES EXIST, AND A
// LOCATION CAN CUSTOMIZE AND RESET THEM.
//
//   · migrations/partner_emails.sql is one transaction, refuses to run twice,
//     and inserts exactly the two masters and three steps, each named
//   · each body is Kevin's text exactly (lib/network/__fixtures__/
//     partner-emails-copy.md, his words with the copy file's line wraps
//     joined), {{partner_name}} first and {{signature}} last, plain format
//   · the subjects are exactly the three Kevin approved (2026-11-22)
//   · the keys and names agree with lib/partner-sequences.ts
//   · "Customize" (the clone route) and "Reset to master" (the reset route)
//     accept a partner master exactly like a client one, with no list of
//     allowed keys to fall foul of; the database's refusal to reset while a
//     partner is active reaches the owner as the route's existing error
//
// The rules the migration adds are proven on a running copy of the database
// by the dry run (131 checks, 19 deliberate breaks); this file pins the text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PARTNER_SEQUENCES, PARTNER_PATH_KEYS, isPartnerPathKey } from '../partner-sequences'

const ROOT = process.cwd()
const MIG = readFileSync(join(ROOT, 'migrations/partner_emails.sql'), 'utf8')
const UNDO = readFileSync(join(ROOT, 'migrations/partner_emails_undo.sql'), 'utf8')
const COPY = readFileSync(join(ROOT, 'lib/network/__fixtures__/partner-emails-copy.md'), 'utf8')
const code = (sql: string) => sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')

// Kevin's text: his paragraphs, list items and closing line as he wrote them;
// only the copy file's line wraps inside a paragraph or list item are joined.
function kevinBody(email: '500' | '501' | '502'): string {
  const part = COPY.split(/^## /m).find(p => p.startsWith(`Email ${email}`))!
  return part.split('\n').slice(1).join('\n').trim().split(/\n{2,}/).map(p => {
    const lines = p.split('\n')
    if (lines[0].startsWith('- ')) {
      const items: string[] = []
      for (const l of lines) l.startsWith('- ') ? items.push(l) : (items[items.length - 1] += ' ' + l.trim())
      return items.join('\n')
    }
    return lines.reduce((acc, l, i) => (i === 0 ? l : l === '{{signature}}' ? `${acc}\n${l}` : `${acc} ${l}`), '')
  }).join('\n\n')
}
const bodyIn = (tag: string) => {
  const m = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`).exec(MIG)
  expect(m, tag).toBeTruthy()
  return m![1]
}
const words = (s: string) => s.split(/\s+/).filter(Boolean)

describe('the migration file', () => {
  it('is one transaction, in both directions', () => {
    for (const sql of [MIG, UNDO]) {
      const c = code(sql).trim()
      expect(c.startsWith('BEGIN;')).toBe(true)
      expect(c.endsWith('COMMIT;')).toBe(true)
      expect(c.match(/\bBEGIN;/g)).toHaveLength(1)
      expect(c.match(/\bCOMMIT;/g)).toHaveLength(1)
    }
  })
  it('refuses to run twice, before changing anything', () => {
    const c = code(MIG)
    const guard = c.indexOf('$guard$'), firstChange = c.search(/\b(CREATE|ALTER|INSERT)\b/)
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstChange)
    expect(c).toMatch(/has already been run/)
  })
  it('inserts exactly two sequences, both masters with no location', () => {
    expect(code(MIG).match(/INSERT INTO public\.drip_paths\b/g)).toHaveLength(1)
    expect(MIG).toContain(`VALUES (NULL, 'partner-introduction',       'Partner introduction',       true, false, true, NULL),
         (NULL, 'partner-power-introduction', 'Power Partner introduction', true, false, true, NULL)`)
  })
  it('and exactly three steps: 500 at the start, 501 three months later, 502 at the start', () => {
    expect(code(MIG).match(/INSERT INTO public\.drip_path_steps\b/g)).toHaveLength(1)
    expect(MIG).toContain(`('partner-introduction', 1, 0, NULL, 'Great to meet you',\n$email500$`)
    expect(MIG).toContain(`('partner-introduction', 2, 90, 'months', 'Thinking of you and your clients',\n$email501$`)
    expect(MIG).toContain(`('partner-power-introduction', 1, 0, NULL, 'Great to meet you',\n$email502$`)
    expect(MIG).toMatch(/SELECT paths\.id, s\.step_order, s\.delay_days, s\.delay_unit, 'email', s\.subject, s\.body, 'plain',\s+NULL, true, false, 'master', NULL, NULL, NULL/)
    expect(MIG).toContain(`) AS s (path_key, step_order, delay_days, delay_unit, subject, body) ON s.path_key = paths.path_key;`)
  })
  it('agrees with lib/partner-sequences.ts', () => {
    expect(PARTNER_SEQUENCES.map(s => [s.pathKey, s.name])).toEqual([
      ['partner-introduction', 'Partner introduction'],
      ['partner-power-introduction', 'Power Partner introduction'],
    ])
    for (const k of PARTNER_PATH_KEYS) expect(isPartnerPathKey(k)).toBe(true)
    for (const k of ['organizing-a', 'moving-d', 'returning-b', '', null, undefined, 'Partner-x']) expect(isPartnerPathKey(k)).toBe(false)
    expect(MIG).toContain(`SELECT coalesce(p_key LIKE 'partner-%', false)`)
  })
})

describe("Kevin's words, exactly", () => {
  for (const [email, tag] of [['500', 'email500'], ['501', 'email501'], ['502', 'email502']] as const) {
    it(`Email ${email} is his text, character for character`, () => {
      expect(bodyIn(tag)).toBe(kevinBody(email))
    })
    it(`Email ${email}: not one word added, dropped or changed`, () => {
      const part = COPY.split(/^## /m).find(p => p.startsWith(`Email ${email}`))!
      expect(words(bodyIn(tag))).toEqual(words(part.split('\n').slice(1).join('\n')))
    })
    it(`Email ${email} opens with {{partner_name}} and closes with {{signature}}`, () => {
      const b = bodyIn(tag)
      expect(b.startsWith('Hi {{partner_name}},\n\n')).toBe(true)
      expect(b.endsWith('Warmly,\n{{signature}}')).toBe(true)
      expect(b.match(/\{\{\w+\}\}/g)).toEqual(['{{partner_name}}', '{{signature}}'])
    })
  }
  it("the subjects are exactly Kevin's three, and nothing says to wait for them any more", () => {
    const subjects = Array.from(MIG.matchAll(/^  \('partner-[a-z-]+', \d, \d+, (?:NULL|'months'), '([^']*)',$/gm)).map(m => m[1])
    expect(subjects).toEqual(['Great to meet you', 'Thinking of you and your clients', 'Great to meet you'])
    expect(MIG).not.toMatch(/SUBJECT NEEDED|DO NOT RUN THIS|none yet/)
  })
})

describe('the rules are in the migration (proven live by the dry run)', () => {
  const c = code(MIG)
  it.each([
    ['only the functions may write an unsubscribe on the contact; a partner\'s own is final', /CREATE TRIGGER trg_partners_unsubscribe_guard\s+BEFORE INSERT OR UPDATE ON public\.partners/],
    ['a new address on an unsubscribed contact is recorded too', /CREATE TRIGGER trg_partners_after_email_change\s+AFTER UPDATE OF email ON public\.partners/],
    ['the history cannot be deleted, forged or changed', /CREATE TRIGGER trg_partner_unsubscribes_guard\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.partner_unsubscribes/],
    ['link keys cannot be deleted or changed', /CREATE TRIGGER trg_partner_unsubscribe_links_guard\s+BEFORE UPDATE OR DELETE ON public\.partner_unsubscribe_links/],
    ['purging a contact keeps the history', /  partner_id       uuid REFERENCES public\.partners\(id\) ON DELETE SET NULL,\n  location_id      uuid REFERENCES public\.locations\(id\) ON DELETE SET NULL,\n  email_normalized text,                 -- the address that is unsubscribed/],
    ['the two kinds, told apart', /CHECK \(unsubscribe_source IS NULL OR unsubscribe_source IN \('link', 'owner'\)\)/],
    ['opening the link only reads (STABLE)', /CREATE FUNCTION public\.partner_unsubscribe_status\(p_token text\)[\s\S]{0,200}LANGUAGE sql STABLE SECURITY DEFINER/],
    ['reversal is for super admins only, and never a partner\'s own', /WHERE h\.id = p_by AND h\.role = 'super_admin'\) THEN[\s\S]*IF v_partner\.unsubscribe_source = 'link' THEN\s+RETURN QUERY SELECT 'partner_unsubscribed_themselves'/],
    ['every active partner row is checked', /CREATE TRIGGER trg_partner_drip_progress_guard\s+BEFORE INSERT OR UPDATE ON public\.partner_drip_progress/],
    ['no reset while a partner is active', /CREATE TRIGGER trg_drip_paths_keep_active_partners\s+BEFORE DELETE ON public\.drip_paths/],
    ['link keys unreadable by the browser roles', /REVOKE ALL ON public\.partner_unsubscribe_links FROM anon, authenticated;/],
    ['history unreadable by the browser roles', /REVOKE ALL ON public\.partner_unsubscribes FROM anon, authenticated;/],
    ['server-only tracking table, like the client drip tables', /ALTER TABLE public\.partner_drip_progress ENABLE ROW LEVEL SECURITY;/],
  ])('%s', (_name, re) => expect(c).toMatch(re))
  it('the six functions are taken back from the browser roles', () => {
    for (const fn of ['partner_send_block_reason(uuid)', 'partner_unsubscribe_token(uuid)', 'partner_unsubscribe_status(text)', 'partner_unsubscribe(text)', 'partner_mark_unsubscribed(uuid, uuid)', 'partner_reverse_unsubscribe(uuid, uuid)']) {
      expect(c).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn.replace(/[()]/g, '\\$&')}\\s+FROM PUBLIC, anon, authenticated;`))
    }
  })
  it('the undo refuses once a partner has unsubscribed or been put on a sequence', () => {
    expect(code(UNDO)).toMatch(/A partner has unsubscribed/)
    expect(code(UNDO)).toMatch(/has been put on a partner sequence/)
  })
})

// ── Customize and Reset, through the real routes ────────────────────────────
const h = vi.hoisted(() => {
  const state = { queue: [] as { table: string; resp: any }[], writes: [] as { table: string; op: string; arg: any }[] }
  const builder = (table: string) => {
    const i = state.queue.findIndex(q => q.table === table)
    const resp = i >= 0 ? state.queue.splice(i, 1)[0].resp : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = () => b
    for (const op of ['update', 'insert', 'delete']) b[op] = (arg: any) => { state.writes.push({ table, op, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, builder }
})
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.builder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => { const b: any = {}; b.select = () => b; b.eq = () => b; b.single = async () => ({ data: { id: 'u1', role: 'owner', location_id: 'loc-1' }, error: null }); return b },
  }),
}))
import { NextRequest } from 'next/server'
import { POST as clonePOST } from '@/app/api/locations/[id]/drip-paths/clone/route'
import { DELETE as resetDELETE } from '@/app/api/locations/[id]/drip-paths/[pathId]/route'

const INTRO_MASTER = { id: 'master-intro', path_key: 'partner-introduction', name: 'Partner introduction', is_active: true, is_master: true }
const INTRO_STEPS = [
  { drip_path_id: 'master-intro', step_order: 1, delay_days: 0, delay_unit: null, channel: 'email', subject: null, body: bodyIn('email500'), master_template_id: null, is_active: true, body_format: 'plain', is_paused: false, button_text: null, button_link: null, button_align: null },
  { drip_path_id: 'master-intro', step_order: 2, delay_days: 90, delay_unit: 'months', channel: 'email', subject: null, body: bodyIn('email501'), master_template_id: null, is_active: true, body_format: 'plain', is_paused: false, button_text: null, button_link: null, button_align: null },
]
beforeEach(() => { h.state.queue = []; h.state.writes = [] })

describe('a location can customize and reset a partner master', () => {
  it('CUSTOMIZE: the clone route copies the Partner introduction master and both its steps, words and timing intact', async () => {
    h.state.queue.push(
      { table: 'drip_paths', resp: { data: INTRO_MASTER, error: null } },
      { table: 'drip_paths', resp: { data: null, error: null } },
      { table: 'drip_path_steps', resp: { data: INTRO_STEPS, error: null } },
      { table: 'drip_paths', resp: { data: { id: 'copy-1', location_uuid: 'loc-1', path_key: 'partner-introduction', name: 'Partner introduction', is_active: true, cloned_from_id: 'master-intro' }, error: null } },
      { table: 'drip_path_steps', resp: { data: null, error: null } },
    )
    const res = await clonePOST(new NextRequest('http://x', { method: 'POST', body: JSON.stringify({ master_id: 'master-intro' }) }), { params: { id: 'loc-1' } })
    expect(res.status).toBe(201)
    const [pathIns, stepsIns] = h.state.writes
    expect(pathIns).toMatchObject({ table: 'drip_paths', op: 'insert', arg: { location_uuid: 'loc-1', path_key: 'partner-introduction', name: 'Partner introduction', is_master: false, cloned_from_id: 'master-intro' } })
    expect(stepsIns.table).toBe('drip_path_steps')
    expect(stepsIns.arg.map((s: any) => [s.step_order, s.delay_days, s.delay_unit, s.subject, s.body, s.body_format])).toEqual(
      INTRO_STEPS.map(s => [s.step_order, s.delay_days, s.delay_unit, s.subject, s.body, s.body_format]))
  })
  it('RESET: the reset route deletes the location\'s copy of a partner sequence', async () => {
    h.state.queue.push(
      { table: 'drip_paths', resp: { data: { id: 'copy-1', location_uuid: 'loc-1', is_master: false, path_key: 'partner-introduction' }, error: null } },
      { table: 'lead_drip_progress', resp: { count: 0, data: null, error: null } },
      { table: 'drip_paths', resp: { data: null, error: null } },
    )
    const res = await resetDELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: { id: 'loc-1', pathId: 'copy-1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: { id: 'copy-1', path_key: 'partner-introduction' } })
    expect(h.state.writes).toEqual([{ table: 'drip_paths', op: 'delete', arg: undefined }])
  })
  it("RESET while a partner is still active: the database's refusal comes back as the route's error, nothing deleted", async () => {
    h.state.queue.push(
      { table: 'drip_paths', resp: { data: { id: 'copy-1', location_uuid: 'loc-1', is_master: false, path_key: 'partner-introduction' }, error: null } },
      { table: 'lead_drip_progress', resp: { count: 0, data: null, error: null } },
      { table: 'drip_paths', resp: { data: null, error: { message: 'partner_progress_active: 1 partner(s) are still on this sequence; stop them before resetting it' } } },
    )
    const res = await resetDELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: { id: 'loc-1', pathId: 'copy-1' } })
    expect(res.status).toBe(500)
    expect((await res.json()).detail).toMatch(/partner_progress_active/)
  })
  it('the master itself can never be reset away', async () => {
    h.state.queue.push({ table: 'drip_paths', resp: { data: { id: 'master-intro', location_uuid: null, is_master: true, path_key: 'partner-introduction' }, error: null } })
    const res = await resetDELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: { id: 'loc-1', pathId: 'master-intro' } })
    expect(res.status).toBe(400)
    expect(h.state.writes).toEqual([])
  })
})
