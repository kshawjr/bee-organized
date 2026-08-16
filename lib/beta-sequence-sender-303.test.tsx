// @vitest-environment happy-dom
//
// Issue 303 — THE EMAILS TAB SAYS WHO THESE EMAILS ACTUALLY COME FROM.
//
// THE DEFECT, in Kevin's words: "who is the email actually coming from on
// move". He could not tell from the screen, and he built it.
//
// At loc_kc with MOVING selected, the tab read:
//     Every email a client can receive   [Organizing | Moving]
//     …the four moving emails…
//     WHO THESE COME FROM
//     Sending identity — Lynette Ewy, lynette@beeorganized.com
// Carol Kern sends the moving emails. The card was a LOCATION-level default
// rendered under a PER-SEQUENCE toggle: true about itself, false about its
// context, with a section label pointing the falsehood straight at the four
// emails above it. `view` was private state inside EmailsList and the card is a
// SIBLING later in the same section, so it could not know a toggle existed.
//
// WHY A MOUNTING TEST AND NOT A TYPE. components/BeeHub.jsx is .jsx and
// tsconfig's `include` is ["next-env.d.ts", "**/*.ts", "**/*.tsx",
// ".next/types/**/*.ts"] — no .jsx. Nothing in that 37k-line file is
// type-checked. A dropped `view` prop, a card that stops reading the payload,
// a copy edit that reinstates "your default sending identity" — none of it
// fails a compiler. Only a test that mounts the real screen can see it, which
// is the same conclusion issue 296 reached.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const LOC_UUID = '132b42c2-0000-4000-8000-000000000001'

// loc_kc's location-level trio, as production holds it (verified 2026-08-15).
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
// The half that must track the toggle. The location's own identity lives in the
// editable rows below and legitimately does NOT move, so "Lynette is gone under
// Moving" is only a meaningful claim about this region.
const answer = () => container.querySelector('[data-sequence-answer]') as HTMLElement
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

// ═══════════════════════════════════════════════════════════════════════════
describe('THE DEFECT — the card answers for the sequence on screen', () => {
  it('with MOVING selected, the card names Carol', async () => {
    await mount()
    await clickPill('Moving')
    expect(cardText()).toContain('Carol Kern')
    expect(cardText()).toContain('carol@beeorganized.com')
  })

  it('with ORGANIZING selected, the card names Lynette', async () => {
    await mount()
    expect(cardText()).toContain('Lynette Ewy')
    expect(cardText()).toContain('lynette@beeorganized.com')
  })

  it('SWITCHING THE TOGGLE UPDATES THE CARD', async () => {
    // The assertion the whole issue is about. Before the fix the card was a
    // sibling of the component holding `view`, so this text never changed.
    await mount()
    const organizing = answerText()
    expect(organizing).toContain('Lynette Ewy')

    await clickPill('Moving')
    const moving = answerText()
    expect(moving, 'the card must not be frozen across the toggle').not.toBe(organizing)
    expect(moving).toContain('Carol Kern')
    expect(moving, 'the location default must not be named as the answer').not.toContain('Lynette Ewy')

    await clickPill('Organizing')
    expect(answerText()).toContain('Lynette Ewy')
    expect(answerText()).not.toContain('Carol Kern')
  })

  it('the section label names the sequence rather than pointing vaguely', async () => {
    // "WHO THESE COME FROM" was accurate about the card and wrong about the
    // page. Under a toggle, "these" has two possible referents.
    await mount()
    expect((container.textContent || '')).toContain('Who the organizing emails come from')
    await clickPill('Moving')
    expect((container.textContent || '')).toContain('Who the moving emails come from')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('A FAMILY IS ONE-TO-MANY — build for the list', () => {
  it('a family whose types resolve to DIFFERENT senders LISTS them', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments[2] = personRow('Concierge Services', 'Carol Kern', 'carol@beeorganized.com', 'u-carol')
    await mount(cfg)

    // Every type in the family is named, with its own answer beside it.
    for (const t of ['Home or Office Organizing', 'Concierge Services', 'Other']) {
      expect(typeRow(t), t).toBeTruthy()
    }
    expect(typeRow('Concierge Services').textContent).toContain('Carol Kern')
    expect(typeRow('Home or Office Organizing').textContent).toContain('Lynette Ewy')
    expect(typeRow('Other').textContent).toContain('Lynette Ewy')
  })

  it('and does NOT present a single name when they disagree', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments[2] = personRow('Concierge Services', 'Carol Kern', 'carol@beeorganized.com', 'u-carol')
    await mount(cfg)
    const txt = cardText()
    // No "every one of these goes out as X" sentence — that claim is false here.
    expect(txt).not.toContain('Every one of the organizing emails goes out as')
    expect(txt).toContain('It depends on the kind of job')
    // Neither name is dropped in favour of the other, and the location default
    // is not substituted to avoid the list.
    expect(txt).toContain('Carol Kern')
    expect(txt).toContain('Lynette Ewy')
  })

  it('a moving family with a second type stops having one answer', async () => {
    // Move-In Organization is inactive today, drip_category 'move'. Switching
    // it on must turn Moving into a list rather than keep naming Carol.
    const cfg = KC_CONFIG()
    cfg.project_type_groups.push({ label: 'Move-In Organization', drip_category: 'move' })
    await mount(cfg)
    await clickPill('Moving')
    expect(typeRow('Moving/Relocation').textContent).toContain('Carol Kern')
    expect(typeRow('Move-In Organization')).toBeTruthy()
    expect(typeRow('Move-In Organization').textContent).not.toContain('Carol Kern')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('TYPED SENDERS (issue 296) — the mailbox, not the handler', () => {
  it('a type in typed mode shows the typed address, not the handler’s', async () => {
    // A row reading "Carol Kern" when the mail actually says
    // moving@beeorganized-kc.com is issue 303's defect in a new place.
    const cfg = KC_CONFIG()
    cfg.assignments[1] = {
      ...personRow('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'u-carol'),
      sender_is_custom: true,
      sender_reply_to: 'carol@beeorganized-kc.com',
    }
    await mount(cfg)
    await clickPill('Moving')

    const txt = cardText()
    expect(txt).toContain('moving@beeorganized-kc.com')
    expect(txt).toContain('Bee Organized Moving')
    expect(txt, 'the handler is not who the mail says it is from').not.toContain('Carol Kern,')
    // Its own reply-to is shown where one is set.
    expect(txt).toContain('carol@beeorganized-kc.com')
  })

  it('says a shared mailbox is not a person', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments[1] = {
      ...personRow('Moving/Relocation', 'Bee Organized Moving', 'moving@beeorganized-kc.com', 'u-carol'),
      sender_is_custom: true, sender_reply_to: null,
    }
    await mount(cfg)
    await clickPill('Moving')
    expect(cardText()).toContain('a shared mailbox, not one person')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('THE FALLBACK — shown, labelled, and honest about when it applies', () => {
  it('the location default is present and labelled as the fallback', async () => {
    await mount()
    const txt = cardText()
    expect(txt).toContain('Everything else')
    expect(txt).toContain('go out under the name and address below')
    // And it is still the editable location identity, unchanged.
    expect(txt).toContain('Send From Name')
    expect(txt).toContain('Send From Email')
    expect(txt).toContain('Reply-To Email')
  })

  it('does NOT claim the fallback is unused just because every type is handled', async () => {
    // THE PREMISE THIS TEST EXISTS TO REFUTE. "At loc_kc it currently applies to
    // nothing, since every type has a handler" is false. lib/resend.ts consults
    // handler rows only `if (senderProjectType)`, so a lead carrying no job type
    // — or one that canonicalizes to nothing, like the manual-create path's
    // 'Client' — never reaches a handler row at all. At loc_kc that is 3,346 of
    // 3,391 leads. The fallback is the location's MOST-used sender, and copy
    // saying otherwise would be a fresh lie in the place we just fixed one.
    await mount()
    const txt = cardText().toLowerCase()
    expect(txt).toContain('without a kind of job')
    for (const lie of ['never used', 'not used', 'applies to nothing', 'nothing uses this']) {
      expect(txt, `must not claim "${lie}"`).not.toContain(lie)
    }
  })

  it('a type with no handler shows the location default for that type', async () => {
    const cfg = KC_CONFIG()
    cfg.assignments = [cfg.assignments[1]]   // moving only; organizing unhandled
    await mount(cfg)
    expect(cardText()).toContain('your own sending name and address, below')
  })

  it('a person-mode type whose handler is offboarded falls back, and does not name them', async () => {
    // The send path drops that row (lib/project-type-handlers.ts), so the mail
    // really does go out as the location. The config row still says "Carol".
    const cfg = KC_CONFIG()
    cfg.assignments[1] = personRow('Moving/Relocation', 'Carol Kern', 'carol@beeorganized.com', 'u-carol', false)
    await mount(cfg)
    await clickPill('Moving')
    expect(answerText()).not.toContain('Carol Kern')
    expect(answerText()).toContain('your own sending name and address, below')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('IT REPORTS — New leads still DECIDES', () => {
  it('carries no per-type sender controls of its own', async () => {
    await mount()
    expect(card().querySelectorAll('select')).toHaveLength(0)
    // The three location rows are edit-on-click and own the only inputs here.
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
    // exact sentence this issue exists to delete.
    await mount(KC_CONFIG(), { sendersOk: false })
    await clickPill('Moving')
    const txt = cardText()
    expect(txt).toContain('could not check')
    expect(txt).not.toContain('Every one of the moving emails goes out as')
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
