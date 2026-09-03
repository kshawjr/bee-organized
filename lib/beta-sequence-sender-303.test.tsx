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

const card = () => container.querySelector('[data-sequence-sender-card]') as HTMLElement
const cardText = () => (card()?.textContent || '').replace(/\s+/g, ' ')
// The half that reads the payload. The location's own identity lives in the
// editable rows below and is legitimately always present, so "Lynette is not
// the answer for Moving" is only a meaningful claim about this region.
const answer = () => container.querySelector('[data-sender-answer]') as HTMLElement
const answerText = () => (answer()?.textContent || '').replace(/\s+/g, ' ')
const pill = (label: string) =>
  Array.from(container.querySelectorAll('button')).find(b => (b.textContent || '').trim() === label) as HTMLButtonElement
const clickPill = async (label: string) => {
  const b = pill(label)
  expect(b, `the ${label} toggle`).toBeTruthy()
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => {})
}
const typeRow = (t: string) => card().querySelector(`[data-sender-for="${t}"]`) as HTMLElement
const typeRowText = (t: string) => (typeRow(t)?.textContent || '').replace(/\s+/g, ' ')

// ═══════════════════════════════════════════════════════════════════════════
describe('THE DEFECT — the card names every configured kind of job, not one family', () => {
  it('names Carol for Moving with NO toggle touched', async () => {
    await mount()
    expect(typeRow('Moving/Relocation'), 'a line for Moving/Relocation').toBeTruthy()
    expect(typeRowText('Moving/Relocation')).toContain('Carol Kern')
    expect(typeRowText('Moving/Relocation')).toContain('carol@beeorganized.com')
  })

  it('lists EVERY kind of job with its own sender — all four at loc_kc', async () => {
    await mount()
    for (const t of ['Home or Office Organizing', 'Moving/Relocation', 'Concierge Services', 'Other']) {
      expect(typeRow(t), t).toBeTruthy()
    }
    expect(typeRowText('Home or Office Organizing')).toContain('Lynette Ewy')
    expect(typeRowText('Concierge Services')).toContain('Lynette Ewy')
    expect(typeRowText('Other')).toContain('Lynette Ewy')
    expect(typeRowText('Moving/Relocation')).toContain('Carol Kern')
  })

  it('never claims one sender for everything', async () => {
    await mount()
    const txt = cardText()
    expect(txt).not.toContain('Every one of the organizing emails goes out as')
    expect(txt).not.toContain('Every one of the moving emails goes out as')
    expect(txt).not.toContain('Every one of these emails goes out as')
  })

  it('the Organizing / Moving toggle at the top of the list does NOT change the card', async () => {
    // The toggle still drives the sequence list above. The card is a whole
    // page below it and must read the same either way.
    await mount()
    const before = answerText()
    expect(before).toContain('Carol Kern')
    await clickPill('Moving')
    expect(answerText()).toBe(before)
    await clickPill('Organizing')
    expect(answerText()).toBe(before)
  })

  it('the section label no longer points at one family', async () => {
    await mount()
    const txt = container.textContent || ''
    expect(txt).toContain('Who your emails come from')
    expect(txt).not.toContain('Who the organizing emails come from')
    expect(txt).not.toContain('Who the moving emails come from')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('REPLIES — each line says where they go, and it is the sender', () => {
  it('a person-mode sender gets the replies, not the location', async () => {
    // Kevin, 2026-09-03: if an email sends as someone, replies come back to
    // them. Before this every Moving email at loc_kc said "From: Carol Kern"
    // and every reply landed with Lynette.
    await mount()
    expect(typeRowText('Moving/Relocation')).toContain('Replies go to carol@beeorganized.com')
    expect(typeRowText('Moving/Relocation')).not.toContain('lynette@beeorganized.com')
  })

  it('a shared mailbox keeps its own reply-to, unchanged', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments[1] = {
      ...personRow('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'u-carol'),
      sender_is_custom: true,
      sender_reply_to: 'carol@beeorganized-kc.com',
    }
    await mount(cfg)
    const txt = typeRowText('Moving/Relocation')
    expect(txt).toContain('Bee Organized Moving')
    expect(txt).toContain('moving@beeorganized-kc.com')
    expect(txt).toContain('a shared mailbox, not one person')
    expect(txt).toContain('Replies go to carol@beeorganized-kc.com')
    expect(txt, 'the handler is not who the mail says it is from').not.toContain('Carol Kern')
  })

  it('a shared mailbox left blank still replies to the location, unchanged', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments[1] = {
      ...personRow('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'u-carol'),
      sender_is_custom: true, sender_reply_to: null,
    }
    await mount(cfg)
    expect(typeRowText('Moving/Relocation')).toContain('Replies go to lynette@beeorganized.com')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('EVERYTHING ELSE — shown, labelled, and honest about when it applies', () => {
  it('the location default is present, labelled, and still editable', async () => {
    await mount()
    const txt = cardText()
    expect(txt).toContain('Everything else')
    expect(txt).toContain('under the name and address below')
    expect(txt).toContain('Send From Name')
    expect(txt).toContain('Send From Email')
    expect(txt).toContain('Reply-To Email')
  })

  it('does NOT claim the fallback is unused just because every type is handled', async () => {
    // lib/resend.ts consults handler rows only `if (senderProjectType)`, so a
    // lead carrying no job type — or one that canonicalizes to nothing, like
    // the manual-create path's 'Client' — never reaches a handler row at all.
    // That is most leads. The fallback is the location's MOST-used sender.
    await mount()
    const txt = cardText().toLowerCase()
    expect(txt).toContain('without a kind of job')
    for (const lie of ['never used', 'not used', 'applies to nothing', 'nothing uses this']) {
      expect(txt, `must not claim "${lie}"`).not.toContain(lie)
    }
  })

  it('a location with NO per-type sender says so in one sentence and lists nothing', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments = []
    await mount(cfg)
    expect(answerText()).toContain('Every email goes out as your own sending name and address, below')
    expect(card().querySelectorAll('[data-sender-for]')).toHaveLength(0)
  })

  it('a kind of job with no handler is not listed — it is everything else', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments = [cfg.assignments[1]]   // moving only; organizing unhandled
    await mount(cfg)
    expect(typeRow('Moving/Relocation')).toBeTruthy()
    expect(typeRow('Home or Office Organizing')).toBeNull()
    expect(typeRow('Concierge Services')).toBeNull()
    expect(typeRow('Other')).toBeNull()
  })

  it('an offboarded person-mode handler drops off the list and is not named', async () => {
    // The send path drops that row (lib/project-type-handlers.ts), so the mail
    // really does go out as the location. The config row still says "Carol".
    const cfg = KC_CONFIG()
    cfg.assignments[1] = personRow('Moving/Relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol', false)
    await mount(cfg)
    expect(typeRow('Moving/Relocation')).toBeNull()
    expect(answerText()).not.toContain('Carol Kern')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('IT REPORTS — New leads still DECIDES', () => {
  it('carries no per-type sender controls of its own', async () => {
    await mount()
    expect(card().querySelectorAll('select')).toHaveLength(0)
    expect(cardText()).not.toContain('Who handles it')
    expect(cardText()).not.toContain('What it sends as')
  })

  it('links out to where the decision is made, by name and not by URL', async () => {
    await mount()
    const link = Array.from(card().querySelectorAll('button'))
      .find(b => (b.textContent || '').includes('Change who handles a kind of job'))
    expect(link).toBeTruthy()
    expect(cardText()).not.toContain('/settings')
  })

  it('never guesses while the payload is in flight or after it fails', async () => {
    // Falling back to the location default on a failed read would print the
    // exact sentence this card exists to never print.
    await mount(KC_CONFIG(), { sendersOk: false })
    const txt = cardText()
    expect(txt).toContain('could not check')
    expect(txt).not.toContain('goes out as')
    expect(card().querySelectorAll('[data-sender-for]')).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('layout', () => {
  it('the link out is capped, not stretched', async () => {
    await mount()
    const link = Array.from(card().querySelectorAll('button'))
      .find(b => (b.textContent || '').includes('Change who handles a kind of job')) as HTMLElement
    expect(link.style.maxWidth).toBeTruthy()
  })
})
