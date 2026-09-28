// @vitest-environment happy-dom
//
// "Start a new job" for an EXISTING client (2026-09-28). Kevin: "An existing
// client calls about a second job. Start in Bee Hub, not Jobber, so the
// conversation gets captured … Then it goes over to Jobber as a proper
// request." Two endings: Send to Jobber now, or Save — send to Jobber later.
//
// Pinned here (the screens):
//   1. what was typed reaches the engagement, exactly
//   2. Send now founds the card and opens THE Send to Jobber window for it
//      (the route side — existing Jobber client, no duplicate, request on
//      the card — is new-job-card-send.test.ts)
//   3. Save later tells the owner, AT THE CHOICE, that nothing reaches Jobber
//      until it is sent — and the card then reads "Not sent to Jobber" with
//      Send to Jobber on it
//   4. the wizard cannot save a blank job (the route and the founding
//      function refuse too: blank-engagement-*.test.ts)
//   5. a client with more than one address is asked which, once
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NewJobWizard, { SAVE_LATER_EXPLAINER, SAVED_TOAST } from '@/components/hive/NewJobWizard'
import SendToJobberModal from '@/components/hive/SendToJobberModal'
import ClientProfile from '@/components/hive/ClientProfile'
import { deriveStatusChip, isUnsentEngagement, NOT_SENT_LABEL } from '@/components/hive/shared/engagementStatus'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const CLIENT = {
  id: 'lead-9', name: 'Martha Wassel', address: '4402 Kirkwood Dr', city: 'Wexford', state: 'PA', zip: '15090',
  address_label: null, address_label_note: null,
}
const FORMER = {
  street: '118 Elmhurst Rd', city: 'Pittsburgh', state: 'PA', zip: '15237',
  display: '118 Elmhurst Rd, Pittsburgh, PA 15237', jobber_property_id: '90210', moved_at: '2026-09-02T00:00:00Z',
}

// ── fetch: the founding route answers like the real one ────────────────────
let posts: { url: string; body: any }[] = []
let foundResponse: () => { status: number; body: any }
const founded = (body: any) => ({
  id: 'eng-NEW', client_id: 'lead-9', stage: 'Request', founded_by: 'manual',
  title: body.title, description: body.description ?? null, created_at: new Date(now).toISOString(),
  service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [],
})
beforeEach(() => {
  posts = []
  foundResponse = () => ({ status: 201, body: null })
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    const body = opts.body ? JSON.parse(opts.body) : null
    if (opts.method === 'POST') posts.push({ url: u, body })
    if (u === '/api/engagements' && opts.method === 'POST') {
      const r = foundResponse()
      return { ok: r.status < 400, status: r.status, json: async () => r.body ?? { engagement: founded(body) } }
    }
    if (u.includes('/send-to-jobber')) {
      return { ok: true, status: 200, json: async () => ({ success: true, match_status: 'matched_existing', jobber_client_id: '136289662', jobber_request_id: '777' }) }
    }
    if (u.includes('/profile')) return { ok: true, status: 200, json: async () => profileBody }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  document.body.innerHTML = ''
})

let root: any = null
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return host
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const type = (el: Element, value: string) => act(async () => {
  const proto = el.tagName === 'TEXTAREA' ? (globalThis as any).window.HTMLTextAreaElement.prototype : (globalThis as any).window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const q = (sel: string) => document.querySelector(sel)
const btn = (text: string) => [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(text)) as HTMLButtonElement | undefined
const work = () => q('input[aria-label="What’s the work?"]')!
const said = () => q('textarea[aria-label="What did they say?"]')!
const sendNow = () => q('[data-ending="send-now"]') as HTMLButtonElement | null
const saveLater = () => q('[data-ending="save-later"]') as HTMLButtonElement | null
const engagementPosts = () => posts.filter(p => p.url === '/api/engagements')

const mountWizard = (over: any = {}) => {
  const props = {
    onFounded: vi.fn(), onSendToJobber: vi.fn(), setToast: vi.fn(), onClose: vi.fn(),
    ...over,
  }
  return mount(<NewJobWizard client={CLIENT} formerAddresses={[]} {...props} />).then(() => props)
}
const fillAndContinue = async (w: string, s = '') => {
  await type(work(), w)
  if (s) await type(said(), s)
  await click(btn('Continue')!)
}

// ═══ 1. what was typed reaches the engagement ══════════════════════════════
describe('the wizard captures the call and it reaches the engagement', () => {
  it('the work becomes the title, what they said becomes the description — exactly as typed', async () => {
    const p = await mountWizard()
    await fillAndContinue('  Primary bedroom closet ', 'Called Tuesday. Wants it before December.\nTold her we can assess next week.')
    // the recap shows what the card will carry
    expect(q('[data-recap]')!.textContent).toContain('Primary bedroom closet')
    expect(q('[data-recap]')!.textContent).toContain('Wants it before December.')
    await click(saveLater()!)
    expect(engagementPosts()).toHaveLength(1)
    expect(engagementPosts()[0].body).toEqual({
      client_id: 'lead-9',
      title: 'Primary bedroom closet',
      description: 'Called Tuesday. Wants it before December.\nTold her we can assess next week.',
    })
    // the REAL returned row goes up, not a stub
    expect(p.onFounded).toHaveBeenCalledTimes(1)
    expect(p.onFounded.mock.calls[0][0]).toMatchObject({ id: 'eng-NEW', title: 'Primary bedroom closet' })
  })

  it('what they said is optional — the work alone is enough', async () => {
    await mountWizard()
    await fillAndContinue('Garage shelving')
    await click(saveLater()!)
    expect(engagementPosts()[0].body).toEqual({ client_id: 'lead-9', title: 'Garage shelving', description: null })
  })

  it('warns when the client already has open work — this is a second card beside it', async () => {
    await mountWizard({ openCount: 1 })
    expect(q('[data-open-note]')!.textContent).toContain('already has 1 open engagement')
  })
})

// ═══ 2. Send to Jobber now ══════════════════════════════════════════════════
describe('Send to Jobber now', () => {
  it('founds the card FIRST, then hands THIS card to the Send to Jobber window', async () => {
    const order: string[] = []
    const onSendToJobber = vi.fn(() => order.push('send'))
    ;(globalThis as any).fetch.mockImplementationOnce(async (_u: any, opts: any) => {
      order.push('found'); posts.push({ url: '/api/engagements', body: JSON.parse(opts.body) })
      return { ok: true, status: 201, json: async () => ({ engagement: founded(JSON.parse(opts.body)) }) }
    })
    const p = await mountWizard({ onSendToJobber })
    await fillAndContinue('Primary bedroom closet', 'Wants it before December.')
    await click(sendNow()!)
    expect(order).toEqual(['found', 'send'])
    expect(onSendToJobber).toHaveBeenCalledWith('lead-9', { engagementId: 'eng-NEW', addressKey: null, savedCard: true })
    expect(p.onFounded).toHaveBeenCalledTimes(1)
    expect(p.onClose).toHaveBeenCalled()
  })

  it('the Send to Jobber window it opens creates the Jobber request ON that card', async () => {
    const person = { id: 'lead-9', name: 'Martha Wassel', jobberRef: '136289662', jobberClient: null, address: '4402 Kirkwood Dr',
      originCity: 'Wexford', originState: 'PA', originZip: '15090', addresses: [{ street: '4402 Kirkwood Dr' }], formerAddresses: [], outreachTimeline: [] }
    const onDone = vi.fn()
    await mount(<SendToJobberModal person={person} engagementId="eng-NEW" onDone={onDone} onClose={() => {}} />)
    expect(document.body.textContent).toContain('New work on their existing Jobber client · JC-136289662')
    await click(q('button[aria-label="Create a Request"]')!)
    await click(btn('Continue')!)
    await click(btn('Review')!)
    await click([...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('Send to Jobber')).pop()!)
    const sends = posts.filter(p => p.url.includes('/send-to-jobber'))
    expect(sends).toHaveLength(1)
    expect(sends[0].url).toBe('/api/leads/lead-9/send-to-jobber')
    expect(sends[0].body).toEqual({ creation_type: 'request_only', engagement_id: 'eng-NEW' })
    expect(onDone).toHaveBeenCalled()
  })

  it('backing out of that send leaves a saved card, and the owner is told it is not in Jobber', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    const at = src.indexOf('Backed out of a new-job wizard')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at, at + 400)).toContain("if (betaSendPerson.savedCard) setToast({ kind:'success', msg:'Saved on the card — not sent to Jobber yet.")
  })

  it('is not offered when no send is wired — only the save', async () => {
    await mountWizard({ onSendToJobber: null })
    await fillAndContinue('Garage shelving')
    expect(sendNow()).toBeNull()
    expect(saveLater()).toBeTruthy()
  })
})

// ═══ 3. Save and send later ═════════════════════════════════════════════════
describe('Save — send to Jobber later', () => {
  it('says what it means AT the choice: a record here, nothing in Jobber until it is sent', async () => {
    await mountWizard()
    await fillAndContinue('Garage shelving')
    const choice = saveLater()!
    // The explanation is INSIDE the button being chosen — it cannot be
    // pressed without being read past.
    expect(choice.textContent).toContain('Save — send to Jobber later')
    expect(choice.textContent).toContain(SAVE_LATER_EXPLAINER)
    expect(SAVE_LATER_EXPLAINER).toContain('starts a record of the job here in Bee Hub only')
    expect(SAVE_LATER_EXPLAINER).toContain('Nothing reaches Jobber until you send it')
    expect(SAVE_LATER_EXPLAINER).toContain('Not sent to Jobber')
  })

  it('saves the card, sends NOTHING to Jobber, and says so again on the way out', async () => {
    const p = await mountWizard()
    await fillAndContinue('Garage shelving')
    await click(saveLater()!)
    expect(p.onSendToJobber).not.toHaveBeenCalled()
    expect(posts.some(x => x.url.includes('send-to-jobber'))).toBe(false)
    expect(p.setToast).toHaveBeenCalledWith({ kind: 'success', msg: SAVED_TOAST })
    expect(SAVED_TOAST).toContain('not in Jobber yet')
  })
})

// ═══ the card that was saved for later looks unsent ═════════════════════════
let profileBody: any
const profilePayload = (engagements: any[], client: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Martha Wassel', first_name: 'Martha', last_name: 'Wassel',
    email: '', phone: '(423) 555-0100', address: '4402 Kirkwood Dr', city: 'Wexford', state: 'PA', zip: '15090',
    created_at: daysAgo(400), source: 'Webform', paused: false, marketing_opt_out: false,
    snoozed_until: null, snoozed_note: null, assigned_to: null, assigned_to_name: null,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: '136289662', location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Chattanooga',
    ...client,
  },
  referred_us: [], contacts: [], engagements, touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { lifetime_paid: 0, invoiced: 0, open_pipeline: 0, owing: 0, open_count: engagements.length, total_count: engagements.length },
})
const unsentCard = {
  id: 'eng-closet', client_id: 'lead-9', title: 'Primary bedroom closet', description: 'Wants it before December.',
  stage: 'Request', founded_by: 'manual', created_at: daysAgo(2), stage_entered_at: daysAgo(2),
  service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [],
}
const sentCard = { ...unsentCard, id: 'eng-kitchen', title: 'Kitchen pantry', founded_by: 'request', service_requests: [{ id: 'sr-1' }] }
const mountProfile = (props: any = {}) => mount(
  <ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}}
    lookupOptions={{ sources: [], projectTypes: [], clientTags: [] } as any}
    locationUsers={[] as any} {...props} />
)
const rowOf = (title: string) => [...document.querySelectorAll('div')].find(d =>
  d.getAttribute('style')?.includes('cursor: pointer') && (d.textContent || '').includes(title) && d.querySelector('p[title]')) as HTMLElement

describe('an unsent card looks unsent, and carries Send to Jobber', () => {
  it('on the client card: the row says "Not sent to Jobber" and has its own Send to Jobber', async () => {
    profileBody = profilePayload([unsentCard, sentCard])
    const onSend = vi.fn()
    const onOpenEngagement = vi.fn()
    await mountProfile({ onSendToJobber: onSend, onOpenEngagement })
    const row = rowOf('Primary bedroom closet')
    expect(row.getAttribute('data-unsent')).toBe('1')
    expect(row.textContent).toContain(NOT_SENT_LABEL)
    const send = row.querySelector('[data-row-send]') as HTMLButtonElement
    expect(send.textContent).toContain('Send to Jobber')
    await click(send)
    expect(onSend).toHaveBeenCalledWith('lead-9', { engagementId: 'eng-closet' })
    // the row's own click (open the engagement) does not also fire
    expect(onOpenEngagement).not.toHaveBeenCalled()
  })

  it('a card that reached Jobber reads as it always did — no marker, no second send', async () => {
    profileBody = profilePayload([sentCard])
    await mountProfile({ onSendToJobber: vi.fn() })
    const row = rowOf('Kitchen pantry')
    expect(row.getAttribute('data-unsent')).toBeNull()
    expect(row.textContent).not.toContain(NOT_SENT_LABEL)
    expect(row.querySelector('[data-row-send]')).toBeNull()
  })

  it('a card sent THIS session stops saying unsent before the refetch lands', async () => {
    profileBody = profilePayload([unsentCard])
    await mountProfile({ onSendToJobber: vi.fn(), jobberLinks: { 'lead-9': { jobber_client_id: '136289662', engagement_id: 'eng-closet', sent_at: now } } })
    expect(rowOf('Primary bedroom closet').textContent).not.toContain(NOT_SENT_LABEL)
  })

  it('read-only viewers see the marker but get no send', async () => {
    profileBody = profilePayload([unsentCard])
    await mountProfile({ onSendToJobber: vi.fn(), readOnly: true })
    const row = rowOf('Primary bedroom closet')
    expect(row.textContent).toContain(NOT_SENT_LABEL)
    expect(row.querySelector('[data-row-send]')).toBeNull()
  })

  it('on the board: the status chip itself says "Not sent to Jobber", in amber', () => {
    expect(deriveStatusChip(unsentCard, { nowMs: now })).toEqual({ label: NOT_SENT_LABEL, styleKey: 'amber' })
    expect(deriveStatusChip(sentCard, { nowMs: now })!.label).toMatch(/^Requested/)
  })

  it('never claims "not sent" when the row doesn’t carry its request list — no false alarms', () => {
    const { service_requests, ...unknown } = unsentCard
    expect(isUnsentEngagement(unknown)).toBe(false)
    expect(deriveStatusChip(unknown, { nowMs: now })!.label).toMatch(/^Requested/)
  })

  it('a closed card is never "not sent"', () => {
    expect(isUnsentEngagement({ ...unsentCard, stage: 'Closed Lost' })).toBe(false)
  })

  it('the engagement panel says it in words beside its Send to Jobber, on the same gate', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/EngagementPanel.jsx'), 'utf8')
    const at = src.indexOf('data-unsent-note')
    expect(at).toBeGreaterThan(-1)
    expect(src.slice(at - 120, at)).toContain('{canSendToJobber && (')
    expect(src.slice(at, at + 400)).toContain('Not sent to Jobber — this job is only in Bee Hub. Nothing reaches Jobber until you send it.')
  })

  it('end to end on the card: Start a new job → save for later → the new row is there, unsent, with its send', async () => {
    profileBody = profilePayload([sentCard])
    const onEngagementFounded = vi.fn()
    const onSend = vi.fn()
    await mountProfile({ onSendToJobber: onSend, onEngagementFounded })
    const entry = q('button[aria-label="Start a new job"]')!
    // visibly not the old button
    expect(entry.textContent).toContain('Start a new job')
    expect(document.body.textContent).not.toContain('New engagement')
    expect(q('[aria-label="Card actions"]')!.contains(entry)).toBe(false)
    await click(entry)
    await fillAndContinue('Primary bedroom closet', 'Wants it before December.')
    await click(saveLater()!)
    expect(onEngagementFounded).toHaveBeenCalledTimes(1)
    expect(onEngagementFounded.mock.calls[0][0]).toMatchObject({ id: 'eng-NEW', service_requests: [] })
    const row = rowOf('Primary bedroom closet')
    expect(row, 'the saved card is on the client card at once').toBeTruthy()
    expect(row.textContent).toContain(NOT_SENT_LABEL)
    expect(row.querySelector('[data-row-send]')).toBeTruthy()
    expect(onSend).not.toHaveBeenCalled()
  })
})

// ═══ 4. it cannot be blank ═════════════════════════════════════════════════
describe('the wizard will not save a job with nothing on it', () => {
  for (const [what, value] of [['nothing typed', ''], ['only spaces', '     '], ['three letters', 'Tub']] as const) {
    it(`${what} → Continue stays disabled, neither ending is reachable, nothing is posted`, async () => {
      await mountWizard()
      if (value) await type(work(), value)
      await type(said(), 'A long note about the call, but no work named')
      const cont = btn('Continue')!
      expect(cont.disabled).toBe(true)
      expect(q('[data-work-hint]')!.textContent).toContain('Required')
      await click(cont)
      expect(sendNow()).toBeNull()
      expect(saveLater()).toBeNull()
      expect(engagementPosts()).toHaveLength(0)
    })
  }

  it('clearing the work after Continue and going back disables it again', async () => {
    await mountWizard()
    await fillAndContinue('Garage shelving')
    await click(btn('Back')!)
    await type(work(), '  ')
    expect(btn('Continue')!.disabled).toBe(true)
  })

  it('if the server refuses anyway, nothing is founded here and the owner sees why', async () => {
    foundResponse = () => ({ status: 400, body: { error: 'blank_engagement', message: 'Say what the work is (at least 4 characters).' } })
    const p = await mountWizard()
    await fillAndContinue('Garage shelving')
    await click(saveLater()!)
    expect(p.onFounded).not.toHaveBeenCalled()
    expect(p.onClose).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Not saved: Say what the work is')
  })
})

// ═══ 5. which address ══════════════════════════════════════════════════════
describe('a client with more than one address is asked which', () => {
  it('ONE address — no question', async () => {
    await mountWizard()
    expect(q('[data-address-picker]')).toBeNull()
  })

  it('TWO addresses — asked, current chosen by default', async () => {
    await mountWizard({ formerAddresses: [FORMER] })
    expect(q('[data-address-picker]')).toBeTruthy()
    expect(q('[data-address-choice="current"]')!.getAttribute('aria-checked')).toBe('true')
    expect(q('[data-address-choice="former:0"]')!.textContent).toContain('118 Elmhurst Rd')
  })

  it('the answer is written on the card, so a card sent later still says which house', async () => {
    await mountWizard({ formerAddresses: [FORMER] })
    await click(q('[data-address-choice="former:0"]')!)
    await fillAndContinue('Basement shelving', 'For the old house — tenants moving out.')
    await click(saveLater()!)
    expect(engagementPosts()[0].body.description).toBe('For the old house — tenants moving out.\n\nAddress: 118 Elmhurst Rd, Pittsburgh, PA 15237')
  })

  it('Send now hands the chosen house to the Send to Jobber window', async () => {
    const p = await mountWizard({ formerAddresses: [FORMER] })
    await click(q('[data-address-choice="former:0"]')!)
    await fillAndContinue('Basement shelving')
    await click(sendNow()!)
    expect(p.onSendToJobber).toHaveBeenCalledWith('lead-9', { engagementId: 'eng-NEW', addressKey: 'former:0', savedCard: true })
  })

  const twoHousePerson = { id: 'lead-9', name: 'Martha Wassel', jobberRef: '136289662', jobberClient: null, address: '4402 Kirkwood Dr',
    originCity: 'Wexford', originState: 'PA', originZip: '15090', addresses: [{ street: '4402 Kirkwood Dr' }], formerAddresses: [FORMER], outreachTimeline: [] }

  it('…which then does not ask twice, and sends to that house', async () => {
    await mount(<SendToJobberModal person={twoHousePerson} engagementId="eng-NEW" addressKey="former:0" onDone={() => {}} onClose={() => {}} />)
    // action → request-details → confirm: the address step is gone
    expect(document.querySelectorAll('[data-step-seg]')).toHaveLength(3)
    await click(q('button[aria-label="Create a Request"]')!)
    await click(btn('Continue')!)
    expect(q('[data-address-picker]')).toBeNull()
    await click(btn('Review')!)
    await click([...document.querySelectorAll('button')].filter(b => (b.textContent || '').includes('Send to Jobber')).pop()!)
    const send = posts.find(p => p.url.includes('/send-to-jobber'))!
    expect(send.body).toEqual({ creation_type: 'request_only', engagement_id: 'eng-NEW', property_choice: 'former:0' })
  })

  it('…and a key the window doesn’t recognise falls back to asking, as before', async () => {
    await mount(<SendToJobberModal person={twoHousePerson} engagementId="eng-NEW" addressKey="former:7" onDone={() => {}} onClose={() => {}} />)
    await click(q('button[aria-label="Create a Request"]')!)
    await click(btn('Continue')!)
    expect(q('[data-address-picker]')).toBeTruthy()
  })
})
