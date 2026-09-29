// The live CAN-SPAM verdict (lib/canspam-classifier.ts auditLiveEmail) and the
// read-only guarantee of the script that runs it (scripts/scan-canspam-live.mjs).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACCEPTED_WITHOUT_ENQUIRY_WORDS,
  STANDARD,
  TRANSACTIONAL_ANCHOR,
  auditLiveEmail,
  fingerprint,
  promoProfile,
} from '@/lib/canspam-classifier'

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

// ── The 8 accepted returning-client nudges (Kevin, 2026-09-28) ────────────
describe('accepted nudges — accepted only while the text, place and email are unchanged', () => {
  // The exact texts that were reviewed, copied from production on 2026-09-28.
  // Each must hash to the fingerprint recorded in lib/canspam-classifier.ts —
  // so the list is provably of THESE words, not whatever was there later.
  const BURIED = "Hi {{first_name}},\n\nJust making sure this didn't get buried. We'd love to help again.\n\nIf now isn't the right time, no problem at all. Reply whenever suits and we'll pick it up.\n\n{{owner_name}}"
  const LAST = "Hi {{first_name}},\n\nThis is the last you'll hear from us on this one. If you'd still like a hand, just reply and we'll sort out a time.\n\nEither way, it was good to hear from you.\n\n{{owner_name}}"
  const NORTH_HOUSTON = "Hi {{first_name}},\n\nJust making sure this didn't get buried. We'd love to help again.\n\nIf now isn't the right time, no problem at all, reach out when you're ready!\n\n{{owner_name}}"
  const SAN_DIEGO = "Hi {{first_name}},\n\nJust making sure our messages didn't get buried. We'd love to help again.\n\nIf now isn't the right time, no problem at all. Reply whenever you are ready to tackle your next organizing project.\n\n{{owner_name}}"
  const TEXT_BY_FP: Record<string, string> = {}
  for (const t of [BURIED, LAST, NORTH_HOUSTON, SAN_DIEGO]) TEXT_BY_FP[fingerprint(t)] = t

  const nudge = (place: string, key: string, body: string) =>
    auditLiveEmail({ key, isMaster: place === STANDARD, footered: false, body, place })

  it('there are exactly 8, and every fingerprint is of a text that was reviewed', () => {
    expect(ACCEPTED_WITHOUT_ENQUIRY_WORDS).toHaveLength(8)
    for (const a of ACCEPTED_WITHOUT_ENQUIRY_WORDS) expect(TEXT_BY_FP[a.fingerprint], a.label).toBeDefined()
  })

  it('the reviewed texts carry nothing to sell — which is why they were accepted', () => {
    for (const t of Object.values(TEXT_BY_FP)) expect(promoProfile(t)).toEqual([])
  })

  it('each of the 8, unchanged, in its place, is not flagged', () => {
    for (const a of ACCEPTED_WITHOUT_ENQUIRY_WORDS) {
      expect(nudge(a.place, a.key, TEXT_BY_FP[a.fingerprint]), a.label).toEqual([])
    }
  })

  it('ONE word changed → flagged again', () => {
    const a = ACCEPTED_WITHOUT_ENQUIRY_WORDS[0]
    const edited = TEXT_BY_FP[a.fingerprint].replace('love to help', 'like to help')
    const f = nudge(a.place, a.key, edited)
    expect(f).toHaveLength(1)
    expect(f[0].reason).toContain("doesn't mention the recipient's own enquiry")
  })

  it('even a trailing space → flagged again (the fingerprint is exact)', () => {
    const a = ACCEPTED_WITHOUT_ENQUIRY_WORDS[1]
    expect(nudge(a.place, a.key, TEXT_BY_FP[a.fingerprint] + ' ')).toHaveLength(1)
  })

  it('an offer added to an accepted nudge → flagged for BOTH reasons', () => {
    const a = ACCEPTED_WITHOUT_ENQUIRY_WORDS[0]
    const f = nudge(a.place, a.key, `${TEXT_BY_FP[a.fingerprint]}\n\n${OFFER}`)
    expect(f.map((x) => x.reason).join(' | ')).toMatch(/offer.*\|.*enquiry/)
  })

  it('the same accepted text somewhere NEW → flagged (it gets its own look)', () => {
    expect(nudge('some-other-location-id', 'returning-c#2', BURIED)).toHaveLength(1)
    expect(nudge(STANDARD, 'returning-b#2', BURIED)).toHaveLength(1)
  })

  it('without a place, nothing is ever treated as accepted', () => {
    expect(
      auditLiveEmail({ key: 'returning-a#2', isMaster: false, footered: false, body: BURIED }),
    ).toHaveLength(1)
  })

  it('the reason is written down next to the list, not just the fingerprints', () => {
    const src = readFileSync(join(__dirname, 'canspam-classifier.ts'), 'utf8')
    const block = src.slice(src.indexOf('WHY THESE ARE ACCEPTED'), src.indexOf('export const ACCEPTED_WITHOUT_ENQUIRY_WORDS'))
    expect(block).toMatch(/NUDGE/)
    expect(block).toMatch(/NO offer/)
    expect(block).toMatch(/own open request/)
  })
})
