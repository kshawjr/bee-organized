// @vitest-environment node
//
// A FOLLOW-UP SET ON THE CONTACT SHEET IS A REMINDER (slice 4b). Not a copy
// of one, not a second list: the same row, in the same table, read by the
// same two screens.
//
// The chain, link by link, and where each link is pinned:
//   1 the sheet posts { partner_id, due_on, note } to /api/reminders and
//     nothing else                        → contact-sheet-adds.test.tsx
//   2 that exact request, through the REAL reminders route, makes one
//     reminders row owned by whoever set it, and touches nothing else
//                                          → here
//   3 the REAL reminders list (what the Reminders page and Home both read)
//     hands that row back, named for the contact, as a Network reminder
//                                          → here
//   4 a Network reminder of that shape is drawn on the Reminders page and on
//     Home, and opens the contact          → doors.test.tsx, doors 5 and 6
//
// The same run was made against a copy of production with the real routes:
// ~/Projects/bee-organized-repair-reports/2026-11-15/contact-adds-proof/.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: vi.fn() }))
vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: vi.fn() } }))

import { GET, POST } from '@/app/api/reminders/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { homeReminders } from '@/lib/reminders'
import { followUpBody } from './contact-adds'

const LOC = 'loc-greensboro'
const CONTACT = 'partner-1'
let db: Record<string, any[]>
let writes: string[]
let me = 'u-super'

function builder(table: string) {
  let op = 'select'; let payload: any = null
  const filters: Array<(r: any) => boolean> = []
  const b: any = {
    select: () => b, order: () => b,
    eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return b },
    is: (k: string, v: any) => { filters.push((r) => (r[k] ?? null) === v); return b },
    in: (k: string, vs: any[]) => { filters.push((r) => vs.includes(r[k])); return b },
    insert: (row: any) => { op = 'insert'; payload = row; return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    delete: () => { op = 'delete'; return b },
  }
  const exec = () => {
    const rows = (db[table] ||= [])
    if (op !== 'select') writes.push(`${table}/${op}`)
    if (op === 'insert') {
      const row = { id: `rem-${rows.length + 1}`, done_at: null, created_at: '2026-11-15T16:00:00Z', updated_at: '2026-11-15T16:00:00Z', lead_id: null, engagement_id: null, partner_id: null, ...payload }
      rows.push(row); return [row]
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)))
    if (op === 'update') hit.forEach((r) => Object.assign(r, payload))
    return hit
  }
  b.single = async () => { const [row] = exec(); return { data: row ? { ...row } : null, error: row ? null : { message: 'not found' } } }
  b.maybeSingle = async () => { const [row] = exec(); return { data: row ? { ...row } : null, error: null } }
  b.then = (res: any, rej: any) => Promise.resolve({ data: exec().map((r) => ({ ...r })), error: null }).then(res, rej)
  return b
}

beforeEach(() => {
  me = 'u-super'; writes = []
  db = {
    hub_users: [{ id: 'u-super', role: 'super_admin', location_id: null }, { id: 'u-owner', role: 'owner', location_id: LOC }],
    partners: [{ id: CONTACT, name: 'Lisa Snyder', location_id: LOC, deleted_at: null, updated_at: '2026-09-01T00:00:00Z', last_contacted_at: null }],
    leads: [], engagements: [], reminders: [],
  }
  ;(createServerSupabaseClient as any).mockImplementation(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: me } } })) },
    from: (t: string) => builder(t),
  }))
  ;(supabaseService.from as any).mockImplementation((t: string) => builder(t))
})

const set = async (form = { dueOn: '2026-11-20', note: 'Coffee about spring' }) => {
  const b = followUpBody(CONTACT, form)
  if (!b.ok) throw new Error(b.error)
  return POST(new Request('http://x/api/reminders', { method: 'POST', body: JSON.stringify(b.body) }) as any)
}
const list = async (qs = '') => (await (await GET(new Request(`http://x/api/reminders${qs}`) as any)).json()).reminders

describe('what the sheet sends, through the real reminders route', () => {
  it('makes one reminders row, owned by whoever set it, at the contact\'s location', async () => {
    const res = await set()
    expect(res.status).toBe(201)
    expect(db.reminders).toHaveLength(1)
    expect(db.reminders[0]).toMatchObject({ user_id: 'u-super', location_uuid: LOC, partner_id: CONTACT, lead_id: null, engagement_id: null, due_on: '2026-11-20', note: 'Coffee about spring', done_at: null })
  })
  it('writes nothing but that row: the contact itself is not touched', async () => {
    const before = JSON.stringify(db.partners)
    await set()
    expect(writes).toEqual(['reminders/insert'])
    expect(JSON.stringify(db.partners)).toBe(before)
  })
})

describe('what the Reminders page and Home then read', () => {
  it('the reminders list hands it back as a Network reminder named for the contact', async () => {
    await set()
    const [r] = await list()
    expect(r).toMatchObject({ partner_id: CONTACT, due_on: '2026-11-20', note: 'Coffee about spring', record_type: 'network', record_name: 'Lisa Snyder', done_at: null })
    // Every field the reminder drawn in doors.test.tsx (doors 5 and 6) carries.
    for (const k of ['id', 'user_id', 'partner_id', 'lead_id', 'engagement_id', 'due_on', 'note', 'record_type', 'record_name', 'done_at', 'created_at']) expect(r, k).toHaveProperty(k)
  })
  it('Home shows it on its day, and as overdue after it; before its day it is on the Reminders page only', async () => {
    await set()
    const all = await list()
    expect(homeReminders(all, '2026-11-20').today.map((r: any) => r.note)).toEqual(['Coffee about spring'])
    expect(homeReminders(all, '2026-11-21').overdue.map((r: any) => r.note)).toEqual(['Coffee about spring'])
    expect(homeReminders(all, '2026-11-19')).toEqual({ overdue: [], today: [] })
    expect(all).toHaveLength(1)
  })
  it('the contact sheet reads the same row back for the same person', async () => {
    await set()
    expect((await list(`?partner_id=${CONTACT}`)).map((r: any) => r.note)).toEqual(['Coffee about spring'])
  })
  it('it is personal, like every reminder: someone else at that location does not see it', async () => {
    await set()
    me = 'u-owner'
    expect(await list()).toEqual([])
  })
})

describe('there is no second system', () => {
  it('nothing in the new Network writes a reminder of its own', () => {
    const files = ['components/network/ContactSheet.jsx', 'app/api/network/contacts/[id]/route.ts', 'lib/network/contact-adds.ts']
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).not.toMatch(/from\('reminders'\)\s*\.(insert|update|upsert|delete)/)
      expect(src, f).not.toMatch(/follow_?ups?['"`]?\)\s*\.(insert|update|upsert)/i)
    }
    const sheet = readFileSync(join(process.cwd(), 'components/network/ContactSheet.jsx'), 'utf8')
    expect(sheet).toContain("call('/api/reminders', 'POST', b.body)")
  })
})
