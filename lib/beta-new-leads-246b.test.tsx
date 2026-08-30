// @vitest-environment happy-dom
//
// Issue 246 step 2 — NEW LEADS, REBUILT. The feature.
//
// Two things that were one. `lead_notification_prefs.category` used to decide
// BOTH which leads you heard about and which leads you were assigned, gated by
// two per-location split_* flags. That fusion is what this step ends:
//
//   WHO HANDLES A JOB TYPE — one person per type. Their name goes on that
//     type's client emails AND a new lead of that type is assigned to them.
//     No handler → the location owner. location_project_type_senders.
//   WHO IS TOLD — per person, on/off, unrelated to job types.
//     lead_notification_prefs.subscribed / lead_notification_externals.subscribed.
//
// This file replaces lib/beta-team-routing-240.test.tsx (TeamRouting, deleted)
// and lib/beta-split-inert-notice.test.tsx (the split toggle's inert-state
// notice, deleted with the toggle). The guarantees from the first that still
// mean something — rows come from ACTIVE lookups, grouped by drip_category,
// controls capped not stretched, no per-row Slack control — are carried over
// below rather than dropped on the floor.
//
// THE ONE THAT MATTERS MOST is 'the SEND path honours a muted external'. The
// UI can show a mute, the row can say subscribed=false, and the send path can
// simply never ask — no error, no log, an interface quietly lying. That test
// fails if the `if (!e.subscribed) continue` in resolveBaseLeadRecipients is
// removed, which is the only thing standing between the switch and the lie.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC = '132b42c2-0000-4000-8000-000000000001'

// ── Supabase double ─────────────────────────────────────────────────────────
// Table-keyed rows + a chainable query stub, so the server-side resolvers can
// be exercised against real shapes without a database.
type Rows = Record<string, any[]>
let rows: Rows = {}
let updates: Array<{ table: string; payload: any }> = []

function makeQuery(table: string) {
  let data = [...(rows[table] || [])]
  const q: any = {
    select() { return q },
    eq(col: string, val: any) { data = data.filter(r => r[col] === val); return q },
    in(col: string, vals: any[]) { data = data.filter(r => vals.includes(r[col])); return q },
    is(col: string, val: any) { data = data.filter(r => (r[col] ?? null) === val); return q },
    order() { return q },
    limit(n: number) { data = data.slice(0, n); return q },
    maybeSingle() { return Promise.resolve({ data: data[0] ?? null, error: null }) },
    single() { return Promise.resolve({ data: data[0] ?? null, error: null }) },
    update(payload: any) { updates.push({ table, payload }); return q },
    upsert(payload: any) { updates.push({ table, payload }); return Promise.resolve({ data: null, error: null }) },
    delete() { return q },
    then(res: any, rej: any) { return Promise.resolve({ data, error: null }).then(res, rej) },
  }
  return q
}

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => makeQuery(t) },
}))
vi.mock('@/lib/zoho', () => ({ getZohoLocationNotificationContacts: async () => [] }))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: async () => ({ id: 'u-owner', name: 'Lynette Ewy' }),
}))

const LOOKUP_ROWS = [
  { category: 'project_types', label: 'Home or Office Organizing', is_active: true, sort_order: 10, attrs: { drip_category: 'general' } },
  { category: 'project_types', label: 'Moving/Relocation',         is_active: true, sort_order: 20, attrs: { drip_category: 'move' } },
  { category: 'project_types', label: 'Concierge Services',        is_active: true, sort_order: 30, attrs: { drip_category: 'general' } },
  { category: 'project_types', label: 'Other',                     is_active: true, sort_order: 40, attrs: { drip_category: 'general' } },
  // Inactive: leads still carry these, so they must canonicalize — but nobody
  // can be their handler, so they fall to the owner.
  { category: 'project_types', label: 'Garage',                    is_active: false, sort_order: 90, attrs: { drip_category: 'general' } },
]

const HUB_USERS = [
  { id: 'u-owner', location_id: LOC, full_name: 'Lynette Ewy', first_name: 'Lynette', last_name: 'Ewy', email: 'lynette@bee.test', role: 'owner',   is_active: true, disabled_at: null },
  { id: 'u-carol', location_id: LOC, full_name: 'Carol Kern',  first_name: 'Carol',   last_name: 'Kern', email: 'carol@bee.test',  role: 'manager', is_active: true, disabled_at: null },
]

const baseRows = (over: Partial<Rows> = {}): Rows => ({
  lookups: LOOKUP_ROWS,
  hub_users: HUB_USERS,
  lead_notification_prefs: [],
  lead_notification_externals: [],
  location_project_type_senders: [],
  locations: [{ id: LOC, location_id: 'loc_kc', send_from_email: 'hello@bee.test' }],
  ...over,
})

const handlerRow = (type: string, userId: string, name: string, email: string) => ({
  location_id: LOC, project_type: type, sender_name: name, sender_email: email,
  sender_reply_to: null, source_user_id: userId,
})

beforeEach(() => { rows = baseRows(); updates = [] })
afterEach(() => { vi.resetModules() })

// ═══════════════════════════════════════════════════════════════════════════
// 1 · A HANDLER ROW DRIVES BOTH THE SENDER AND THE ASSIGNEE
// ═══════════════════════════════════════════════════════════════════════════
describe('one handler row, two consequences', () => {
  it('drives the ASSIGNEE for that type', async () => {
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u-carol'])
    expect(r.basis).toBe('project_type')
  })

  it('drives the SENDER for that type — the same row, no second table', async () => {
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { getLocationHandlers } = await import('@/lib/project-type-handlers')
    const h = await getLocationHandlers(LOC)
    const carol = h.get('moving/relocation')
    expect(carol?.email).toBe('carol@bee.test')
    expect(carol?.hub_user_id).toBe('u-carol')
  })

  it('the assignee and the sender are the SAME person — they cannot disagree', async () => {
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const { getHandlerForType } = await import('@/lib/project-type-handlers')
    const assigned = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    const sender = await getHandlerForType(LOC, 'Moving/Relocation')
    expect(assigned.hubUserIds[0]).toBe(sender!.hub_user_id)
  })

  it('a DISABLED handler is treated as absent — the type falls to the owner', async () => {
    // The FK's ON DELETE CASCADE only covers hard deletes; offboarding here is
    // soft (disabled_at). Without this, an offboarded person keeps being
    // assigned work and keeps having their name on client email.
    rows.hub_users = [HUB_USERS[0], { ...HUB_USERS[1], disabled_at: '2026-08-01T00:00:00Z' }]
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u-owner'])
    expect(r.basis).toBe('location_owner')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · NO HANDLER → THE LOCATION OWNER
// ═══════════════════════════════════════════════════════════════════════════
describe('the owner is the fallback, always', () => {
  it('no handler row for a real type assigns the owner', async () => {
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Concierge Services' })
    expect(r.hubUserIds).toEqual(['u-owner'])
    expect(r.basis).toBe('location_owner')
  })

  it('a lead matching NO type assigns the owner', async () => {
    // 'Client' — 53 real leads carry it. Not a project type at all; it is what
    // the manual-create path writes.
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Client' })
    expect(r.hubUserIds).toEqual(['u-owner'])
    expect(r.basis).toBe('location_owner')
    expect(r.projectTypeUnrecognized).toBe(true)
  })

  it('a lead with NO project type at all assigns the owner', async () => {
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: null })
    expect(r.hubUserIds).toEqual(['u-owner'])
    expect(r.projectTypeUnrecognized).toBe(false)
  })

  it('a location with NO handler rows at all sends everything to the owner', async () => {
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    for (const t of ['Moving/Relocation', 'Home or Office Organizing', 'Other']) {
      const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: t })
      expect(r.hubUserIds, `type=${t}`).toEqual(['u-owner'])
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · ONE MATCHING RULE — canonicalize at the boundary, then match exactly
// ═══════════════════════════════════════════════════════════════════════════
describe('one matching rule, shared by assign and send', () => {
  beforeEach(() => {
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
  })

  it('a case-variant project_type still finds the handler', async () => {
    // Zero of these exist in production today — this is prevention, not repair.
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: '  moving/RELOCATION ' })
    expect(r.hubUserIds).toEqual(['u-carol'])
  })

  it("the legacy 'moving' token resolves — the one live divergence of the old three rules", async () => {
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'moving' })
    expect(r.hubUserIds).toEqual(['u-carol'])
  })

  it('assign and send agree on a legacy token — they used not to', async () => {
    // Before this step: assign aliased 'organizing' → the label and routed it;
    // notify and send did an exact string compare and did not. Same table, same
    // question, two answers.
    rows.location_project_type_senders = [
      handlerRow('Home or Office Organizing', 'u-carol', 'Carol Kern', 'carol@bee.test'),
    ]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const { resolveHandlerForRawType } = await import('@/lib/project-type-handlers')
    const assigned = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'organizing' })
    const sender = await resolveHandlerForRawType(LOC, 'organizing')
    expect(assigned.hubUserIds).toEqual(['u-carol'])
    expect(sender?.hub_user_id).toBe('u-carol')
  })

  it('an INACTIVE label canonicalizes but has no handler → the owner', async () => {
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Garage' })
    expect(r.resolvedProjectType).toBe('Garage')
    expect(r.projectTypeUnrecognized).toBe(false)
    expect(r.hubUserIds).toEqual(['u-owner'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · WHO IS TOLD — and the SEND path honouring it
// ═══════════════════════════════════════════════════════════════════════════
describe('who is told is a switch, and the send path reads it', () => {
  it('a team member toggled off is not in the send list', async () => {
    rows.lead_notification_prefs = [
      { location_id: LOC, hub_user_id: 'u-carol', category: 'all', subscribed: false },
    ]
    const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
    const out = await resolveLeadRecipients(LOC, { project_type: 'Moving/Relocation' })
    expect(out.map(r => r.email)).toEqual(['lynette@bee.test'])
  })

  it('THE SEND PATH HONOURS A MUTED EXTERNAL — the switch is not decorative', async () => {
    // Delete the `if (!e.subscribed) continue` in resolveBaseLeadRecipients and
    // this fails. Nothing else would: the UI would still show the mute, the row
    // would still say false, and the address would still get every lead.
    rows.lead_notification_externals = [
      { id: 'x1', location_id: LOC, first_name: 'Elmer', last_name: null, email: 'elmer@outside.test', phone: null, category: 'all', subscribed: false },
      { id: 'x2', location_id: LOC, first_name: 'Hive',  last_name: null, email: 'hive@outside.test',  phone: null, category: 'all', subscribed: true },
    ]
    const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
    const emails = (await resolveLeadRecipients(LOC, { project_type: 'Moving/Relocation' })).map(r => r.email)
    expect(emails).not.toContain('elmer@outside.test')
    expect(emails).toContain('hive@outside.test')
  })

  it('muting an external does NOT delete it — the row survives for the UI and the Zoho top-up', async () => {
    rows.lead_notification_externals = [
      { id: 'x1', location_id: LOC, first_name: null, last_name: null, email: 'elmer@outside.test', phone: null, category: 'all', subscribed: false },
    ]
    const { getManageableRecipients } = await import('@/lib/notification-recipients')
    const { externals } = await getManageableRecipients(LOC)
    expect(externals).toHaveLength(1)
    expect(externals[0].email).toBe('elmer@outside.test')
    expect(externals[0].subscribed).toBe(false)
  })

  it('a missing `subscribed` column reads as SUBSCRIBED, never as silently muted', async () => {
    // Forward-safety: if this ever runs against a DB without the column, 50
    // live recipients must not stop hearing about leads without saying so.
    rows.lead_notification_externals = [
      { id: 'x1', location_id: LOC, first_name: null, last_name: null, email: 'legacy@outside.test', phone: null, category: 'all' },
    ]
    const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
    const emails = (await resolveLeadRecipients(LOC, null)).map(r => r.email)
    expect(emails).toContain('legacy@outside.test')
  })

  it('a muted handler is STILL TOLD about their own leads — the assignee is always emailed', async () => {
    // REVERSED 2026-08-30 (Kevin, option c for Lynette's 279fcfbf). This pin
    // used to assert the opposite — told: no, assigned: yes — the "still
    // assigned these, just not emailed" state. That state is now impossible:
    // there is no second channel, so an untold assignee never learns the lead
    // exists. The switch still governs every lead NOT assigned to them.
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    rows.lead_notification_prefs = [
      { location_id: LOC, hub_user_id: 'u-carol', category: 'all', subscribed: false },
    ]
    const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const told = (await resolveLeadRecipients(LOC, { project_type: 'Moving/Relocation' })).map(r => r.email).sort()
    const assigned = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(told).toEqual(['carol@bee.test', 'lynette@bee.test']) // told after all
    expect(assigned.hubUserIds).toEqual(['u-carol'])             // still handles
    // …but her switch still covers leads assigned to someone ELSE:
    const other = (await resolveLeadRecipients(LOC, { project_type: 'Home or Office Organizing' })).map(r => r.email)
    expect(other).toEqual(['lynette@bee.test'])
  })

  it('project type does NOT filter the notify list any more', async () => {
    // The fusion, gone. Everyone subscribed hears about every lead whatever
    // types exist and whoever handles them.
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
    const moving = (await resolveLeadRecipients(LOC, { project_type: 'Moving/Relocation' })).map(r => r.email).sort()
    const org = (await resolveLeadRecipients(LOC, { project_type: 'Home or Office Organizing' })).map(r => r.email).sort()
    expect(moving).toEqual(org)
    expect(moving).toEqual(['carol@bee.test', 'lynette@bee.test'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · NO split_* FLAG IS READ IN THE NOTIFY OR ASSIGN PATH
// ═══════════════════════════════════════════════════════════════════════════
describe('the flags are retired', () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

  it.each([
    'lib/notification-recipients.ts',
    'lib/lead-assignment.ts',
    'lib/project-type-handlers.ts',
    'lib/resend.ts',
    'lib/project-type-senders.ts',
  ])('%s does not READ a split_* flag', file => {
    const src = read(file)
    // Comments explaining the retirement are fine and wanted; a live read is
    // not. Strip // and /* */ before looking.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/split_notifications_enabled/)
    expect(code).not.toMatch(/split_senders_enabled/)
  })

  it('a location with the flags OFF still routes by its handler rows', async () => {
    // loc_kc's exact shape before this step: four handler rows and
    // split_notifications_enabled = false. The rows used to steer only the FROM
    // line while every lead was assigned to the owner.
    rows.locations = [{
      id: LOC, location_id: 'loc_kc', send_from_email: 'hello@bee.test',
      split_notifications_enabled: false, split_senders_enabled: false,
    }]
    rows.location_project_type_senders = [handlerRow('Moving/Relocation', 'u-carol', 'Carol Kern', 'carol@bee.test')]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u-carol'])
  })

  it("loc_kc's four handler rows survive and still resolve", async () => {
    // The real production rows, verbatim.
    rows.location_project_type_senders = [
      handlerRow('Concierge Services',        'u-owner', 'Lynette Ewy', 'lynette@bee.test'),
      handlerRow('Home or Office Organizing', 'u-owner', 'Lynette Ewy', 'lynette@bee.test'),
      handlerRow('Moving/Relocation',         'u-carol', 'Carol Kern',  'carol@bee.test'),
      handlerRow('Other',                     'u-owner', 'Lynette Ewy', 'lynette@bee.test'),
    ]
    const { resolveLeadAssignees } = await import('@/lib/lead-assignment')
    const got: Record<string, string> = {}
    for (const t of ['Concierge Services', 'Home or Office Organizing', 'Moving/Relocation', 'Other']) {
      got[t] = (await resolveLeadAssignees({ locationUuid: LOC, projectType: t })).hubUserIds[0]
    }
    expect(got).toEqual({
      'Concierge Services': 'u-owner',
      'Home or Office Organizing': 'u-owner',
      'Moving/Relocation': 'u-carol',   // THE production behaviour change
      'Other': 'u-owner',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · THE SECTION UI
// ═══════════════════════════════════════════════════════════════════════════
describe('the New leads section', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>
  let calls: Array<{ url: string; method: string; body: any }> = []

  const HANDLER_CFG = {
    base_sender_email: 'hello@bee.test',
    project_types: ['Home or Office Organizing', 'Moving/Relocation', 'Concierge Services', 'Other'],
    project_type_groups: [
      { label: 'Home or Office Organizing', drip_category: 'general' },
      { label: 'Moving/Relocation',         drip_category: 'move' },
      { label: 'Concierge Services',        drip_category: 'general' },
      { label: 'Other',                     drip_category: 'general' },
    ],
    assignments: [
      { id: 'a1', project_type: 'Moving/Relocation', sender_name: 'Carol Kern', sender_email: 'carol@bee.test', sender_reply_to: null, sender_is_custom: false, source_user_id: 'u-carol', domain_warning: false },
    ],
    people: [
      { id: 'u-owner', name: 'Lynette Ewy', email: 'lynette@bee.test', role: 'owner',   domain_warning: false },
      { id: 'u-carol', name: 'Carol Kern',  email: 'carol@bee.test',   role: 'manager', domain_warning: false },
    ],
  }

  const NOTIF_CFG = {
    project_types: HANDLER_CFG.project_types,
    users: [
      { hub_user_id: 'u-owner', name: 'Lynette Ewy', email: 'lynette@bee.test', role: 'owner',   category: 'all', subscribed: true },
      { hub_user_id: 'u-carol', name: 'Carol Kern',  email: 'carol@bee.test',   role: 'manager', category: 'all', subscribed: true },
    ],
    externals: [
      { id: 'x1', name: 'Elmer', email: 'elmer@outside.test', phone: null, first_name: 'Elmer', last_name: null, category: 'all', subscribed: true },
    ],
  }

  const mountSection = async (handler: any = HANDLER_CFG, notif: any = NOTIF_CFG) => {
    calls = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
      calls.push({ url, method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
      const json = url.includes('project-type-senders') ? handler
        : url.includes('notification-recipients') ? notif
        : {}
      return { ok: true, status: 200, json: async () => json }
    }))
    const { NewLeadsSection } = await import('@/components/BeeHub')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(<NewLeadsSection realLocId={LOC} />) })
    await act(async () => {})
    return container
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.unstubAllGlobals()
  })

  it('renders one handler row per ACTIVE type, grouped Organizing / Moving', async () => {
    await mountSection()
    for (const t of HANDLER_CFG.project_types) {
      expect(container.querySelector(`[data-handler-row="${t}"]`), t).toBeTruthy()
    }
    const txt = container.textContent || ''
    expect(txt).toContain('Organizing')
    expect(txt).toContain('Moving')
    // TWO selects per row (issue 296): who handles it, and what it sends as.
    // 246 step 2 fused these into one choice; 296 separates them again, because
    // a job type very commonly sends from a shared mailbox while a person still
    // works the lead. Four types × two questions.
    expect(container.querySelectorAll('select').length).toBe(8)
  })

  it('the handler selects are capped and sit left, never stretched', async () => {
    await mountSection()
    for (const s of Array.from(container.querySelectorAll('select')) as HTMLSelectElement[]) {
      expect(s.style.maxWidth, 'each select carries an explicit cap').toBeTruthy()
    }
  })

  it('states the owner fallback in plain words', async () => {
    await mountSection()
    expect(container.textContent).toContain('The location owner')
    expect(container.textContent).toContain('comes to the owner')
  })

  it('shows the current handler as the selected option', async () => {
    await mountSection()
    const sel = container.querySelector('[data-handler-row="Moving/Relocation"] select') as HTMLSelectElement
    expect(sel.value).toBe('u-carol')
    const other = container.querySelector('[data-handler-row="Other"] select') as HTMLSelectElement
    expect(other.value).toBe('')     // no handler → the owner
  })

  it('picking a handler POSTs exactly that one type', async () => {
    await mountSection()
    const sel = container.querySelector('[data-handler-row="Other"] select') as HTMLSelectElement
    sel.value = 'u-carol'
    await act(async () => { sel.dispatchEvent(new Event('change', { bubbles: true })) })
    const post = calls.find(c => c.method === 'POST' && c.url.includes('project-type-senders'))
    expect(post).toBeTruthy()
    expect(post!.body.project_types).toEqual(['Other'])
    expect(post!.body.source_user_id).toBe('u-carol')
  })

  it('clearing a handler DELETEs that type — no master toggle involved', async () => {
    await mountSection()
    const sel = container.querySelector('[data-handler-row="Moving/Relocation"] select') as HTMLSelectElement
    sel.value = ''
    await act(async () => { sel.dispatchEvent(new Event('change', { bubbles: true })) })
    const del = calls.find(c => c.method === 'DELETE')
    expect(del!.body.project_types).toEqual(['Moving/Relocation'])
    // The retired flags must never be flipped from this screen.
    expect(calls.some(c => c.body && ('enabled' in c.body || 'split_enabled' in c.body))).toBe(false)
  })

  it('shows, per person, which job types they handle', async () => {
    await mountSection()
    const line = container.querySelector('[data-handles="carol@bee.test"]')
    expect(line, 'Carol is shown as a handler').toBeTruthy()
    expect(line!.textContent).toContain('Moving/Relocation')
    // Lynette handles nothing in this fixture.
    expect(container.querySelector('[data-handles="lynette@bee.test"]')).toBeFalsy()
  })

  it('a handler with notifications OFF still shows as a handler, and says so', async () => {
    // COPY REVERSED 2026-08-30 with the assignee-always-told rule: it used to
    // read "still assigned these, just not emailed" — a state that no longer
    // exists. Off now means off for OTHER leads only.
    await mountSection(HANDLER_CFG, {
      ...NOTIF_CFG,
      users: [NOTIF_CFG.users[0], { ...NOTIF_CFG.users[1], subscribed: false }],
    })
    const line = container.querySelector('[data-handles="carol@bee.test"]')
    expect(line!.textContent).toContain('Moving/Relocation')
    expect(line!.textContent).toContain('still emailed about these; the switch only covers other leads')
    expect(line!.textContent).not.toContain('just not emailed')
  })

  it('an OWNER with notifications OFF is told their no-handler leads still email them', async () => {
    // The owner is the fallback assignee for anything without a handler, so
    // their off-switch narrows them to those leads — it cannot silence them.
    await mountSection(HANDLER_CFG, {
      ...NOTIF_CFG,
      users: [{ ...NOTIF_CFG.users[0], subscribed: false }, NOTIF_CFG.users[1]],
    })
    const note = container.querySelector('[data-owner-note="lynette@bee.test"]')
    expect(note, 'the owner-off note renders').toBeTruthy()
    expect(note!.textContent).toContain('without a handler')
    expect(note!.textContent).toContain('still email')
    // …and it does NOT render while the owner is on.
    await act(async () => { root.unmount() })
    await mountSection(HANDLER_CFG, NOTIF_CFG)
    expect(container.querySelector('[data-owner-note="lynette@bee.test"]')).toBeFalsy()
  })

  it('toggling a person off PATCHes subscribed, not a category', async () => {
    await mountSection()
    const row = container.querySelector('[data-recipient="carol@bee.test"]')!
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => { sw.click() })
    const patch = calls.find(c => c.method === 'PATCH')
    expect(patch!.body).toEqual({ hub_user_id: 'u-carol', subscribed: false })
    expect(patch!.body).not.toHaveProperty('category')
  })

  it('toggling an outside address off PATCHes subscribed — it does not DELETE', async () => {
    await mountSection()
    const row = container.querySelector('[data-recipient="elmer@outside.test"]')!
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement
    await act(async () => { sw.click() })
    const patch = calls.find(c => c.method === 'PATCH' && c.url.includes('/externals/'))
    expect(patch, 'a PATCH, not a DELETE').toBeTruthy()
    expect(patch!.body).toEqual({ subscribed: false })
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('states the Slack broadcast without offering per-person control', async () => {
    await mountSection()
    const txt = container.textContent || ''
    expect(txt).toContain('every')
    expect(txt).toContain('new lead posts there')
    expect(txt).toContain('nothing to set per person')
    // No Slack control on any handler row.
    for (const t of HANDLER_CFG.project_types) {
      const row = container.querySelector(`[data-handler-row="${t}"]`)!
      expect(row.textContent?.toLowerCase()).not.toContain('slack')
    }
  })

  it('renders no master toggle at all', async () => {
    await mountSection()
    // Every switch on the page belongs to a named recipient row.
    const switches = Array.from(container.querySelectorAll('[role="switch"]'))
    expect(switches.length).toBe(NOTIF_CFG.users.length + NOTIF_CFG.externals.length)
    for (const s of switches) {
      expect(s.closest('[data-recipient]'), 'every switch is a person').toBeTruthy()
    }
  })
})
