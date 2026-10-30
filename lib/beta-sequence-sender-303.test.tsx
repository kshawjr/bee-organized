// @vitest-environment happy-dom
//
// Issue 303, redone 2026-09-03 — THE EMAILS TAB SAYS WHO SENDS WHAT.
//
// THE FIRST DEFECT (issue 303): the card at the bottom of Settings › Emails
// printed the LOCATION's sending identity under a per-sequence toggle, so at
// loc_kc it said "Lynette Ewy" beneath the moving emails that go out as Carol.
//
// THE SECOND DEFECT (this rewrite): the 303 fix made the card follow that
// toggle — but the toggle sits at the TOP of "Every email a client can
// receive" and the card sits BELOW the whole list, several screens down. An
// owner reading "Every one of the organizing emails goes out as Lynette Ewy"
// at the bottom of the page had no visible sign that a second answer existed.
// Kansas City read it, concluded Lynette sends everything, and complained,
// while Carol's moving emails were going out as Carol the whole time.
//
// THE RULE NOW: the card lists EVERY kind of job that has a sender of its own
// — who it goes out as, and where replies go — then "Everything else". It
// reads the same whatever the toggle says. One read, the whole answer.
//
// 2026-10-30 — THE CARD IS GONE, THE RULE IS NOT. The Emails screen design
// moved the per-type controls themselves to the top of Emails ("Sending",
// beside the main address). These tests now hold the SAME rule against those
// rows: every kind of job, its own sender and address, no toggle involved,
// and nothing guessed when the read fails.
//
// WHY A MOUNTING TEST AND NOT A TYPE. components/BeeHub.jsx is .jsx and
// tsconfig's `include` has no .jsx — nothing in that file is type-checked. A
// dropped prop, a card that quietly starts following the toggle again, a copy
// edit that reinstates "every one of these goes out as" — none of it fails a
// compiler. Only a test that mounts the real screen can see it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '132b42c2-0000-4000-8000-000000000001'

// loc_kc's location-level trio, as production holds it (verified 2026-09-03).
const selectedLoc = (over: any = {}) => ({
  id: LOC_UUID,
  name: 'Kansas City',
  street: '1 Main St', city: 'Kansas City', state: 'MO', zip: '64106',
  phone: '(816) 555-0100',
  bookingLink: '', reviewsLink: '', ratePerHour: '', serviceRadius: '25 miles',
  timezone: 'America/Chicago', assessmentType: 'in-person',
  smsEnabled: false, jobberConnected: false, jobberAccountId: null, crmStatus: 'active',
  sendFromName: 'Lynette Ewy',
  sendFromEmail: 'lynette@beeorganized.com',
  replyToEmail: 'lynette@beeorganized.com',
  ...over,
})

const personRow = (type: string, name: string, email: string, uid: string, handler_active = true) => ({
  id: `a-${type}`, project_type: type,
  sender_name: name, sender_email: email, sender_reply_to: null,
  sender_is_custom: false, source_user_id: uid, domain_warning: false, handler_active,
})

// The four active types and the four handler rows loc_kc actually has.
const KC_CONFIG = () => ({
  base_sender_email: 'lynette@beeorganized.com',
  base_sender_domain: 'beeorganized.com',
  project_types: ['Home or Office Organizing', 'Moving/Relocation', 'Concierge Services', 'Other'],
  project_type_groups: [
    { label: 'Home or Office Organizing', drip_category: 'general' },
    { label: 'Moving/Relocation', drip_category: 'move' },
    { label: 'Concierge Services', drip_category: 'general' },
    { label: 'Other', drip_category: 'general' },
  ],
  assignments: [
    personRow('Home or Office Organizing', 'Lynette Ewy', 'lynette@beeorganized.com', 'u-lynette'),
    personRow('Moving/Relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol'),
    personRow('Concierge Services', 'Lynette Ewy', 'lynette@beeorganized.com', 'u-lynette'),
    personRow('Other', 'Lynette Ewy', 'lynette@beeorganized.com', 'u-lynette'),
  ],
  people: [],
})

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.stubGlobal('alert', vi.fn())
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// Every GET the Settings screen fires answers with an empty object except the
// sender config, which is the payload under test.
const mount = async (cfg: any = KC_CONFIG(), { sendersOk = true, loc = selectedLoc() } = {}) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('project-type-senders')) {
      return { ok: sendersOk, status: sendersOk ? 200 : 500, json: async () => cfg }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  }))
  await act(async () => { root.render(<SettingsScreen selectedLoc={loc} initialSection="emails" />) })
  await act(async () => {})
  await act(async () => {})
  return container
}

const sending = () => container.querySelector('#sender') as HTMLElement
const rowFor = (t: string) => sending()?.querySelector(`[data-handler-row="${t}"]`) as HTMLElement
const rowText = (t: string) => (rowFor(t)?.textContent || '').replace(/\s+/g, ' ')
const pill = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label) as HTMLButtonElement

describe('THE DEFECT — Emails names every configured kind of job, not one family', () => {
  it('names Carol for Moving with NO toggle touched', async () => {
    await mount()
    expect(rowFor('Moving/Relocation'), 'a row for Moving/Relocation').toBeTruthy()
    expect(rowText('Moving/Relocation')).toContain('Carol Kern')
    expect(rowText('Moving/Relocation')).toContain('carol@beeorganized.com')
  })

  it('lists EVERY kind of job with its own sender — all four at loc_kc', async () => {
    await mount()
    for (const t of ['Home or Office Organizing', 'Moving/Relocation', 'Concierge Services', 'Other']) {
      expect(rowFor(t), `a row for ${t}`).toBeTruthy()
    }
    expect(rowText('Home or Office Organizing')).toContain('Lynette Ewy')
  })

  it('the Organizing / Moving view does NOT change who a job type goes out as', async () => {
    await mount(KC_CONFIG(), { loc: selectedLoc() })
    const before = ['Home or Office Organizing', 'Moving/Relocation'].map(rowText)
    const moving = pill('Moving')
    if (moving) await act(async () => { moving.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(['Home or Office Organizing', 'Moving/Relocation'].map(rowText)).toEqual(before)
  })
})

describe('REPLIES — a shared mailbox says where replies go', () => {
  it('a shared mailbox keeps its own reply-to, unchanged', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments[1] = { ...cfg.assignments[1], sender_is_custom: true, sender_name: 'KC Moving', sender_email: 'moving@beeorganized.com', sender_reply_to: 'movingdesk@beeorganized.com' }
    await mount(cfg)
    expect(rowText('Moving/Relocation')).toContain('KC Moving <moving@beeorganized.com>')
    expect(rowText('Moving/Relocation')).toContain('replies to movingdesk@beeorganized.com')
  })
})

describe('EVERYTHING ELSE — the main address, labelled, beside the rows', () => {
  it('says that anything else goes out from the main address, and the main address is there and editable', async () => {
    await mount()
    const txt = (sending()?.textContent || '').replace(/\s+/g, ' ')
    expect(txt).toContain('Anything else goes out from the main address below.')
    const input = sending().querySelector('#field-from-email') as HTMLInputElement
    expect(input.value).toBe('lynette@beeorganized.com')
    expect(input.readOnly).toBe(false)
  })
})

describe('NEVER GUESSES', () => {
  it('a failed read names nobody for any job type', async () => {
    await mount(KC_CONFIG(), { sendersOk: false })
    expect(sending().querySelector('[data-handler-row]')).toBeNull()
    expect(sending().textContent).not.toContain('Carol Kern')
  })
})
