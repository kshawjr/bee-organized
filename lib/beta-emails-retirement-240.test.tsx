// @vitest-environment happy-dom
//
// Issue 240 step 11 — the old surfaces are gone, and nothing went with them.
//
// What this step deleted from the Emails tab: the two sequence tiles and
// everything inside them (path-style radios, Customize, Reset to master, the
// step rows with Preview/Edit/Change, + Add step, the delay chips) plus the
// Email Templates section. The call slice on Texts & scripts is untouched.
//
// This file is the retirement's own guard. It asserts the removals ACTUALLY
// happened on the rendered tab — a source grep cannot, since the tombstone
// comment naming what went contains most of the strings — and that each write
// in the pre-flight inventory still has a live path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SettingsScreen, buildEmailList } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'
const MASTER_ORG_B = 'aaaaaaaa-1111-4222-8333-444455556666'

const steps = () => [
  { id: 'ms1', step_order: 1, delay_days: 0, channel: 'email', subject: 'ONE', body: 'one\n\nx.', is_active: true },
  { id: 'ms2', step_order: 2, delay_days: 5, channel: 'email', subject: 'TWO', body: 'two\n\nx.', is_active: true },
  { id: 'ms3', step_order: 3, delay_days: 30, channel: 'email', subject: 'THREE', body: 'three\n\nx.', is_active: true },
]
const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { id: l === 'b' ? MASTER_ORG_B : `m-org-${l}`, path_key: `organizing-${l}`, name: `Org ${l}`, is_active: true, steps: steps() },
  { id: `m-mov-${l}`, path_key: `moving-${l}`, name: `Move ${l}`, is_active: true, steps: steps() },
])

const TEMPLATES = [
  { id: 'w', legacy_id: 'welcome', name: 'Welcome', type: 'email', tag: 'welcome', subject: 'Welcome!', body: 'w\n\nx.', is_active: true, location_uuid: null, is_master: true, is_own_custom: false, cloned_from_id: null },
  { id: 'c3', legacy_id: 'opp_closed_job_3mo', name: '3mo', type: 'email', tag: 'opportunity-stage', subject: '3mo', body: 'a\n\nx.', is_active: true, location_uuid: null, is_master: true, is_own_custom: false, cloned_from_id: null },
  { id: 'c12', legacy_id: 'opp_closed_job_12mo', name: '12mo', type: 'email', tag: 'opportunity-stage', subject: '12mo', body: 'b\n\nx.', is_active: true, location_uuid: null, is_master: true, is_own_custom: false, cloned_from_id: null },
  { id: 'call1', legacy_id: null, name: 'My Script', type: 'call', tag: 'custom', subject: null, body: 'script body', is_active: true, location_uuid: LOC_UUID, is_master: false, is_own_custom: true, cloned_from_id: null },
]

const selectedLoc = {
  id: LOC_UUID, name: 'Testville', owner: 'Pat Owner', address: '1 Main', phone: '(1) 2',
  bookingLink: 'https://cal.example/loc', reviewsLink: 'https://g.page/t', ratePerHour: '$88/hr',
  serviceRadius: '', timezone: 'America/Chicago', assessmentType: 'in-person', smsEnabled: false,
  jobberConnected: false, jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee',
  sendFromEmail: 'a@b.c', replyToEmail: 'a@b.c',
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[]

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    const method = init?.method || 'GET'
    let body: any
    try { body = init?.body ? JSON.parse(init.body) : undefined } catch { /* non-JSON */ }
    calls.push({ url: u, method, body })
    if (u.includes('/api/templates')) return { ok: true, status: 200, json: async () => ({ templates: TEMPLATES }) }
    if (u.includes('/api/drip-paths/masters')) return { ok: true, status: 200, json: async () => ({ masters: MASTERS }) }
    if (u.includes('/drip-paths')) return { ok: true, status: 200, json: async () => ({ paths: [], default_drip_path: 'organizing-b', default_move_drip_path: 'moving-b' }) }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => true))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

const mount = async (section: string) => {
  await act(async () => { root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection={section} franchiseRole="owner" />) })
  await act(async () => {})
  return container.textContent || ''
}
const buttons = () => Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim())

// ═══════════════════════════════════════════════════════════════════════════
describe('the retired surfaces do not render on Emails', () => {
  it('no sequence tiles, no path-style radios', async () => {
    const t = await mount('emails')
    expect(t).not.toContain('New lead emails')
    expect(t).not.toContain('Moving projects')
    expect(t).not.toContain('Organizing projects')
    // The four style labels the radios used.
    expect(t).not.toContain('Booking link · rate on the call')
    expect(t).not.toContain('Reply to schedule · rate included')
  })

  it('no Customize, no Reset to master, no whole-path banner', async () => {
    const t = await mount('emails')
    expect(buttons()).not.toContain('Customize')
    expect(buttons()).not.toContain('Reset to master')
    expect(t).not.toContain('Using the corp')
    expect(t).not.toContain('This set is')
  })

  it('no step-row Change or + Add step, and no delay chip', async () => {
    const t = await mount('emails')
    expect(buttons()).not.toContain('Change')
    expect(buttons()).not.toContain('+ Add step')
    expect(t).not.toContain('🕐')
    expect(t).not.toContain('days after sign-up')
  })

  it('no Email Templates section', async () => {
    const t = await mount('emails')
    expect(t).not.toContain('Email Templates')
    expect(t).not.toContain('Subject lines and bodies for client emails')
    expect(t).not.toContain('Master Templates')
  })

  it('what REPLACED them is on screen, so this is a swap and not a hole', async () => {
    const t = await mount('emails')
    expect(t).toContain('Every email a client can receive')
    expect(buttons()).toContain('Edit')
    expect(buttons()).toContain('+ Add another email')
    expect(t).toContain('Organizing')
    expect(t).toContain('Moving')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('Texts & scripts is untouched — call scripts still fully editable', () => {
  it('the call section renders with create, edit and delete', async () => {
    await mount('texts')
    const sub = Array.from(container.querySelectorAll('*')).find(
      el => el.textContent?.trim().startsWith('Talking points for you'))
    expect(sub, 'the Call Scripts section').toBeTruthy()
    for (let el = sub as HTMLElement | null; el && el !== container; el = el.parentElement) {
      await act(async () => { el!.click() })
      if ((container.textContent || '').includes('My Script')) break
    }
    const b = buttons()
    expect(b).toContain('Edit')       // own-custom is editable in place
    expect(b).toContain('Delete')
    expect(b.some(x => x?.includes('Create Template'))).toBe(true)
  })

  it('and it did NOT inherit the email slice on the way through', async () => {
    const t = await mount('texts')
    expect(t).not.toContain('Email Templates')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the write inventory — every one still has a path', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('1. persistDefault survives AND still has a live caller', () => {
    expect(beehub).toContain('async function persistDefault(')
    // Its callers were the tiles' radios, the tiles' two-question selector, and
    // 9c's confirmVariant. The first two are gone; if the third had gone too
    // the function would be dead and setting a variant impossible.
    const callers = beehub.match(/await persistDefault\(/g) || []
    expect(callers.length, 'persistDefault call sites').toBeGreaterThanOrEqual(2)
    expect(beehub).toContain("await persistDefault('generalDefault'")
    expect(beehub).toContain("await persistDefault('moveDefault'")
  })

  it('1b. and it writes BOTH defaults, never one alone', () => {
    const at = beehub.indexOf('async function confirmVariant')
    expect(at, 'confirmVariant').toBeGreaterThan(-1)
    const body = beehub.slice(at, at + 2500)
    expect(body).toContain("persistDefault('generalDefault'")
    expect(body).toContain("persistDefault('moveDefault'")
  })

  it('2+3. creating and deleting an email template is corporate’s, and still exists', () => {
    const at = beehub.indexOf('function MasterTemplatesEditor(')
    expect(at, 'MasterTemplatesEditor').toBeGreaterThan(-1)
    const body = beehub.slice(at, beehub.indexOf('\n}', at + 12000))
    expect(body).toContain("method: 'POST'")     // create
    expect(body).toContain("method: 'DELETE'")   // delete
    expect(beehub).toContain('<MasterTemplatesEditor')
  })

  it('4. rate and booking links are still owner-editable where they always were', async () => {
    const t = await mount('location')
    expect(t).toContain('Booking Link')
  })

  it('7. both sequences reach the list, so neither can go dark', () => {
    const at = beehub.indexOf('<EmailsList')
    const mountBlock = beehub.slice(at, at + 900)
    expect(mountBlock).toContain('generalDefault={settings.paths.generalDefault}')
    expect(mountBlock).toContain('moveDefault={settings.paths.moveDefault}')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('accepted losses are losses of the AFFORDANCE, not of the content', () => {
  // 13 production steps carry no text of their own and resolve through
  // master_template_id. Retiring the repoint control must not make their
  // wording unreadable or uneditable — the list resolves the link exactly the
  // way lib/drip-send.ts does.
  it('a step with no inline text shows its linked template’s wording', () => {
    const { newLead } = buildEmailList({
      pathSteps: { 'organizing-b': [
        { id: 's1', order: 1, type: 'email', delay_days: 0, subject: null, body: null, masterTemplateId: 'db-linked', origin: 'master' },
      ] },
      templates: [{ dbId: 'db-linked', legacyId: null, name: 'Linked', type: 'email', subject: 'LINKED SUBJ', body: 'LINKED BODY\n\nx.', isActive: true }],
      pathKey: 'organizing-b',
    })
    const row = newLead.find(r => r.rail === 'drip')!
    expect(row.subject).toBe('LINKED SUBJ')
    expect(row.body).toContain('LINKED BODY')
    // Not flagged as empty — an owner sees real words and can Edit them.
    expect(row.contentMissing).toBe(false)
  })

  it('an inactive linked template still resolves — send time does not filter either', () => {
    const { newLead } = buildEmailList({
      pathSteps: { 'organizing-b': [
        { id: 's1', order: 1, type: 'email', delay_days: 0, subject: null, body: null, masterTemplateId: 'db-off', origin: 'master' },
      ] },
      templates: [{ dbId: 'db-off', legacyId: null, name: 'Off', type: 'email', subject: 'OFF SUBJ', body: 'OFF BODY\n\nx.', isActive: false }],
      pathKey: 'organizing-b',
    })
    expect(newLead.find(r => r.rail === 'drip')!.subject).toBe('OFF SUBJ')
  })
})
