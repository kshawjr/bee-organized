// @vitest-environment happy-dom
//
// Contact editing in the beta UI (2026-07-10) — the 041e75c auto-sync
// trigger finally has UI reach:
//
//   A) ContactField (shared/) — THE editable contact row, one
//      implementation, two mounts (ClientProfile + EngagementPanel,
//      source-pinned). Inline edit: row click opens a hairline input,
//      Enter/blur saves, Esc cancels with zero writes; the value stays
//      a live tel:/mailto: anchor. Client-side validation blocks junk
//      saves (email regex, phone ≥7 digits) with a quiet inline error —
//      no PATCH fires. Affordances follow the shared inline-edit
//      standard (shared/inlineEdit.jsx, 7/10): readable EditPencil in
//      view mode, ✓/✗ pair in edit mode — those behaviors are pinned
//      in beta-inline-edit-standard.test.tsx.
//   B) Toast tells the WHOLE truth from the PATCH response:
//      'Phone updated · synced to Jobber'   (contact_writeback updated/added)
//      'Phone updated'                       (not linked / nothing pushed)
//      'Phone updated · Jobber sync failed — saved in Bee Hub only'
//   C) Propagation: a save fires onSaved → hosts merge locally AND hand
//      lead columns up (onLeadPatched). leadColsToPersonFields now maps
//      phone/email — and NULLS the stale phoneNormalized (generated
//      column; a kept copy would dial the OLD number from Inbox rows).
//      Cross-view pin: profile edit → people-state merge shows the new
//      value with phoneNormalized cleared.
//
// The API side (audit touchpoint, formatting-only guard) is pinned in
// beta-contact-audit.test.ts; the Jobber mutation rails in
// beta-lead-edit-contact-sync.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ContactField from '@/components/hive/shared/ContactField'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { leadColsToPersonFields } from '@/components/hive/shared/leadPatchMap'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// ── fetch mock: PATCHes recorded + scripted response; GETs serve the
//    card payloads. ─────────────────────────────────────────────
let leadPatches: Array<{ url: string; body: any }> = []
let patchResponse: any = {}
const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100', address: '12 Hive Ln', city: 'Denver', state: 'CO', zip: '80014',
    created_at: daysAgo(40), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
  },
  referred_us: [], contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})
const engagementPayload = () => ({
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: daysAgo(5), stage_entered_at: daysAgo(5), location_uuid: 'loc-uuid-1',
    project_type: null, description: null, total_invoiced: 0, total_paid: 0, balance_owing: 0,
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
  client: {
    id: 'lead-9', name: 'Dana Client', email: 'dana@x.com', phone: '(561) 555-0100',
    request_details: null, source: null, referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  },
})
const installFetch = () => {
  leadPatches = []
  patchResponse = { lead: { id: 'lead-9' } }
  vi.stubGlobal('fetch', vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const method = opts.method || 'GET'
    if (u.includes('/api/leads/') && method === 'PATCH') {
      leadPatches.push({ url: u, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, json: async () => patchResponse }
    }
    if (u.includes('/profile')) return { ok: true, status: 200, json: async () => profilePayload() }
    if (u.includes('/api/engagements/')) return { ok: true, status: 200, json: async () => engagementPayload() }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
}
beforeEach(() => { installFetch(); document.body.innerHTML = '' })

// ── DOM helpers ────────────────────────────────────────────────
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
const type = (input: Element, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const key = (el: Element, k: string) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
})
const input = (host: Element) => host.querySelector('input')

// ── A) the row itself ──────────────────────────────────────────
describe('ContactField — inline edit save/cancel/validate', () => {
  const mountField = (props: any = {}) => {
    const onSaved = vi.fn()
    const setToast = vi.fn()
    return mount(
      <ContactField kind="phone" leadId="lead-9" value="(561) 555-0100" onSaved={onSaved} setToast={setToast} {...props} />
    ).then(m => ({ ...m, onSaved, setToast }))
  }

  it('display: live tel: anchor + the STANDARD pencil (readable ink, not ghost); row click opens the input pre-filled with the ✓/✗ pair', async () => {
    const { host, unmount } = await mountField()
    expect(host.querySelector('a[href="tel:(561) 555-0100"]')).toBeTruthy()
    expect(host.textContent).toContain('✎')
    expect(host.querySelector('.bee-edit-pencil')).toBeTruthy() // shared/inlineEdit standard, no private fork
    expect(input(host)).toBeNull()
    await click(host.querySelector('p')!)
    expect(input(host)).toBeTruthy()
    expect((input(host) as HTMLInputElement).value).toBe('(561) 555-0100')
    expect(host.querySelector('button[aria-label="Save"]')).toBeTruthy()
    expect(host.querySelector('button[aria-label="Cancel"]')).toBeTruthy()
    await unmount()
  })

  it('Esc cancels: input closes, zero PATCHes, value untouched', async () => {
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await type(input(host)!, '999')
    await key(input(host)!, 'Escape')
    expect(input(host)).toBeNull()
    expect(leadPatches).toEqual([])
    expect(host.textContent).toContain('(561) 555-0100')
    await unmount()
  })

  it('Enter saves a valid new phone → one PATCH { phone }; onSaved gets cols + response', async () => {
    patchResponse = { lead: { id: 'lead-9' } }
    const { host, unmount, onSaved } = await mountField()
    await click(host.querySelector('p')!)
    await type(input(host)!, '(704) 555-0142')
    await key(input(host)!, 'Enter')
    expect(leadPatches).toEqual([{ url: expect.stringContaining('/api/leads/lead-9'), body: { phone: '(704) 555-0142' } }])
    expect(onSaved).toHaveBeenCalledWith({ phone: '(704) 555-0142' }, { lead: { id: 'lead-9' } })
    expect(input(host)).toBeNull()
    await unmount()
  })

  it('blur saves too (focusout path)', async () => {
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await type(input(host)!, '704-555-0142')
    await act(async () => {
      input(host)!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(leadPatches.length).toBe(1)
    await unmount()
  })

  it('junk phone blocked client-side: quiet error, NO PATCH, stays editing', async () => {
    const { host, unmount } = await mountField()
    await click(host.querySelector('p')!)
    await type(input(host)!, '123')
    await key(input(host)!, 'Enter')
    expect(leadPatches).toEqual([])
    expect(input(host)).toBeTruthy() // still editing
    expect(host.textContent).toContain('Enter a valid phone (7+ digits)')
    await unmount()
  })

  it('junk email blocked: regex gate, no PATCH', async () => {
    const { host, unmount } = await mountField({ kind: 'email', value: 'dana@x.com' })
    await click(host.querySelector('p')!)
    await type(input(host)!, 'not-an-email')
    await key(input(host)!, 'Enter')
    expect(leadPatches).toEqual([])
    expect(host.textContent).toContain('Enter a valid email')
    await unmount()
  })

  it("empty state ('add phone') is a real input; save reports 'added'", async () => {
    const { host, unmount, setToast } = await mountField({ value: null })
    expect(host.textContent).toContain('add phone')
    await click(host.querySelector('p')!)
    await type(input(host)!, '7045550142')
    await key(input(host)!, 'Enter')
    expect(leadPatches[0].body).toEqual({ phone: '7045550142' })
    expect(setToast).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone added' })
    await unmount()
  })

  it("clearing an existing value saves '' and reports 'removed'", async () => {
    const { host, unmount, setToast } = await mountField()
    await click(host.querySelector('p')!)
    await type(input(host)!, '')
    await key(input(host)!, 'Enter')
    expect(leadPatches[0].body).toEqual({ phone: '' })
    expect(setToast).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone removed' })
    await unmount()
  })

  it('unchanged draft just closes — no PATCH, no toast', async () => {
    const { host, unmount, setToast } = await mountField()
    await click(host.querySelector('p')!)
    await key(input(host)!, 'Enter')
    expect(leadPatches).toEqual([])
    expect(setToast).not.toHaveBeenCalled()
    expect(input(host)).toBeNull()
    await unmount()
  })
})

// ── B) toast per writeback outcome ─────────────────────────────
describe('ContactField — toast reflects the whole contact_writeback truth', () => {
  const saveNewPhone = async (resp: any) => {
    patchResponse = resp
    const setToast = vi.fn()
    const m = await mount(
      <ContactField kind="phone" leadId="lead-9" value="(561) 555-0100" onSaved={() => {}} setToast={setToast} />
    )
    await click(m.host.querySelector('p')!)
    await type(input(m.host)!, '(704) 555-0142')
    await key(input(m.host)!, 'Enter')
    await m.unmount()
    return setToast
  }

  it("synced (updated) → 'Phone updated · synced to Jobber'", async () => {
    const t = await saveNewPhone({ lead: {}, contact_writeback: { phone: 'updated', email: 'unchanged' } })
    expect(t).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone updated · synced to Jobber' })
  })

  it("synced (added) → same '· synced to Jobber' suffix", async () => {
    const t = await saveNewPhone({ lead: {}, contact_writeback: { phone: 'added', email: 'unchanged' } })
    expect(t).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone updated · synced to Jobber' })
  })

  it("not linked (no contact_writeback) → plain 'Phone updated'", async () => {
    const t = await saveNewPhone({ lead: {} })
    expect(t).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone updated' })
  })

  it("sync failed → honest, not alarming: '… · Jobber sync failed — saved in Bee Hub only'", async () => {
    const t = await saveNewPhone({ lead: {}, contact_writeback: { phone: 'failed', email: 'unchanged' } })
    expect(t).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone updated · Jobber sync failed — saved in Bee Hub only' })
  })
})

// ── C) mounts + propagation ────────────────────────────────────
describe('two mounts, one implementation + cross-view propagation', () => {
  it('source pin: ClientProfile mounts shared/ContactField; the panel does NOT (build-2 person-vs-deal — contact is person-scoped, one View-profile tap away)', () => {
    const profile = readFileSync('components/hive/ClientProfile.jsx', 'utf8')
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(profile).toContain("from './shared/ContactField'")
    expect(panel).not.toContain('ContactField')
    expect(panel).not.toContain('AddressField')
  })

  it('ClientProfile: phone edit PATCHes, prepends the audit row into Recent activity, hands cols up', async () => {
    patchResponse = {
      lead: { id: 'lead-9' },
      contact_activity: [{ id: 'tp-audit', kind: 'system', method: null, label: 'Phone updated → (704) 555-0142', notes: 'was (561) 555-0100', occurred_at: new Date(now).toISOString(), engagement_id: null, user_id: 'u1' }],
    }
    const onLeadPatched = vi.fn()
    const { host, unmount } = await mount(
      <ClientProfile clientId="lead-9" onClose={() => {}} onLeadPatched={onLeadPatched} setToast={() => {}} />
    )
    const phoneRow = host.querySelector('a[href^="tel:"]')!.parentElement as HTMLElement
    await click(phoneRow)
    await type(input(host)!, '(704) 555-0142')
    await key(input(host)!, 'Enter')
    expect(leadPatches[0].body).toEqual({ phone: '(704) 555-0142' })
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { phone: '(704) 555-0142' })
    // The new value renders (state merge) and the audit entry landed in
    // the Recent activity stream without a refetch.
    expect(host.querySelector('a[href="tel:(704) 555-0142"]')).toBeTruthy()
    expect(host.textContent).toContain('Phone updated → (704) 555-0142')
    await unmount()
  })

  it('ClientProfile: the same shared row edits the email and hands cols up (the panel dropped its mount in build 2)', async () => {
    const onLeadPatched = vi.fn()
    const { host, unmount } = await mount(
      <ClientProfile clientId="lead-9" onClose={() => {}} onLeadPatched={onLeadPatched} setToast={() => {}} />
    )
    const emailRow = host.querySelector('a[href^="mailto:"]')!.parentElement as HTMLElement
    await click(emailRow)
    await type(input(host)!, 'dana.new@x.com')
    await key(input(host)!, 'Enter')
    expect(leadPatches[0].body).toEqual({ email: 'dana.new@x.com' })
    expect(onLeadPatched).toHaveBeenCalledWith('lead-9', { email: 'dana.new@x.com' })
    expect(host.querySelector('a[href="mailto:dana.new@x.com"]')).toBeTruthy()
    await unmount()
  })

  it('CROSS-VIEW: the saved cols flow through leadColsToPersonFields into people state — new phone shows, stale phoneNormalized cleared', async () => {
    // The real seam: card PATCH → onLeadPatched(cols) → HiveShell
    // translates → BeeHub merges into people. Exercise the translation +
    // merge with the REAL translator, then derive the Inbox tel: href the
    // way InboxScreen does (phoneNormalized || digits-of-phone).
    const onLeadPatched = vi.fn()
    const { host, unmount } = await mount(
      <ClientProfile clientId="lead-9" onClose={() => {}} onLeadPatched={onLeadPatched} setToast={() => {}} />
    )
    await click(host.querySelector('a[href^="tel:"]')!.parentElement!)
    await type(input(host)!, '(704) 555-0142')
    await key(input(host)!, 'Enter')
    await unmount()

    const [leadId, cols] = onLeadPatched.mock.calls[0]
    const fields = leadColsToPersonFields(cols)
    expect(fields).toEqual({ phone: '(704) 555-0142', phoneNormalized: null })

    // BeeHub's onPersonPatched merge (state-only), verbatim shape.
    const people = [{ id: 'lead-9', name: 'Dana Client', phone: '(561) 555-0100', phoneNormalized: '5615550100', email: 'dana@x.com' }]
    const merged = people.map(x => x.id === leadId ? { ...x, ...fields } : x)
    expect(merged[0].phone).toBe('(704) 555-0142')
    expect(merged[0].phoneNormalized).toBeNull()
    // InboxScreen's tel: derivation (line-for-line fallback) now dials
    // the NEW number — a kept stale phoneNormalized would dial the old.
    const phoneLabel = (merged[0].phone || '').trim()
    const phoneDigits = merged[0].phoneNormalized || phoneLabel.replace(/\D/g, '')
    expect(phoneDigits).toBe('7045550142')
  })

  it('formatting-only reformat still saves the display string (PATCH fires; the server-side diff is what keeps Jobber quiet)', async () => {
    const setToast = vi.fn()
    const { host, unmount } = await mount(
      <ContactField kind="phone" leadId="lead-9" value="(561) 555-0100" onSaved={() => {}} setToast={setToast} />
    )
    await click(host.querySelector('p')!)
    await type(input(host)!, '561.555.0100')
    await key(input(host)!, 'Enter')
    expect(leadPatches[0].body).toEqual({ phone: '561.555.0100' })
    expect(setToast).toHaveBeenCalledWith({ kind: 'success', msg: 'Phone updated' })
    await unmount()
  })
})
