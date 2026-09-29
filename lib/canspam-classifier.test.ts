// The live CAN-SPAM verdict (lib/canspam-classifier.ts auditLiveEmail) and the
// read-only guarantee of the script that runs it (scripts/scan-canspam-live.mjs).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditLiveEmail, promoProfile, TRANSACTIONAL_ANCHOR } from '@/lib/canspam-classifier'

const REPLY = 'Hi {{first_name}},\n\nThanks for your inquiry. Click HERE to schedule your assessment.\n\n{{owner_name}}'
const OFFER = 'Book this month and get 1 Free Hour off your next session!'

describe('an email with NO unsubscribe footer (drip step, estimate follow-up)', () => {
  const email = (body: string, over: Partial<Parameters<typeof auditLiveEmail>[0]> = {}) =>
    auditLiveEmail({ key: 'organizing-a#9', isMaster: false, footered: false, body, ...over })

  it('a plain reply to their enquiry is fine', () => {
    expect(email(REPLY)).toEqual([])
  })

  it('the Google Reviews line and the Profiles Quiz are incidental — still fine', () => {
    expect(email(`${REPLY}\n\nBe sure to check out our Google Reviews!\n\nTake our Profiles Quiz`)).toEqual([])
  })

  it('an offer is flagged', () => {
    const f = email(`${REPLY}\n\n${OFFER}`)
    expect(f).toHaveLength(1)
    expect(f[0].level).toBe('problem')
    expect(f[0].reason).toContain('offer')
  })

  it('the brand story is flagged', () => {
    expect(email(`${REPLY}\n\nLearn How We Came To Bee`)[0].reason).toContain('brand_story')
  })

  it('an owner copy offering "$20 off your next service" is flagged', () => {
    expect(email(`${REPLY}\n\nEnjoy $20 off your next service booked with us.`)[0].reason).toContain('offer')
  })

  it("nothing about the recipient's own enquiry is flagged", () => {
    const f = email('Hi {{first_name}},\n\nWe hope you are well!\n\n{{owner_name}}')
    expect(f).toHaveLength(1)
    expect(f[0].reason).toContain("doesn't mention the recipient's own enquiry")
  })

  it('"enquiry" / "inquiry" count as a reference to their request', () => {
    expect(TRANSACTIONAL_ANCHOR.test("We've got your enquiry")).toBe(true)
    expect(TRANSACTIONAL_ANCHOR.test("We've got your inquiry")).toBe(true)
    expect(email("Thanks for getting back in touch. We've got your enquiry.")).toEqual([])
  })
})

describe('an email WITH the unsubscribe footer (welcome, 3- and 12-month follow-ups)', () => {
  it('an owner copy full of offers is fine — the footer is what makes it compliant', () => {
    expect(
      auditLiveEmail({ key: 'opp_closed_job_3mo', isMaster: false, footered: true, body: `${OFFER}\nHow We Came To Bee` }),
    ).toEqual([])
  })
})

describe('a standard (master) email that drifts from what was assessed', () => {
  it('a master drip step that gains an offer is both a problem and a change', () => {
    const f = auditLiveEmail({ key: 'organizing-a#3', isMaster: true, footered: false, body: `${REPLY}\n\n${OFFER}` })
    expect(f.map((x) => x.level).sort()).toEqual(['changed', 'problem'])
  })

  it('a footered master that loses its offer is a change, not a problem', () => {
    const f = auditLiveEmail({ key: 'opp_closed_job_3mo', isMaster: true, footered: true, body: 'Hope you love your space!' })
    expect(f).toEqual([{ level: 'changed', reason: expect.stringContaining('was [offer], now []') }])
  })

  it('a master matching its assessed profile is fine', () => {
    expect(
      auditLiveEmail({ key: 'organizing-a#1', isMaster: true, footered: false, body: `${REPLY}\n\nGoogle Reviews` }),
    ).toEqual([])
    expect(promoProfile(`${REPLY}\n\nGoogle Reviews`)).toEqual(['reviews'])
  })

  it('an owner copy is never judged against the master pins', () => {
    expect(
      auditLiveEmail({ key: 'opp_closed_job_3mo', isMaster: false, footered: true, body: 'nothing promotional' }),
    ).toEqual([])
  })
})

describe('scripts/scan-canspam-live.mjs is read-only', () => {
  const src = readFileSync(join(__dirname, '..', 'scripts', 'scan-canspam-live.mjs'), 'utf8')

  it('never writes: no insert, update, upsert, delete or rpc', () => {
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/)
  })

  it('runs the shared rules, not a copy of them', () => {
    expect(src).toContain("lib/canspam-classifier.ts")
    expect(src).toContain('auditLiveEmail(')
    expect(src).not.toMatch(/const PROMO_MARKERS|const TRANSACTIONAL_ANCHOR/)
  })

  it('reads the text that actually sends: the step body, else its linked template', () => {
    expect(src).toContain('s.body ?? linked?.body')
  })
})
