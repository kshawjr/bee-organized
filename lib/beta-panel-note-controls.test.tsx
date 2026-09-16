// @vitest-environment happy-dom
//
// THE ENGAGEMENT PANEL GETS THE NOTE CONTROLS THE CLIENT CARD ALREADY HAD.
//
// 94631ed shipped edit and delete for notes, but only ClientProfile passed
// noteActionsFor. EngagementPanel renders the SAME NotesStream and did not —
// so an owner who reached a note from an engagement, which is most of the
// time including from the Inbox, could not touch it. Recent activity renders
// in exactly two places and this is the second.
//
// THE THING THAT MATTERS MOST: Recent activity is a MIXED stream. Real notes
// sit beside system entries, and in production those are all TOUCHPOINTS —
// verified against the live database:
//   "Client created" · "Address added → 116 Bowling Avenue, …" ·
//   "Address retired → …" · "Stage: New → Attempting" ·
//   "Moved to Network as … — drips paused" · "Drip stopped — invalid email"
// None of them is anyone's note, several ARE the audit record of a change,
// and an owner invited to delete one is the failure this file exists to
// catch. Two guards keep verbs off them, and both are pinned below:
//   · NotesStream only calls noteActionsFor for items it tagged t === 'note',
//     so a touchpoint never reaches the rule at all
//   · the shared rule refuses kind === 'system' and anything with no id
// production lead_notes currently carry only kind 'buzz' and 'job' — zero
// system notes — so the first guard is the one doing the work today and the
// second is the belt behind it.
//
// AUTHORISATION is unchanged and is enforced at the ROUTE
// (beta-lead-note-edit-delete proves the refusals with forged requests).
// What is asserted here is only which controls are DRAWN.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import EngagementPanel from '@/components/hive/EngagementPanel'
import ClientProfile from '@/components/hive/ClientProfile'
import { makeNoteActionsFor } from '@/components/hive/shared/noteActionsRule'
import { replaceInList, removeFromList } from '@/components/hive/shared/noteStream'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const AUTHOR = 'u-author'
const LOOKUPS = { sources: [], projectTypes: [], closeLostReasons: [] }

// A real note on this engagement, and the system entries that really sit
// beside it in production.
const REAL_NOTE = { id: 'en1', kind: 'job', text: 'Client prefers mornings', user_id: AUTHOR, user_label: 'Kevin', created_at: daysAgo(1), engagement_id: 'eng-1' }
const SYSTEM_TOUCHPOINTS = [
  { id: 'tp-created', kind: 'system', method: 'system', label: 'Client created', occurred_at: daysAgo(9) },
  { id: 'tp-addr',    kind: 'system', method: 'system', label: 'Address added → 116 Bowling Avenue, Nashville, TN, 37205', occurred_at: daysAgo(8) },
  { id: 'tp-retire',  kind: 'system', method: 'system', label: 'Address retired → 353 Blackstone Boulevard, Providence, RI, 02906', occurred_at: daysAgo(7) },
  { id: 'tp-stage',   kind: 'system', method: 'system', label: 'Stage: New → Attempting', occurred_at: daysAgo(6) },
  { id: 'tp-network', kind: 'system', method: 'system', label: 'Moved to Network as Amber Harris — drips paused', occurred_at: daysAgo(5) },
  { id: 'tp-drip',    kind: 'drip',   method: 'email',  label: 'Drip stopped — invalid email address', occurred_at: daysAgo(4) },
]

let notePatches: any[] = []
let noteDeletes: string[] = []
let engChildren: any = {}

const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const engagementPayload = () => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(5), stage_entered_at: daysAgo(5), location_uuid: 'loc-uuid-1',
    project_type: 'Client', description: 'Full kitchen reorganization',
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
  },
  children: {
    service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [],
    notes: [REAL_NOTE], touchpoints: SYSTEM_TOUCHPOINTS, ...engChildren,
  },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    request_details: null, source: 'Webform',
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  },
})

const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    stage: 'New', created_at: daysAgo(30), tags: [],
  },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: SYSTEM_TOUCHPOINTS,
  buzz_notes: [], job_notes: [{ ...REAL_NOTE, id: 'cn1', text: 'Card side note' }], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

const installFetch = () => {
  notePatches = []; noteDeletes = []; engChildren = {}
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url); const method = opts.method || 'GET'
    if (u.includes('/outreach-timeline')) return jsonRes({ items: [], drip_progress_id: null, paused: false, stopped: false, completed: false })
    if (u.includes('/timeline')) return jsonRes({ lead: { id: 'lead-9' }, touchpoints: [], notes: [], engagements: [], service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [], scheduled_stage_emails: [] })
    if (u.includes('/api/lead-notes/') && method === 'PATCH') {
      const body = JSON.parse(opts.body); notePatches.push({ url: u, body })
      return jsonRes({ note: { ...REAL_NOTE, text: body.text, edited_at: new Date().toISOString() } })
    }
    if (u.includes('/api/lead-notes/') && method === 'DELETE') {
      noteDeletes.push(u); return jsonRes({ deleted: true })
    }
    if (u.includes('/api/engagements/')) return jsonRes(engagementPayload())
    if (u.includes('/api/partners')) return jsonRes([])
    if (u.includes('/profile')) return jsonRes(profilePayload())
    return jsonRes({})
  })
}

let host: HTMLDivElement
let root: any
const mount = async (ui: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}
const click = async (el: Element | null) => {
  await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}
const text = () => host.textContent || ''
const testid = (id: string) => host.querySelector(`[data-testid="${id}"]`)

const mountPanel = (props: any = {}) =>
  mount(<EngagementPanel engagementId="eng-1" onClose={() => {}} lookupOptions={LOOKUPS}
    currentUserId={AUTHOR} currentUserRole="owner" {...props} />)

beforeEach(() => { installFetch() })
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; host?.remove(); vi.restoreAllMocks()
})

describe('the engagement panel now offers the controls', () => {
  it('renders edit and delete on a REAL note', async () => {
    await mountPanel()
    expect(text()).toContain('Client prefers mornings')
    expect(testid('note-edit-en1')).toBeTruthy()
    expect(testid('note-delete-en1')).toBeTruthy()
  })

  it('editing there hits the note route and folds the confirmed row back in', async () => {
    await mountPanel()
    await click(testid('note-edit-en1'))
    const input = testid('note-edit-input-en1') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, 'Prefers afternoons'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await click(testid('note-edit-save-en1'))

    expect(notePatches).toHaveLength(1)
    expect(notePatches[0].url).toContain('/api/lead-notes/en1')
    expect(notePatches[0].body).toEqual({ text: 'Prefers afternoons' })
    expect(text()).toContain('Prefers afternoons')
    expect(text()).not.toContain('Client prefers mornings')
  })

  it('deleting there removes the row from the panel', async () => {
    await mountPanel()
    await click(testid('note-delete-en1'))
    expect(text()).toContain('for good')     // the confirmation leads with the loss
    await click(testid('note-delete-confirm-en1'))

    expect(noteDeletes).toHaveLength(1)
    expect(noteDeletes[0]).toContain('/api/lead-notes/en1')
    expect(text()).not.toContain('Client prefers mornings')
  })
})

describe('NOT on a system entry — the audit trail is untouchable', () => {
  // Each of these is a real production label. None is anyone's note.
  for (const tp of SYSTEM_TOUCHPOINTS) {
    it(`no controls on "${tp.label.slice(0, 44)}"`, async () => {
      await mountPanel()
      expect(text()).toContain(tp.label.split(' →')[0].slice(0, 20)) // it IS on screen
      expect(testid(`note-edit-${tp.id}`)).toBeNull()
      expect(testid(`note-delete-${tp.id}`)).toBeNull()
    })
  }

  it('exactly ONE note in that stream carries controls, not six touchpoints', async () => {
    await mountPanel()
    expect(host.querySelectorAll('[data-testid^="note-edit-"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid^="note-delete-"]')).toHaveLength(1)
  })

  it('AS AN ADMIN too — still exactly one, and it is the note', async () => {
    // The load-bearing version of the test above. A touchpoint has no
    // user_id, so for an ordinary owner the rule already refuses it on the
    // AUTHOR check — which means an owner-only assertion passes even if the
    // is-this-a-note guard is removed entirely. An admin bypasses the author
    // check, so this is the view where a broken note guard actually shows,
    // and where "delete the record of a stage change" would be offered.
    // Found by mutation-testing: without this, both guards could be deleted
    // and every touchpoint assertion here still passed.
    await mountPanel({ currentUserId: 'u-admin', currentUserRole: 'admin' })
    expect(host.querySelectorAll('[data-testid^="note-edit-"]')).toHaveLength(1)
    expect(testid('note-edit-en1')).toBeTruthy()
    for (const tp of SYSTEM_TOUCHPOINTS) {
      expect(testid(`note-edit-${tp.id}`), tp.label).toBeNull()
      expect(testid(`note-delete-${tp.id}`), tp.label).toBeNull()
    }
  })

  it('a system NOTE would be refused too — the belt behind the t=note guard', async () => {
    // production has none today (lead_notes kinds are buzz|job), but the POST
    // route can still write one, so the rule refuses it rather than relying on
    // the stream tagging alone.
    engChildren = { notes: [{ ...REAL_NOTE, id: 'sys1', kind: 'system', text: 'System wrote this' }], touchpoints: [] }
    await mountPanel()
    expect(text()).toContain('System wrote this')
    expect(testid('note-edit-sys1')).toBeNull()
  })
})

describe('who sees them', () => {
  it('the AUTHOR sees them on their own note', async () => {
    await mountPanel({ currentUserId: AUTHOR, currentUserRole: 'owner' })
    expect(testid('note-edit-en1')).toBeTruthy()
  })

  it('a COLLEAGUE does not', async () => {
    await mountPanel({ currentUserId: 'u-colleague', currentUserRole: 'owner' })
    expect(text()).toContain('Client prefers mornings') // still reads it
    expect(testid('note-edit-en1')).toBeNull()          // cannot touch it
  })

  it('a MANAGER does not — manager is not admin', async () => {
    await mountPanel({ currentUserId: 'u-manager', currentUserRole: 'manager' })
    expect(testid('note-edit-en1')).toBeNull()
  })

  it('an ADMIN does, on someone else’s note', async () => {
    await mountPanel({ currentUserId: 'u-admin', currentUserRole: 'admin' })
    expect(testid('note-edit-en1')).toBeTruthy()
  })

  it('a super_admin does', async () => {
    await mountPanel({ currentUserId: 'u-s', currentUserRole: 'super_admin' })
    expect(testid('note-edit-en1')).toBeTruthy()
  })

  it('a signed-out shell (no id, no role) sees none', async () => {
    await mountPanel({ currentUserId: null, currentUserRole: null })
    expect(testid('note-edit-en1')).toBeNull()
  })

  it('read-only hides them even for the author', async () => {
    await mountPanel({ readOnly: true })
    expect(testid('note-edit-en1')).toBeNull()
  })
})

describe('the client card still behaves exactly as it did', () => {
  // The rule was lifted into a shared module for this build. This is where a
  // careless refactor of it would break what already worked.
  it('still offers controls on its own note', async () => {
    await mount(<ClientProfile clientId="lead-9" currentUserId={AUTHOR} currentUserRole="owner" onClose={() => {}} />)
    expect(text()).toContain('Card side note')
    expect(testid('note-edit-cn1')).toBeTruthy()
  })

  it('still withholds them from a colleague', async () => {
    await mount(<ClientProfile clientId="lead-9" currentUserId="u-colleague" currentUserRole="owner" onClose={() => {}} />)
    expect(testid('note-edit-cn1')).toBeNull()
  })

  it('still keeps them off its system touchpoints', async () => {
    await mount(<ClientProfile clientId="lead-9" currentUserId={AUTHOR} currentUserRole="owner" onClose={() => {}} />)
    expect(host.querySelectorAll('[data-testid^="note-edit-"]')).toHaveLength(1)
  })
})

describe('one rule, two screens', () => {
  it('the rule itself refuses non-notes and non-managers', () => {
    const rule = makeNoteActionsFor({ currentUserId: AUTHOR, currentUserRole: 'owner' })
    expect(rule(REAL_NOTE)).toBeTruthy()
    expect(rule({ ...REAL_NOTE, kind: 'system' })).toBeNull()
    expect(rule({ ...REAL_NOTE, id: null })).toBeNull()
    expect(rule(null)).toBeNull()
    const other = makeNoteActionsFor({ currentUserId: 'u-other', currentUserRole: 'owner' })
    expect(other(REAL_NOTE)).toBeNull()
  })

  it('the list primitives keep the same reference when nothing changes', () => {
    const list = [REAL_NOTE]
    expect(replaceInList(list, { ...REAL_NOTE, id: 'nope' })).toBe(list)
    expect(removeFromList(list, 'nope')).toBe(list)
    expect(removeFromList(list, 'en1')).toHaveLength(0)
  })

  it('BOTH screens spend the shared rule — neither re-derives it', () => {
    for (const f of ['components/hive/ClientProfile.jsx', 'components/hive/EngagementPanel.jsx']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      expect(src, f).toContain('makeNoteActionsFor({')
      expect(src, f).toContain('noteActionsFor={noteActionsFor}')
    }
  })

  it('NotesStream still only asks about items it tagged as notes', () => {
    // The first guard, and the one doing the work in production today.
    const src = readFileSync(join(process.cwd(), 'components/hive/NotesStream.jsx'), 'utf8')
    expect(src).toContain("a.t === 'note'")
  })
})
