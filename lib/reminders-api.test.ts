// @vitest-environment node
//
// Reminders — the server side (/api/reminders, /api/reminders/[id]) against
// an in-memory database, plus the pure date rules in lib/reminders.
//
//   A) A reminder can be set on each record kind — a lead, a client (same
//      leads row), an engagement, a Network person — and reading that record
//      back returns it. (The card-level half is in reminders-ui.test.tsx.)
//   B) OWNERSHIP: a reminder set on someone ELSE's lead belongs to the
//      person who set it — not the lead's assignee, not the location owner.
//      The assignee never sees it; the setter always does.
//   C) Only the owner can finish, re-date or delete it (anyone else: 404).
//   D) Access: you can only set one on a record you can see.
//   E) Dates: today / overdue / upcoming, the Home split, quick picks.
//   F) NOTHING SENDS: a full set → list → change → finish → delete run
//      touches no email, Slack or network call; no reminder code imports a
//      sender; no cron was added.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))
// Tripwires: if anything in the reminder path ever reaches for a sender,
// these record it.
vi.mock('@/lib/resend', () => ({ renderTemplate: vi.fn(), sendEmail: vi.fn(), sendEmailDirect: vi.fn() }))
vi.mock('@/lib/slack', () => ({ postSlackMessage: vi.fn() }))
vi.mock('@/lib/slack-bot', () => ({
  SLACK: {}, projectTypeColor: vi.fn(), buildLeadSlackMessage: vi.fn(),
  postToSlack: vi.fn(), notifyNewLeadSlack: vi.fn(), getSlackUserEmail: vi.fn(),
}))

import { GET, POST } from '@/app/api/reminders/route'
import { PATCH, DELETE } from '@/app/api/reminders/[id]/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { sendEmail, sendEmailDirect } from '@/lib/resend'
import { postSlackMessage } from '@/lib/slack'
import { postToSlack, notifyNewLeadSlack } from '@/lib/slack-bot'
import { dueState, dueLabel, homeReminders, quickDates, isValidYmd, buildReminderInsert } from '@/lib/reminders'

// ── in-memory database ───────────────────────────────────────
const LOC = 'loc-kc'
const OTHER_LOC = 'loc-pdx'
let db: Record<string, any[]>
let seq = 0

function builder(table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: any = null
  const filters: Array<(r: any) => boolean> = []
  const b: any = {
    select: () => b,
    order: () => b,
    eq: (k: string, v: any) => { filters.push(r => r[k] === v); return b },
    is: (k: string, v: any) => { filters.push(r => (r[k] ?? null) === v); return b },
    in: (k: string, vs: any[]) => { filters.push(r => vs.includes(r[k])); return b },
    insert: (row: any) => { op = 'insert'; payload = row; return b },
    update: (patch: any) => { op = 'update'; payload = patch; return b },
    delete: () => { op = 'delete'; return b },
  }
  const exec = () => {
    const rows = (db[table] ||= [])
    if (op === 'insert') {
      const row = { id: `r-${++seq}`, done_at: null, created_at: `2026-09-30T10:00:0${seq}Z`, updated_at: null, lead_id: null, engagement_id: null, partner_id: null, ...payload }
      rows.push(row)
      return [row]
    }
    const hit = rows.filter(r => filters.every(f => f(r)))
    if (op === 'update') { hit.forEach(r => Object.assign(r, payload)); return hit }
    if (op === 'delete') { db[table] = rows.filter(r => !hit.includes(r)); return [] }
    return hit
  }
  b.single = async () => { const [row] = exec(); return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } } }
  b.maybeSingle = async () => { const [row] = exec(); return { data: row ? { ...row } : null, error: null } }
  b.then = (resolve: any, reject: any) => Promise.resolve({ data: exec().map(r => ({ ...r })), error: null }).then(resolve, reject)
  return b
}

// Signed-in person. Pat is the owner at KC; Kim is Pat's teammate and the
// ASSIGNEE of Kim's lead; Lee is at another location.
const USERS: Record<string, any> = {
  'u-pat': { id: 'u-pat', role: 'owner', location_id: LOC, full_name: 'Pat Owner' },
  'u-kim': { id: 'u-kim', role: 'manager', location_id: LOC, full_name: 'Kim Teammate' },
  'u-lee': { id: 'u-lee', role: 'owner', location_id: OTHER_LOC, full_name: 'Lee Elsewhere' },
}
let me = 'u-pat'
function signIn(id: string) { me = id }

beforeEach(() => {
  vi.clearAllMocks()
  seq = 0
  me = 'u-pat'
  db = {
    hub_users: Object.values(USERS).map(u => ({ ...u })),
    leads: [
      { id: 'lead-new', name: 'Nora New', location_uuid: LOC, stage: 'New' },        // a lead
      { id: 'lead-client', name: 'Carl Client', location_uuid: LOC, stage: 'Active' },// a client
      { id: 'lead-kims', name: 'Garage Gary', location_uuid: LOC, stage: 'New', assigned_to: 'u-kim' },
      { id: 'lead-pdx', name: 'Portland Pam', location_uuid: OTHER_LOC, stage: 'New' },
    ],
    lead_assignees: [{ lead_id: 'lead-kims', user_id: 'u-kim' }],
    engagements: [{ id: 'eng-1', client_id: 'lead-client', title: 'Garage reset', location_uuid: LOC }],
    partners: [{ id: 'partner-1', name: 'Rhonda Realtor', location_id: LOC, deleted_at: null }],
    reminders: [],
  }
  ;(createServerSupabaseClient as any).mockImplementation(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: me } } })) },
    from: (t: string) => builder(t),
  }))
  ;(supabaseService.from as any).mockImplementation((t: string) => builder(t))
})

const req = (url: string, method = 'GET', body?: any) =>
  new Request(`http://test${url}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json' } }) as any
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as any

async function setReminder(body: any) {
  const res = await POST(req('/api/reminders', 'POST', body))
  return { status: res.status, json: await res.json() }
}
async function listMine(query = '') {
  const res = await GET(req(`/api/reminders${query ? `?${query}` : ''}`))
  return (await res.json()).reminders as any[]
}

// ── A) every record kind ─────────────────────────────────────
describe('A) a reminder on each record kind comes back on that record', () => {
  const kinds = [
    { label: 'a lead', body: { lead_id: 'lead-new' }, q: 'lead_id=lead-new', type: 'client', name: 'Nora New' },
    { label: 'a client', body: { lead_id: 'lead-client' }, q: 'lead_id=lead-client', type: 'client', name: 'Carl Client' },
    { label: 'an engagement', body: { engagement_id: 'eng-1' }, q: 'engagement_id=eng-1', type: 'engagement', name: 'Carl Client · Garage reset' },
    { label: 'a Network person', body: { partner_id: 'partner-1' }, q: 'partner_id=partner-1', type: 'network', name: 'Rhonda Realtor' },
  ]
  for (const k of kinds) {
    it(`${k.label}`, async () => {
      const { status } = await setReminder({ ...k.body, due_on: '2026-10-06', note: 'call about the garage' })
      expect(status).toBe(201)
      const onRecord = await listMine(k.q)
      expect(onRecord).toHaveLength(1)
      expect(onRecord[0]).toMatchObject({ note: 'call about the garage', due_on: '2026-10-06', record_type: k.type, record_name: k.name })
      // …and ONLY on that record: another record's view doesn't show it.
      const elsewhere = await listMine(k.q.startsWith('lead_id=lead-new') ? 'lead_id=lead-client' : 'lead_id=lead-new')
      expect(elsewhere).toHaveLength(0)
    })
  }

  it('needs exactly one record, a real date and a note', async () => {
    expect((await setReminder({ due_on: '2026-10-06', note: 'x' })).status).toBe(400)
    expect((await setReminder({ lead_id: 'lead-new', partner_id: 'partner-1', due_on: '2026-10-06', note: 'x' })).status).toBe(400)
    expect((await setReminder({ lead_id: 'lead-new', due_on: '2026-02-30', note: 'x' })).status).toBe(400)
    expect((await setReminder({ lead_id: 'lead-new', due_on: '2026-10-06', note: '   ' })).status).toBe(400)
    expect((await setReminder({ lead_id: 'no-such-lead', due_on: '2026-10-06', note: 'x' })).status).toBe(404)
    expect(db.reminders).toHaveLength(0)
  })
})

// ── B) ownership ─────────────────────────────────────────────
describe('B) a reminder belongs to whoever set it', () => {
  it("one set on someone else's lead is the SETTER's, not the assignee's", async () => {
    // Garage Gary is Kim's lead. Pat sets the reminder.
    signIn('u-pat')
    const { status, json } = await setReminder({ lead_id: 'lead-kims', due_on: '2026-10-06', note: 'call about the garage' })
    expect(status).toBe(201)
    expect(json.reminder.user_id).toBe('u-pat')
    expect(db.reminders[0].user_id).toBe('u-pat')

    // Pat sees it in their list and on the lead…
    expect((await listMine()).map(r => r.note)).toEqual(['call about the garage'])
    expect(await listMine('lead_id=lead-kims')).toHaveLength(1)

    // …Kim, the assignee, sees nothing — not in the list, not on the lead.
    signIn('u-kim')
    expect(await listMine()).toHaveLength(0)
    expect(await listMine('lead_id=lead-kims')).toHaveLength(0)
  })

  it("the lost-lead wizard's reminder belongs to whoever ANSWERED the wizard", async () => {
    // The exact body CloseLostWizard sends (reminders-two-tabs.test.tsx pins
    // it): the client, the date, the line — no owner. Kim answers it on a
    // lead that is not hers to own; the reminder is Kim's.
    signIn('u-kim')
    const { status, json } = await setReminder({ lead_id: 'lead-new', due_on: '2026-10-01', note: 'check back on budget' })
    expect(status).toBe(201)
    expect(json.reminder.user_id).toBe('u-kim')
    expect((await listMine()).map(r => r.note)).toEqual(['check back on budget'])
    signIn('u-pat')
    expect(await listMine()).toHaveLength(0)
  })

  it('the owner can never be chosen by the caller', async () => {
    signIn('u-pat')
    const { json } = await setReminder({ lead_id: 'lead-kims', user_id: 'u-kim', due_on: '2026-10-06', note: 'x' })
    expect(json.reminder.user_id).toBe('u-pat')
  })

  it('the pure insert builder stamps the setter', () => {
    const row = buildReminderInsert({ setterId: 'u-pat', record: { key: 'lead_id', id: 'lead-kims' }, locationUuid: LOC, dueOn: '2026-10-06', note: 'x' })
    expect(row).toEqual({ user_id: 'u-pat', location_uuid: LOC, lead_id: 'lead-kims', due_on: '2026-10-06', note: 'x' })
  })
})

// ── C) finish / change / delete — owner only ─────────────────
describe('C) only the owner can finish, re-date or delete', () => {
  it('finish removes it from every list; re-date and delete work', async () => {
    const a = (await setReminder({ lead_id: 'lead-new', due_on: '2026-10-06', note: 'first' })).json.reminder
    const b = (await setReminder({ partner_id: 'partner-1', due_on: '2026-10-02', note: 'second' })).json.reminder
    const c = (await setReminder({ engagement_id: 'eng-1', due_on: '2026-10-09', note: 'third' })).json.reminder
    expect((await listMine()).map(r => r.note)).toEqual(['second', 'first', 'third']) // soonest first

    const redated = await PATCH(req(`/api/reminders/${c.id}`, 'PATCH', { due_on: '2026-10-01' }), ctx(c.id))
    expect(redated.status).toBe(200)
    expect((await listMine()).map(r => r.note)).toEqual(['third', 'second', 'first'])

    const done = await PATCH(req(`/api/reminders/${a.id}`, 'PATCH', { done: true }), ctx(a.id))
    expect(done.status).toBe(200)
    expect(db.reminders.find(r => r.id === a.id).done_at).toBeTruthy()
    expect((await listMine()).map(r => r.note)).toEqual(['third', 'second'])

    const gone = await DELETE(req(`/api/reminders/${b.id}`, 'DELETE'), ctx(b.id))
    expect(gone.status).toBe(200)
    expect(db.reminders.find(r => r.id === b.id)).toBeUndefined()
    expect((await listMine()).map(r => r.note)).toEqual(['third'])
  })

  it("someone else can't touch it — 404, and it is unchanged", async () => {
    const r = (await setReminder({ lead_id: 'lead-kims', due_on: '2026-10-06', note: 'mine' })).json.reminder
    signIn('u-kim')
    expect((await PATCH(req(`/api/reminders/${r.id}`, 'PATCH', { done: true }), ctx(r.id))).status).toBe(404)
    expect((await PATCH(req(`/api/reminders/${r.id}`, 'PATCH', { due_on: '2027-01-01' }), ctx(r.id))).status).toBe(404)
    expect((await DELETE(req(`/api/reminders/${r.id}`, 'DELETE'), ctx(r.id))).status).toBe(404)
    expect(db.reminders[0]).toMatchObject({ user_id: 'u-pat', due_on: '2026-10-06', done_at: null })
  })

  it('an edit cannot move the owner or the record', async () => {
    const r = (await setReminder({ lead_id: 'lead-new', due_on: '2026-10-06', note: 'x' })).json.reminder
    await PATCH(req(`/api/reminders/${r.id}`, 'PATCH', { due_on: '2026-10-07', user_id: 'u-kim', lead_id: 'lead-client' }), ctx(r.id))
    expect(db.reminders[0]).toMatchObject({ user_id: 'u-pat', lead_id: 'lead-new', due_on: '2026-10-07' })
  })
})

// ── D) access ────────────────────────────────────────────────
describe('D) you can only set one on a record you can see', () => {
  it('another location’s lead is refused', async () => {
    signIn('u-lee')
    expect((await setReminder({ lead_id: 'lead-new', due_on: '2026-10-06', note: 'x' })).status).toBe(403)
    expect(db.reminders).toHaveLength(0)
  })
  it('a removed Network person is refused', async () => {
    db.partners[0].deleted_at = '2026-09-01T00:00:00Z'
    expect((await setReminder({ partner_id: 'partner-1', due_on: '2026-10-06', note: 'x' })).status).toBe(404)
  })
  it('signed out is refused', async () => {
    ;(createServerSupabaseClient as any).mockImplementation(async () => ({
      auth: { getUser: vi.fn(async () => ({ data: { user: null } })) }, from: (t: string) => builder(t),
    }))
    expect((await GET(req('/api/reminders'))).status).toBe(401)
  })
})

// ── E) dates ─────────────────────────────────────────────────
describe('E) today, overdue, and the Home split', () => {
  const today = '2026-09-30' // a Wednesday
  it('classifies against the viewer’s own day', () => {
    expect(dueState('2026-09-29', today)).toBe('overdue')
    expect(dueState('2026-09-30', today)).toBe('today')
    expect(dueState('2026-10-01', today)).toBe('upcoming')
  })
  it('reads the way an owner says it', () => {
    expect(dueLabel('2026-09-30', today)).toBe('Today')
    expect(dueLabel('2026-10-01', today)).toBe('Tomorrow')
    expect(dueLabel('2026-09-29', today)).toBe('Yesterday')
    expect(dueLabel('2026-10-06', today)).toBe('Tuesday')
    expect(dueLabel('2026-10-14', today)).toBe('Oct 14')
  })
  it('Home = overdue first (oldest first), then today; nothing later, nothing finished', () => {
    const list = [
      { id: 'later', due_on: '2026-10-02' },
      { id: 'today', due_on: '2026-09-30' },
      { id: 'late2', due_on: '2026-09-29' },
      { id: 'late1', due_on: '2026-09-20' },
      { id: 'done', due_on: '2026-09-25', done_at: '2026-09-26T00:00:00Z' },
    ]
    const h = homeReminders(list, today)
    expect(h.overdue.map(r => r.id)).toEqual(['late1', 'late2'])
    expect(h.today.map(r => r.id)).toEqual(['today'])
  })
  it('Tomorrow and Next week are one day and seven days on', () => {
    expect(quickDates(new Date(2026, 8, 30, 15))).toEqual({ tomorrow: '2026-10-01', nextWeek: '2026-10-07' })
    expect(quickDates(new Date(2026, 11, 31, 23, 59))).toEqual({ tomorrow: '2027-01-01', nextWeek: '2027-01-07' })
    expect(isValidYmd('2026-10-01')).toBe(true)
    expect(isValidYmd('2026-13-01')).toBe(false)
  })
})

// ── F) nothing sends ─────────────────────────────────────────
describe('F) nothing sends an email or a Slack message', () => {
  it('a full set → list → re-date → finish → delete run calls no sender and no network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const r = (await setReminder({ lead_id: 'lead-new', due_on: '2026-09-29', note: 'overdue one' })).json.reminder
      await listMine()
      await PATCH(req(`/api/reminders/${r.id}`, 'PATCH', { due_on: '2026-09-30' }), ctx(r.id))
      await PATCH(req(`/api/reminders/${r.id}`, 'PATCH', { done: true }), ctx(r.id))
      const r2 = (await setReminder({ partner_id: 'partner-1', due_on: '2026-10-01', note: 'x' })).json.reminder
      await DELETE(req(`/api/reminders/${r2.id}`, 'DELETE'), ctx(r2.id))
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const sender of [sendEmail, sendEmailDirect, postSlackMessage, postToSlack, notifyNewLeadSlack]) {
      expect(sender).not.toHaveBeenCalled()
    }
  })

  it('no reminder file imports a sender, and no cron was added for reminders', () => {
    const root = join(__dirname, '..')
    const files = [
      'lib/reminders.ts', 'lib/reminders-server.ts',
      'app/api/reminders/route.ts', 'app/api/reminders/[id]/route.ts',
      'components/hive/shared/Reminders.jsx', 'components/hive/RemindersScreen.jsx',
    ]
    for (const f of files) {
      const imports = readFileSync(join(root, f), 'utf8').split('\n').filter(l => /^\s*import\b/.test(l)).join('\n')
      expect(imports, f).not.toMatch(/resend|slack|email|mail|notif|twilio|sms|push/i)
    }
    const crons = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).crons.map((c: any) => c.path)
    expect(crons.some((p: string) => /remind/i.test(p))).toBe(false)
  })
})
