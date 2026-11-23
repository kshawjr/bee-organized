// FL-75 slice 1 — the shared Mailchimp rules (lib/mailchimp-rules.ts).
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import {
  INELIGIBLE_WORDS,
  archivedLine,
  buildMatchIndex,
  emailKey,
  mailchimpEligibility,
  mailchimpIncluded,
  matchContact,
  matchPhoneKey,
} from './mailchimp-rules'

describe('emailKey', () => {
  it('trims and lowercases, the shape Mailchimp hashes', () => {
    expect(emailKey('  Jane.Doe@Example.COM ')).toBe('jane.doe@example.com')
  })
  it('refuses anything that is not one usable address', () => {
    for (const bad of [null, undefined, '', '   ', 'jane', 'jane@', '@x.com', 'jane@example', 'a b@x.com',
      'a@x.com, b@y.com', 'a@x.com;b@y.com', 'a@@x.com', 42]) {
      expect(emailKey(bad as any)).toBeNull()
    }
  })
})

describe('matchPhoneKey', () => {
  it('reads US numbers in any shape to the same key', () => {
    expect(matchPhoneKey('(336) 207-7477')).toBe('3362077477')
    expect(matchPhoneKey('+1 336.207.7477')).toBe('3362077477')
  })
  it('never offers stubs, foreign or junk numbers for matching', () => {
    for (const bad of ['4', '7126', '+44 20 7946 0958', 'call me', '', null]) {
      expect(matchPhoneKey(bad)).toBeNull()
    }
  })
})

describe('mailchimpEligibility — everyone with an email, by default', () => {
  const base = { email: 'pat@example.com' }

  it('lets in anyone with a usable email, whatever their source or consent stamp', () => {
    // No source, no marketing_consented_at: Kevin's rule is everyone by default.
    expect(mailchimpEligibility(base)).toEqual({ eligible: true, emailKey: 'pat@example.com', tickedByDefault: true, archivedAt: null })
  })

  it('keeps out each excluded case, with its reason', () => {
    expect(mailchimpEligibility({ email: '' })).toEqual({ eligible: false, reason: 'no_email' })
    expect(mailchimpEligibility({ ...base, is_junk: true })).toEqual({ eligible: false, reason: 'junk' })
    expect(mailchimpEligibility({ ...base, marketing_opt_out: true })).toEqual({ eligible: false, reason: 'opted_out' })
    expect(mailchimpEligibility({ ...base, marketing_unsubscribed_at: '2026-11-01T00:00:00Z' }))
      .toEqual({ eligible: false, reason: 'unsubscribed' })
  })

  it('an unsubscribe at ANY location keeps them out here, by email, any casing', () => {
    const suppressed = new Set(['pat@example.com'])
    expect(mailchimpEligibility({ email: ' PAT@Example.com ' }, { suppressed }))
      .toEqual({ eligible: false, reason: 'unsubscribed_elsewhere' })
  })

  it("the person's unsubscribe outranks the owner's tick", () => {
    const suppressed = new Set(['pat@example.com'])
    expect(mailchimpIncluded(base, { suppressed, ownerChoice: 'in' })).toBe(false)
    expect(mailchimpIncluded({ ...base, marketing_opt_out: true }, { ownerChoice: 'in' })).toBe(false)
    expect(mailchimpIncluded({ ...base, is_junk: true }, { ownerChoice: 'in' })).toBe(false)
  })

  it('false flags do not exclude', () => {
    expect(mailchimpEligibility({ ...base, is_junk: false, marketing_opt_out: false, marketing_unsubscribed_at: null, archived_at: null }).eligible).toBe(true)
  })

  it('everyone not archived starts ticked; the owner can untick', () => {
    expect(mailchimpIncluded(base)).toBe(true)
    expect(mailchimpIncluded(base, { ownerChoice: null })).toBe(true)
    expect(mailchimpIncluded(base, { ownerChoice: 'out' })).toBe(false)
  })

  it('every reason has plain owner words', () => {
    for (const w of Object.values(INELIGIBLE_WORDS)) {
      expect(w).toMatch(/^[A-Z][A-Za-z ]+[a-z]$/)
      expect(w).not.toMatch(/opt|suppress|consent|junk/i)
    }
  })
})

describe('archived people — the owner\'s call (Kevin, 2026-11-23)', () => {
  const archived = { email: 'arch@example.com', archived_at: '2026-11-20T03:49:12Z' }

  it('are eligible, so they appear in the review list', () => {
    expect(mailchimpEligibility(archived)).toEqual({
      eligible: true, emailKey: 'arch@example.com', tickedByDefault: false, archivedAt: '2026-11-20T03:49:12Z',
    })
  })

  it('start UNTICKED, and go in only when the owner ticks them', () => {
    expect(mailchimpIncluded(archived)).toBe(false)
    expect(mailchimpIncluded(archived, { ownerChoice: null })).toBe(false)
    expect(mailchimpIncluded(archived, { ownerChoice: 'in' })).toBe(true)
    expect(mailchimpIncluded(archived, { ownerChoice: 'out' })).toBe(false)
  })

  it('archived is not the Recycle Bin: junk stays out even if also archived', () => {
    expect(mailchimpEligibility({ ...archived, is_junk: true })).toEqual({ eligible: false, reason: 'junk' })
  })

  it("an archived person's own no-marketing choice still wins", () => {
    expect(mailchimpEligibility({ ...archived, marketing_opt_out: true })).toEqual({ eligible: false, reason: 'opted_out' })
    expect(mailchimpEligibility(archived, { suppressed: new Set(['arch@example.com']) }))
      .toEqual({ eligible: false, reason: 'unsubscribed_elsewhere' })
  })

  it('the review line says archived and when, in the location\'s time zone', () => {
    // 03:49 UTC on 20 Nov is still 19 Nov in Chattanooga (Eastern) and Austin (Central).
    expect(archivedLine(archived.archived_at, 'America/New_York')).toBe('Archived on Nov 19, 2026. Tick to add them to Mailchimp.')
    expect(archivedLine(archived.archived_at, 'UTC')).toBe('Archived on Nov 20, 2026. Tick to add them to Mailchimp.')
  })

  it('the line never says Invalid Date, and is absent when not archived', () => {
    expect(archivedLine('not a date', 'America/New_York')).toBe('Archived. Tick to add them to Mailchimp.')
    expect(archivedLine('2026-11-20T03:49:12Z', 'Not/AZone')).toBe('Archived on Nov 20, 2026. Tick to add them to Mailchimp.')
    expect(archivedLine(null, 'UTC')).toBeNull()
  })
})

describe('matchContact — email first, phone only proposes, never name', () => {
  const beeHub = buildMatchIndex([
    { id: 'L1', email: 'Jane@Example.com', phone: '(401) 247-1926' },
    { id: 'L2', email: 'dup@example.com', phone: null },
    { id: 'L3', email: 'DUP@example.com', phone: null },
    { id: 'L4', email: null, phone: '919-555-0100' },
  ])

  it('matches on email, any casing', () => {
    expect(matchContact({ id: 'm1', email: 'jane@example.com' }, beeHub)).toEqual({ kind: 'email', ids: ['L1'] })
  })

  it('returns every duplicate rather than picking one', () => {
    expect(matchContact({ id: 'm2', email: 'dup@example.com' }, beeHub)).toEqual({ kind: 'email', ids: ['L2', 'L3'] })
  })

  it('email beats phone when both would match different people', () => {
    expect(matchContact({ id: 'm3', email: 'jane@example.com', phone: '9195550100' }, beeHub))
      .toEqual({ kind: 'email', ids: ['L1'] })
  })

  it('a phone-only match is a proposal for the owner, never a join', () => {
    expect(matchContact({ id: 'm4', email: 'new@example.com', phone: '+1 919 555 0100' }, beeHub))
      .toEqual({ kind: 'phone_confirm', ids: ['L4'] })
  })

  it('never matches on name — same name, no shared email or phone is no match', () => {
    const named = buildMatchIndex([{ id: 'L9', email: 'a@x.com', name: 'Jane Doe' } as any])
    expect(matchContact({ id: 'm5', email: 'b@y.com', name: 'Jane Doe' } as any, named)).toEqual({ kind: 'none' })
  })

  it('a stub phone never produces a match', () => {
    const idx = buildMatchIndex([{ id: 'L5', email: null, phone: '4' }])
    expect(matchContact({ id: 'm6', email: null, phone: '4' }, idx)).toEqual({ kind: 'none' })
  })

  it('the rules file never reads a name field', () => {
    const src = readFileSync(new URL('./mailchimp-rules.ts', import.meta.url), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(src).not.toMatch(/first_name|last_name|\.name\b|full_name/)
  })
})
