// @vitest-environment happy-dom
//
// LET A JOB CHOOSE WHICH ADDRESS IT GOES TO.
//
// The two-address feature (d8aa5ef) models a MOVE: the vacated address drops
// into leads.former_addresses and every new job attaches to the new one. But
// Jobber has no such hierarchy — a client just has properties, all equally
// live and bookable — and a client can genuinely have work at both houses
// while moving. Linette Voytovich's client Heather Popelka has an open quote
// at the address Bee Hub filed as former; she could not book it.
//
// So the send now ASKS which address, defaulting to the current one. What
// these tests pin:
//
//   · ONE address → no question, no extra click, no new key in the body.
//     This is the whole product promise for every other client, so it is
//     pinned on the wizard (no step, no picker) AND on the pure chooser.
//   · TWO addresses → the picker appears, the CURRENT one is preselected.
//   · A send to the second address resolves the property that ALREADY
//     EXISTS in Jobber — by the id captured at the move, falling back to a
//     street match — and NEVER creates one. Creating would duplicate the
//     old house and orphan the live quote sitting on the real property.
//   · A former-address send does NOT re-point leads.jobber_property_id.
//     Three paths match a lead by that column (PROPERTY_DESTROY nulls the
//     link on a match, the landed-webhook check, and the correction flow's
//     targeted propertyEdit), so moving it would let a destroy of the old
//     property null the live link.
//
// The route itself is an ~1150-line Next handler over live Jobber GraphQL;
// these read its SOURCE for the four decisions above (the convention
// beta-screen-map / beta-webhook-landed use for the same reason) and test
// the pure chooser and the wizard for real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import SendToJobberModal from '@/components/hive/SendToJobberModal'
import {
  buildAddressChoices,
  resolveAddressChoice,
  isFormerChoiceKey,
  CURRENT_CHOICE_KEY,
} from '@/lib/address-choice'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const ROUTE = 'app/api/leads/[id]/send-to-jobber/route.ts'
const routeSrc = readFileSync(ROUTE, 'utf8')

// Heather's shape: current = the new house, former = the original one with
// the Jobber property it IS (captured by the move).
const CURRENT = { address: '4402 Kirkwood Dr', city: 'Wexford', state: 'PA', zip: '15090' }
const FORMER = {
  street: '118 Elmhurst Rd',
  city: 'Pittsburgh',
  state: 'PA',
  zip: '15237',
  display: '118 Elmhurst Rd, Pittsburgh, PA 15237',
  jobber_property_id: '90210',
  moved_at: '2026-09-02T00:00:00Z',
}

// ═══ 1) the pure chooser ═══════════════════════════════════════
describe('buildAddressChoices — one address is the unchanged case', () => {
  it('a client with one address yields exactly one choice, and it is current', () => {
    const choices = buildAddressChoices(CURRENT, '111', [])
    expect(choices).toHaveLength(1)
    expect(choices[0].key).toBe(CURRENT_CHOICE_KEY)
    expect(choices[0].isCurrent).toBe(true)
    expect(choices[0].jobberPropertyId).toBe('111')
  })

  it('a pre-migration row (former_addresses undefined) is the one-address case', () => {
    expect(buildAddressChoices(CURRENT, '111', undefined)).toHaveLength(1)
    expect(buildAddressChoices(CURRENT, '111', null)).toHaveLength(1)
    // and junk in the column does not manufacture a choice
    expect(buildAddressChoices(CURRENT, '111', [{ nope: true }, null])).toHaveLength(1)
  })

  it('a lead with no address at all yields no choices — the route address guard still speaks', () => {
    expect(buildAddressChoices({ address: '', city: '', state: '', zip: '' }, null, [])).toHaveLength(0)
  })
})

describe('buildAddressChoices — two addresses', () => {
  it('lists current FIRST, then the second address, carrying its Jobber property', () => {
    const choices = buildAddressChoices(CURRENT, '111', [FORMER])
    expect(choices).toHaveLength(2)
    expect(choices[0].isCurrent).toBe(true)
    expect(choices[0].display).toBe('4402 Kirkwood Dr, Wexford, PA 15090')
    expect(choices[1].key).toBe('former:0')
    expect(choices[1].isCurrent).toBe(false)
    expect(choices[1].display).toBe('118 Elmhurst Rd, Pittsburgh, PA 15237')
    expect(choices[1].jobberPropertyId).toBe('90210')
    expect(choices[1].street).toBe('118 Elmhurst Rd')
  })

  it('the default — absent or "current" — is always the current address', () => {
    const choices = buildAddressChoices(CURRENT, '111', [FORMER])
    expect(resolveAddressChoice(choices, undefined)!.isCurrent).toBe(true)
    expect(resolveAddressChoice(choices, '')!.isCurrent).toBe(true)
    expect(resolveAddressChoice(choices, CURRENT_CHOICE_KEY)!.isCurrent).toBe(true)
  })

  it('a key naming nothing this lead holds resolves to null — never silently to the other house', () => {
    const choices = buildAddressChoices(CURRENT, '111', [FORMER])
    expect(resolveAddressChoice(choices, 'former:7')).toBeNull()
    expect(resolveAddressChoice(choices, 'former:0')!.display).toBe(FORMER.display)
  })

  it('isFormerChoiceKey separates the default from a real second-address pick', () => {
    expect(isFormerChoiceKey(undefined)).toBe(false)
    expect(isFormerChoiceKey('current')).toBe(false)
    expect(isFormerChoiceKey('former:0')).toBe(true)
  })
})

// ═══ 2) the wizard ═════════════════════════════════════════════
describe('the Send-to-Jobber wizard — the picker', () => {
  let host: HTMLDivElement
  let root: Root
  let posts: any[] = []

  const person = (over: any = {}) => ({
    id: 'p1',
    name: 'Heather Popelka',
    outreachTimeline: [],
    assessment: null,
    assessmentType: 'in-person',
    address: '4402 Kirkwood Dr',
    originCity: 'Wexford',
    originState: 'PA',
    originZip: '15090',
    addresses: [{ street: '4402 Kirkwood Dr' }],
    formerAddresses: [],
    jobberClient: null,
    locationName: 'North Pittsburgh',
    ...over,
  })

  const mount = async (props: any = {}) => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<SendToJobberModal person={person(props.person)} onDone={() => {}} onClose={() => {}} />)
    })
  }

  beforeEach(() => {
    posts = []
    global.fetch = vi.fn(async (url: any, opts: any = {}) => {
      const u = String(url)
      if (u.includes('/send-to-jobber') && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body))
        return {
          ok: true, status: 200,
          json: async () => ({ success: true, match_status: 'matched_existing', jobber_client_id: '555', jobber_request_id: '777' }),
        } as any
      }
      return { ok: true, status: 200, json: async () => ({}) } as any
    }) as any
  })

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    if (host) host.remove()
    vi.restoreAllMocks()
  })

  const buttons = () => Array.from(host.querySelectorAll('button'))
  const contains = (t: string) => buttons().find(b => (b.textContent || '').includes(t))
  const byText = (t: string) => buttons().find(b => (b.textContent || '').trim() === t)
  const aria = (l: string) => buttons().find(b => b.getAttribute('aria-label') === l)
  const picker = () => host.querySelector('[data-address-picker]')
  const choice = (k: string) => host.querySelector(`[data-address-choice="${k}"]`) as HTMLButtonElement | null

  const pickRequest = async () => {
    await act(async () => { aria('Create a Request')!.click() })
    await act(async () => { contains('Continue')!.click() })
  }

  // ── one address: unchanged ──────────────────────────────────
  it('ONE address — no picker, and the action step goes straight to the details step', async () => {
    await mount()
    await pickRequest()
    expect(picker(), 'no picker anywhere in the flow').toBeNull()
    expect(host.textContent).not.toContain('Which address is this for?')
    expect(host.querySelector('button[aria-label="Include assessment"]'), 'landed on request-details').toBeTruthy()
  })

  it('ONE address — the progress bar still has the same number of steps', async () => {
    await mount()
    // action → request-details → confirm (no jobberClient, so no history step)
    expect(host.querySelectorAll('[data-step-seg]')).toHaveLength(3)
  })

  it('ONE address — the POST body carries NO property_choice at all', async () => {
    await mount()
    await pickRequest()
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    expect(posts).toHaveLength(1)
    expect(posts[0]).toEqual({ creation_type: 'request_only' })
    expect('property_choice' in posts[0]).toBe(false)
  })

  // ── two addresses: the question ─────────────────────────────
  it('TWO addresses — the picker appears between action and details, and defaults to current', async () => {
    await mount({ person: { formerAddresses: [FORMER] } })
    await pickRequest()
    expect(picker(), 'the picker step').toBeTruthy()
    expect(host.textContent).toContain('Which address is this for?')
    expect(choice('current')!.getAttribute('aria-checked')).toBe('true')
    expect(choice('former:0')!.getAttribute('aria-checked')).toBe('false')
    // the current one is labelled as such, and both addresses are readable
    expect(host.textContent).toContain('4402 Kirkwood Dr, Wexford, PA 15090')
    expect(host.textContent).toContain('118 Elmhurst Rd, Pittsburgh, PA 15237')
    expect(host.textContent).toContain('Current')
  })

  it('TWO addresses — the progress bar gains exactly one step', async () => {
    await mount({ person: { formerAddresses: [FORMER] } })
    expect(host.querySelectorAll('[data-step-seg]')).toHaveLength(4)
  })

  it('TWO addresses — accepting the default sends property_choice "current"', async () => {
    await mount({ person: { formerAddresses: [FORMER] } })
    await pickRequest()
    await act(async () => { contains('Continue')!.click() })
    await act(async () => { contains('Review')!.click() })
    await act(async () => { contains('Send to Jobber')!.click() })
    expect(posts[0].property_choice).toBe('current')
  })

  it('TWO addresses — picking the second address sends its key, and the confirm names it', async () => {
    await mount({ person: { formerAddresses: [FORMER] } })
    await pickRequest()
    await act(async () => { choice('former:0')!.click() })
    expect(choice('former:0')!.getAttribute('aria-checked')).toBe('true')
    expect(choice('current')!.getAttribute('aria-checked')).toBe('false')
    await act(async () => { contains('Continue')!.click() })
    await act(async () => { contains('Review')!.click() })
    // the confirm must name the house it is about to send to — the last
    // place a wrong address could hide before real records are created
    expect(host.textContent).toContain('118 Elmhurst Rd, Pittsburgh, PA 15237')
    await act(async () => { contains('Send to Jobber')!.click() })
    expect(posts[0].property_choice).toBe('former:0')
    expect(posts[0].creation_type).toBe('request_only')
  })

  it('TWO addresses — Back from the details step returns to the picker, keeping the pick', async () => {
    await mount({ person: { formerAddresses: [FORMER] } })
    await pickRequest()
    await act(async () => { choice('former:0')!.click() })
    await act(async () => { contains('Continue')!.click() })
    await act(async () => { byText('Back')!.click() })
    expect(picker(), 'back on the picker, not the action step').toBeTruthy()
    expect(choice('former:0')!.getAttribute('aria-checked')).toBe('true')
  })

  it('TWO addresses — the picker sits on the JOB path too, and the job confirm names the property', async () => {
    await mount({ person: { formerAddresses: [FORMER] } })
    await act(async () => { aria('Create a Job')!.click() })
    await act(async () => { contains('Continue')!.click() })
    expect(picker(), 'the job path asks the same question').toBeTruthy()
    await act(async () => { choice('former:0')!.click() })
    await act(async () => { contains('Continue')!.click() })
    // job-details → confirm
    const inputs = Array.from(host.querySelectorAll('input')) as HTMLInputElement[]
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(inputs[0], 'Organize garage'); inputs[0].dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { setter.call(inputs[1], '450'); inputs[1].dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => { contains('Review')!.click() })
    // the generic "Uses the client's service address" would be the lie here
    expect(host.textContent).toContain('118 Elmhurst Rd, Pittsburgh, PA 15237')
    expect(host.textContent).not.toContain("Uses the client's service address")
  })
})

// ═══ 3) the route's four decisions ═════════════════════════════
describe('the send route — resolving the chosen property', () => {
  it('resolves the choice against the LEAD ROW, not against the string the client sent', () => {
    expect(routeSrc).toContain('buildAddressChoices(')
    expect(routeSrc).toContain('resolveAddressChoice(addressChoices, property_choice)')
    // built from the lead's own columns + former_addresses
    expect(routeSrc).toMatch(/buildAddressChoices\(\s*\{ address: lead\.address/)
    expect(routeSrc).toContain('lead.former_addresses')
  })

  it('a key the lead does not hold is a hard 400 — never a silent fall back to the other house', () => {
    expect(routeSrc).toMatch(/isFormerChoiceKey\(property_choice\) && !sendChoice/)
    expect(routeSrc).toContain('that address is no longer on this client')
  })

  it('the default path is byte-for-byte today: pickPrimaryAddress when not using a former address', () => {
    expect(routeSrc).toMatch(/usingFormerAddress\s*\?[\s\S]{0,200}:\s*pickPrimaryAddress\(lead\)/)
  })

  it('a former address resolves an EXISTING property — by captured id first, then street', () => {
    expect(routeSrc).toMatch(/usingFormerAddress && sendChoice\?\.jobberPropertyId/)
    expect(routeSrc).toContain("extractJobberId(p.id) === wantedId")
    // the street match survives as the fallback for entries predating the
    // id capture
    expect(routeSrc).toContain("(p.address?.street1 || '').trim().toLowerCase() === wantedStreet")
  })

  it('a former address NEVER creates a property — it fails before propertyCreate', () => {
    const guard = routeSrc.indexOf('!jobberPropertyGlobalId && usingFormerAddress')
    const create = routeSrc.indexOf('PROPERTY_CREATE_MUTATION,\n        {')
    expect(guard, 'the never-create guard exists').toBeGreaterThan(-1)
    expect(create, 'the create call exists').toBeGreaterThan(-1)
    expect(guard, 'and the guard returns BEFORE the create is reached').toBeLessThan(create)
    expect(routeSrc).toContain("is not one of this ")
  })

  it('a former-address send does NOT re-point leads.jobber_property_id', () => {
    expect(routeSrc).toMatch(
      /jobber_property_id:\s*usingFormerAddress\s*\?\s*\(lead\.jobber_property_id \?\? null\)\s*:\s*jobberPropertyId/,
    )
  })

  it('the sync_log row names the address on a second-address send — the answer Bee Hub keeps', () => {
    expect(routeSrc).toMatch(/usingFormerAddress \?[^\n]*property=\$\{jobberPropertyId\}/)
  })
})
