// @vitest-environment happy-dom
//
// Card restore build 3 — the ACTIONS tier. Every action: happy path +
// failure honesty (a failed write never lies about having worked).
// Introspection verdicts (live schema, 2026-07-11) pinned at the end:
//   A2 — Jobber has NO send-invoice / record-payment / void mutations
//        (invoiceMarkAsSent/Close/Reopen are bookkeeping flips; classic's
//        popup buttons were mock-era local state). Invoice actions are
//        honest deep links — covered in beta-card-layout.
//   H  — RequestCreateInput.salespersonId EXISTS → send-to-jobber
//        assigns at creation, non-fatal retry-without on rejection.
//   I  — JobCreateAttributes.invoicing (BillingStrategy! + frequency!)
//        is required and uncollected → job_direct REMOVED from the
//        send popup; the server 400 gate stays as belt-and-suspenders.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import PreferencesBlock from '@/components/hive/shared/PreferencesBlock'
import ContactsBlock from '@/components/hive/shared/ContactsBlock'
import TagsRow from '@/components/hive/shared/TagsRow'
import AssignedToField from '@/components/hive/shared/AssignedToField'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const inDays = (n: number) => new Date(now + n * 86400000).toISOString()

// ── fetch recorder ─────────────────────────────────────────────
type Call = { url: string, method: string, body: any }
let calls: Call[] = []
let failNext: { match: string, error: string } | null = null
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: null, city: null, state: null, zip: null,
    created_at: daysAgo(400), source: 'Webform', paused: false, marketing_opt_out: false,
    snoozed_until: null, snoozed_note: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [], contacts: over.contacts || [], engagements: over.engagements || [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: over.tags || [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: (over.engagements || []).length, total_count: (over.engagements || []).length },
})

const engagementPayload = (over: any = {}) => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(30), stage_entered_at: daysAgo(30), location_uuid: 'loc-uuid-1',
    project_type: null, description: null, closed_at: null, closed_reason: null, closed_note: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
    ...(over.engagement || {}),
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [], ...(over.children || {}) },
  drip: over.drip !== undefined ? over.drip : null,
  client: {
    id: 'lead-9', name: 'Dana Client', location_name: 'Denver', email: 'dana@x.com', phone: null,
    address: null, city: null, state: null, zip: null, request_details: null, source: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
    ...(over.client || {}),
  },
})

let profileBody: any
let engBody: any
const installFetch = () => {
  calls = []; failNext = null
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (method !== 'GET') {
      const body = opts.body ? JSON.parse(opts.body) : null
      calls.push({ url: u, method, body })
      if (failNext && u.includes(failNext.match)) {
        const err = failNext.error
        failNext = null
        return jsonRes({ error: err }, 500)
      }
      if (u.includes('/api/lead-contacts') && method === 'POST') {
        return jsonRes({ contact: { id: 'ct-new', lead_id: body.lead_id, name: body.name, role: body.role, phone: body.phone, email: body.email } }, 201)
      }
      if (u.match(/\/api\/lead-contacts\/[^/]+$/) && method === 'PATCH') {
        return jsonRes({ contact: { id: u.split('/').pop(), lead_id: 'lead-9', ...body } })
      }
      if (u.includes('/api/lead-tags') && method === 'POST') {
        return jsonRes({ lead_tag: { lead_id: body.lead_id, tag_lookup_id: body.tag_lookup_id } }, 201)
      }
      return jsonRes({ ok: true })
    }
    if (u.includes('/api/engagements/')) return jsonRes(engBody)
    if (u.includes('/profile')) return jsonRes(profileBody)
    return jsonRes({})
  })
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const typeIn = (el: Element, value: string) => act(async () => {
  const proto = el.tagName === 'SELECT'
    ? (globalThis as any).window.HTMLSelectElement.prototype
    : (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
})
const btn = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const btnContaining = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').includes(text))

const CLIENT = () => ({
  id: 'lead-9', paused: false, marketing_opt_out: false, snoozed_until: null, snoozed_note: null,
})

beforeEach(() => {
  document.body.innerHTML = ''
  profileBody = profilePayload()
  engBody = engagementPayload()
  installFetch()
})

// ═══ C) marketing opt-out — confirm on the destructive direction ═══
describe('marketing opt-out (PreferencesBlock)', () => {
  it('opt-OUT needs the inline confirm; nothing writes before it', async () => {
    const onPatched = vi.fn()
    const toasts: any[] = []
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={0} onPatched={onPatched} setToast={(t: any) => toasts.push(t)} nowMs={now} />
    )
    await click(btn(host, 'Opt out…')!)
    expect(calls).toEqual([]) // confirm step, not a write
    expect(host.textContent).toContain('Stop all marketing email?')
    await click(btn(host, 'Confirm opt-out')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), method: 'PATCH', body: { marketing_opt_out: true } }])
    expect(onPatched).toHaveBeenCalledWith({ marketing_opt_out: true })
    expect(toasts.at(-1)).toEqual({ kind: 'success', msg: 'Opted out of marketing' })
    await unmount()
  })

  it('the ✗ cancels the confirm with zero writes', async () => {
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={0} onPatched={() => {}} setToast={() => {}} nowMs={now} />
    )
    await click(btn(host, 'Opt out…')!)
    await click(host.querySelector('button[aria-label="Cancel opt-out"]')!)
    expect(calls).toEqual([])
    expect(host.textContent).not.toContain('Stop all marketing email?')
    await unmount()
  })

  it('re-subscribe commits immediately — no dialog on the safe direction', async () => {
    const onPatched = vi.fn()
    const { host, unmount } = await mount(
      <PreferencesBlock client={{ ...CLIENT(), marketing_opt_out: true } as any} openCount={0} onPatched={onPatched} setToast={() => {}} nowMs={now} />
    )
    await click(btn(host, 'Re-subscribe')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), method: 'PATCH', body: { marketing_opt_out: false } }])
    expect(onPatched).toHaveBeenCalledWith({ marketing_opt_out: false })
    await unmount()
  })

  it('failure honesty: a 500 leaves the display unchanged and toasts the error', async () => {
    failNext = { match: '/api/leads/lead-9', error: 'nope' }
    const onPatched = vi.fn()
    const toasts: any[] = []
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={0} onPatched={onPatched} setToast={(t: any) => toasts.push(t)} nowMs={now} />
    )
    await click(btn(host, 'Opt out…')!)
    await click(btn(host, 'Confirm opt-out')!)
    expect(onPatched).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Marketing emails OK')
    expect(toasts.at(-1).kind).toBe('error')
    await unmount()
  })
})

// ═══ D) snooze ═════════════════════════════════════════════════
describe('snooze (PreferencesBlock)', () => {
  it('preset snooze PATCHes snoozed_until (+note); Timeline pickup rides the leadPatchMap seam', async () => {
    const onPatched = vi.fn()
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={0} onPatched={onPatched} setToast={() => {}} nowMs={now} />
    )
    await click(btn(host, 'Snooze…')!)
    await typeIn(host.querySelector('select[aria-label="Snooze length"]')!, '2w')
    await typeIn(host.querySelector('input[aria-label="Snooze note"]')!, 'Traveling until August')
    await click(btn(host, 'Snooze')!)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.snoozed_note).toBe('Traveling until August')
    const until = new Date(calls[0].body.snoozed_until).getTime()
    expect(Math.abs(until - (now + 14 * 86400000))).toBeLessThan(60000) // 2 weeks out
    expect(onPatched).toHaveBeenCalledWith({ snoozed_until: calls[0].body.snoozed_until, snoozed_note: 'Traveling until August' })
    // the propagation seam translates for the Inbox + Timeline consumers
    expect(leadColsToPersonFields({ snoozed_until: calls[0].body.snoozed_until })).toEqual({ snoozeUntil: calls[0].body.snoozed_until })
    await unmount()
  })

  it('un-snooze nulls BOTH columns; the note shows italic while snoozed', async () => {
    const onPatched = vi.fn()
    const { host, unmount } = await mount(
      <PreferencesBlock client={{ ...CLIENT(), snoozed_until: inDays(5), snoozed_note: 'Back after the move' } as any}
        openCount={0} onPatched={onPatched} setToast={() => {}} nowMs={now} />
    )
    expect(host.textContent).toContain('Snoozed until')
    expect(host.textContent).toContain('Back after the move')
    await click(btn(host, 'Un-snooze')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), method: 'PATCH', body: { snoozed_until: null, snoozed_note: null } }])
    expect(onPatched).toHaveBeenCalledWith({ snoozed_until: null, snoozed_note: null })
    await unmount()
  })

  it('custom date requires a date — no junk PATCH without one', async () => {
    const toasts: any[] = []
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={0} onPatched={() => {}} setToast={(t: any) => toasts.push(t)} nowMs={now} />
    )
    await click(btn(host, 'Snooze…')!)
    await typeIn(host.querySelector('select[aria-label="Snooze length"]')!, 'custom')
    await click(btn(host, 'Snooze')!)
    expect(calls).toEqual([])
    expect(toasts.at(-1).kind).toBe('error')
    await unmount()
  })
})

// ═══ B) drip controls ══════════════════════════════════════════
describe('drip controls', () => {
  it('preferences row: Pause hits drip-pause (the flag-synced route, never a bare leads PATCH)', async () => {
    const onPatched = vi.fn()
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={0} onPatched={onPatched} setToast={() => {}} nowMs={now} />
    )
    await click(btn(host, 'Pause')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9/drip-pause'), method: 'POST', body: null }])
    expect(onPatched).toHaveBeenCalledWith({ paused: true })
    await unmount()
  })

  it("preferences row: Activate hits drip-resume (its seed path enrolls never-dripped leads — that's the 'Activate' semantics)", async () => {
    const onPatched = vi.fn()
    const { host, unmount } = await mount(
      <PreferencesBlock client={{ ...CLIENT(), paused: true } as any} openCount={0} onPatched={onPatched} setToast={() => {}} nowMs={now} />
    )
    await click(btn(host, 'Activate')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9/drip-resume'), method: 'POST', body: null }])
    expect(onPatched).toHaveBeenCalledWith({ paused: false })
    await unmount()
  })

  it('the drip row stays HIDDEN with live business (v4 rule survives the toggles)', async () => {
    const { host, unmount } = await mount(
      <PreferencesBlock client={CLIENT() as any} openCount={2} onPatched={() => {}} setToast={() => {}} nowMs={now} />
    )
    expect(host.textContent).not.toContain('Nurture drips')
    await unmount()
  })

  it('masthead banner: Pause → drip-pause + banner flips to paused; Resume flips back', async () => {
    engBody = engagementPayload({ drip: { path_name: null, current_step: 2, total_steps: 5, next_send_at: inDays(3), paused: false } })
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={() => {}} />
    )
    const banner = () => host.querySelector('[aria-label="Drip banner"]')!
    expect(banner().textContent).not.toContain('paused')
    await click(btn(host, 'Pause')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9/drip-pause'), method: 'POST', body: null }])
    expect(banner().textContent).toContain('paused') // banner STAYS (paused ≠ stopped)
    await click(btn(host, 'Resume')!)
    expect(calls[1].url).toContain('/drip-resume')
    expect(banner().textContent).not.toContain('paused')
    await unmount()
  })

  it('banner failure honesty: failed pause keeps the banner un-paused', async () => {
    engBody = engagementPayload({ drip: { path_name: null, current_step: 1, total_steps: 4, next_send_at: null, paused: false } })
    failNext = { match: 'drip-pause', error: 'boom' }
    const toasts: any[] = []
    const { host, unmount } = await mount(
      <EngagementPanel engagementId="eng-1" onClose={() => {}} setToast={(t: any) => toasts.push(t)} />
    )
    await click(btn(host, 'Pause')!)
    expect(host.querySelector('[aria-label="Drip banner"]')!.textContent).not.toContain('paused')
    expect(toasts.at(-1).kind).toBe('error')
    await unmount()
  })
})

// ═══ E) contacts CRUD ══════════════════════════════════════════
describe('contacts CRUD (ContactsBlock)', () => {
  const CONTACT = { id: 'ct-1', name: 'Marco Delgado', role: 'Spouse', phone: '(561) 555-0177', email: 'marco@x.com' }

  it('add: + Add contact → form → ✓ POSTs lead-contacts and the row appears', async () => {
    let next: any = null
    const { host, unmount } = await mount(
      <ContactsBlock leadId="lead-9" contacts={[]} onChange={(n: any) => { next = n }} setToast={() => {}} />
    )
    await click(btn(host, '+ Add contact')!)
    await typeIn(host.querySelector('input[aria-label="Contact name"]')!, 'Marco Delgado')
    await typeIn(host.querySelector('select[aria-label="Contact role"]')!, 'Spouse')
    await typeIn(host.querySelector('input[aria-label="Contact phone"]')!, '(561) 555-0177')
    await click(host.querySelector('button[aria-label="Save"]')!)
    expect(calls).toEqual([{
      url: expect.stringContaining('/api/lead-contacts'), method: 'POST',
      body: { lead_id: 'lead-9', name: 'Marco Delgado', role: 'Spouse', phone: '(561) 555-0177', email: null },
    }])
    expect(next).toHaveLength(1)
    expect(next[0].name).toBe('Marco Delgado')
    await unmount()
  })

  it('edit: pencil row → PATCH /api/lead-contacts/:id; view keeps tel:/mailto: links', async () => {
    let next: any = null
    const { host, unmount } = await mount(
      <ContactsBlock leadId="lead-9" contacts={[CONTACT]} onChange={(n: any) => { next = n }} setToast={() => {}} />
    )
    expect(host.querySelector('a[href="tel:(561) 555-0177"]')).toBeTruthy()
    expect(host.querySelector('.bee-edit-pencil')).toBeTruthy() // the standard ✎
    await click(host.querySelector('[title="Edit contact"]')!)
    await typeIn(host.querySelector('input[aria-label="Contact phone"]')!, '(704) 555-0142')
    await click(host.querySelector('button[aria-label="Save"]')!)
    expect(calls[0].method).toBe('PATCH')
    expect(calls[0].url).toContain('/api/lead-contacts/ct-1')
    expect(calls[0].body.phone).toBe('(704) 555-0142')
    expect(next[0].phone).toBe('(704) 555-0142')
    await unmount()
  })

  it('delete: Remove contact inside edit mode → DELETE; row leaves', async () => {
    let next: any = null
    const { host, unmount } = await mount(
      <ContactsBlock leadId="lead-9" contacts={[CONTACT]} onChange={(n: any) => { next = n }} setToast={() => {}} />
    )
    await click(host.querySelector('[title="Edit contact"]')!)
    await click(btn(host, 'Remove contact')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/lead-contacts/ct-1'), method: 'DELETE', body: null }])
    expect(next).toEqual([])
    await unmount()
  })

  it('failure honesty: failed save keeps the form OPEN with the draft + inline error; empty name never PATCHes', async () => {
    const { host, unmount } = await mount(
      <ContactsBlock leadId="lead-9" contacts={[]} onChange={() => {}} setToast={() => {}} />
    )
    await click(btn(host, '+ Add contact')!)
    await click(host.querySelector('button[aria-label="Save"]')!) // empty name
    expect(calls).toEqual([])
    expect(host.textContent).toContain('Name is required')
    await typeIn(host.querySelector('input[aria-label="Contact name"]')!, 'Doomed Draft')
    failNext = { match: '/api/lead-contacts', error: 'nope' }
    await click(host.querySelector('button[aria-label="Save"]')!)
    expect(host.textContent).toContain('Save failed: nope')
    expect((host.querySelector('input[aria-label="Contact name"]') as HTMLInputElement).value).toBe('Doomed Draft')
    await unmount()
  })
})

// ═══ F) tags ═══════════════════════════════════════════════════
describe('tags (TagsRow)', () => {
  const OPTIONS = [{ id: 'tag-vip', label: 'VIP' }, { id: 'tag-hoa', label: 'HOA community' }]

  it('+ Tag popover toggle POSTs the junction row; pill appears with ✓ in the list', async () => {
    let next: any = null
    const { host, unmount } = await mount(
      <TagsRow leadId="lead-9" tags={[]} options={OPTIONS} onChange={(n: any) => { next = n }} setToast={() => {}} />
    )
    await click(host.querySelector('button[aria-label="Add tag"]')!)
    await click(btnContaining(host, 'VIP')!)
    expect(calls).toEqual([{
      url: expect.stringContaining('/api/lead-tags'), method: 'POST',
      body: { lead_id: 'lead-9', tag_lookup_id: 'tag-vip' },
    }])
    expect(next).toEqual([{ id: 'tag-vip', label: 'VIP' }])
    await unmount()
  })

  it('pill × DELETEs with query params (the route contract)', async () => {
    let next: any = null
    const { host, unmount } = await mount(
      <TagsRow leadId="lead-9" tags={[{ id: 'tag-vip', label: 'VIP' }]} options={OPTIONS} onChange={(n: any) => { next = n }} setToast={() => {}} />
    )
    await click(host.querySelector('button[aria-label="Remove tag VIP"]')!)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('lead_id=lead-9')
    expect(calls[0].url).toContain('tag_lookup_id=tag-vip')
    expect(next).toEqual([])
    await unmount()
  })

  it('failure honesty: failed add leaves the tags untouched', async () => {
    failNext = { match: '/api/lead-tags', error: 'boom' }
    const onChange = vi.fn()
    const toasts: any[] = []
    const { host, unmount } = await mount(
      <TagsRow leadId="lead-9" tags={[]} options={OPTIONS} onChange={onChange} setToast={(t: any) => toasts.push(t)} />
    )
    await click(host.querySelector('button[aria-label="Add tag"]')!)
    await click(btnContaining(host, 'VIP')!)
    expect(onChange).not.toHaveBeenCalled()
    expect(toasts.at(-1).kind).toBe('error')
    await unmount()
  })
})

// ═══ G) assigned-to ════════════════════════════════════════════
describe('assigned-to (AssignedToField)', () => {
  const USERS = [
    { id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', locationId: 'loc-uuid-1' },
    { id: 'u2', name: 'Wendy Ortiz', email: 'wendy@x.com', locationId: 'loc-uuid-1' },
  ]

  it('pick PATCHes leads.assigned_to and the display shows the name', async () => {
    const onSaved = vi.fn()
    const { host, unmount } = await mount(
      <AssignedToField leadId="lead-9" value={null} users={USERS} onSaved={onSaved} setToast={() => {}} />
    )
    expect(host.textContent).toContain('Unassigned')
    await click(host.querySelector('[title="Edit assignee"]')!)
    await click(btnContaining(host, 'Wendy Ortiz')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), method: 'PATCH', body: { assigned_to: 'u2' } }])
    expect(onSaved).toHaveBeenCalledWith({ assigned_to: 'u2' }, 'Wendy Ortiz')
    await unmount()
  })

  it('Unassigned clears to null; picking the current assignee writes nothing', async () => {
    const onSaved = vi.fn()
    const { host, unmount } = await mount(
      <AssignedToField leadId="lead-9" value="u1" valueName="Kevin Shaw" users={USERS} onSaved={onSaved} setToast={() => {}} />
    )
    await click(host.querySelector('[title="Edit assignee"]')!)
    await click(btnContaining(host, 'Kevin Shaw')!) // no-op pick
    expect(calls).toEqual([])
    await click(host.querySelector('[title="Edit assignee"]')!)
    await click(btnContaining(host, 'Unassigned')!)
    expect(calls).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), method: 'PATCH', body: { assigned_to: null } }])
    expect(onSaved).toHaveBeenCalledWith({ assigned_to: null }, null)
    await unmount()
  })

  it('assigned_to propagates through leadPatchMap (Inbox rows read assignedTo)', () => {
    expect(leadColsToPersonFields({ assigned_to: 'u2', paused: true, marketing_opt_out: true }))
      .toEqual({ assignedTo: 'u2', paused: true, marketingOptOut: true })
  })
})

// ═══ profile integration — the wired left column ═══════════════
describe('ClientProfile wires the live blocks', () => {
  it('preferences/contacts/tags/assigned-to all mount with data from the profile payload', async () => {
    profileBody = profilePayload({
      contacts: [{ id: 'ct-1', name: 'Marco Delgado', role: 'Spouse', phone: null, email: null }],
      tags: [{ id: 'tag-vip', label: 'VIP' }],
      client: { assigned_to: 'u1', assigned_to_name: 'Kevin Shaw' },
    })
    const { host, unmount } = await mount(
      <ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}}
        lookupOptions={{ sources: [], projectTypes: [], clientTags: [{ id: 'tag-vip', label: 'VIP' }, { id: 'tag-hoa', label: 'HOA community' }] } as any}
        locationUsers={[{ id: 'u1', name: 'Kevin Shaw', locationId: 'loc-uuid-1' }] as any} />
    )
    expect(host.textContent).toContain('Marco Delgado')
    expect(host.textContent).toContain('VIP')
    expect(host.textContent).toContain('Kevin Shaw')
    expect(btn(host, 'Opt out…')).toBeTruthy()
    expect(btn(host, 'Snooze…')).toBeTruthy()
    expect(btn(host, '+ Add contact')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Add tag"]')).toBeTruthy()
    await unmount()
  })
})

// ═══ introspection verdicts — source pins ══════════════════════
describe('introspection-gated verdicts (live schema 2026-07-11)', () => {
  it('H: send-to-jobber assigns salespersonId at request creation, NON-FATAL (retry-without on rejection)', () => {
    const route = readFileSync('app/api/leads/[id]/send-to-jobber/route.ts', 'utf8')
    expect(route).toContain('requestInput.salespersonId = assignedJobberUserId')
    expect(route).toContain('retrying unassigned') // the non-fatal path
    expect(route).toContain('REQUEST_ASSIGN_RETRY') // sync_log breadcrumb
  })

  it("I: job_direct is GONE from the send popup (JobCreateAttributes.invoicing! is uncollected); the server 400 gate stays", () => {
    const popup = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(popup).not.toContain('Create a Job Directly')
    expect(popup).not.toContain("'job_direct'\n        : 'request_only'")
    const route = readFileSync('app/api/leads/[id]/send-to-jobber/route.ts', 'utf8')
    expect(route).toContain("creation_type === 'job_direct'") // belt-and-suspenders gate
  })

  it('A2: no invoice mutation ships anywhere in the hive chunk — deep links only (no invoiceMarkAsSent/invoiceClose calls)', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(panel).not.toContain('invoiceMarkAsSent')
    expect(panel).not.toContain('invoiceClose')
    expect(panel).toContain('Collect in Jobber')
    expect(panel).toContain('Send in Jobber')
  })
})
