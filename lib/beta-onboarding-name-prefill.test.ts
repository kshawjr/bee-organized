// Onboarding profile prefill — invited user's LAST NAME must survive to the
// profile step. The regression: the DashboardScreen mount wrapped ownerName
// in getFirstName(), so by the time OnboardingScreen split it into
// first/last, the last name was already gone (the field showed the "Smith"
// placeholder). The contract now:
//
//   A) splitNameForPrefill: first word → firstName, ALL the rest → lastName
//      (multi-word last names survive); email-shaped / 'there' / empty
//      input → no prefill (both fields empty, placeholders show)
//   B) BeeHub source: the DashboardScreen mount passes the FULL stored name
//      (never getFirstName-wrapped); OnboardingScreen prefills via
//      splitNameForPrefill; greetings stay first-name-only via getFirstName
//   C) Save reassembly: /api/hub_users/me recomputes full_name as
//      "first last" whenever either name field changes
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitNameForPrefill } from '@/lib/name-prefill'

// ── A) the split contract ─────────────────────────────────────────────
describe('splitNameForPrefill', () => {
  it('splits "Ankur Patel" into Ankur / Patel', () => {
    expect(splitNameForPrefill('Ankur Patel')).toEqual({ firstName: 'Ankur', lastName: 'Patel' })
  })

  it('keeps multi-word last names intact: "Mary Jo Van Der Berg" → Mary / "Jo Van Der Berg"', () => {
    expect(splitNameForPrefill('Mary Jo Van Der Berg')).toEqual({ firstName: 'Mary', lastName: 'Jo Van Der Berg' })
  })

  it('single-word name fills first only', () => {
    expect(splitNameForPrefill('Ankur')).toEqual({ firstName: 'Ankur', lastName: '' })
  })

  it('email-shaped input (email-only invite: full_name null, page falls back to email) → NO prefill', () => {
    expect(splitNameForPrefill('ankur@example.com')).toEqual({ firstName: '', lastName: '' })
  })

  it("the OnboardingScreen default prop 'there' is not a name", () => {
    expect(splitNameForPrefill('there')).toEqual({ firstName: '', lastName: '' })
  })

  it('empty / null / undefined → no prefill', () => {
    expect(splitNameForPrefill('')).toEqual({ firstName: '', lastName: '' })
    expect(splitNameForPrefill(null)).toEqual({ firstName: '', lastName: '' })
    expect(splitNameForPrefill(undefined)).toEqual({ firstName: '', lastName: '' })
  })

  it('collapses stray whitespace: "  Ankur   Patel  " → Ankur / Patel', () => {
    expect(splitNameForPrefill('  Ankur   Patel  ')).toEqual({ firstName: 'Ankur', lastName: 'Patel' })
  })
})

// ── B) BeeHub data flow (source-level, the identity-scope idiom) ──────
describe('BeeHub ownerName flow', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('the DashboardScreen mount passes the FULL stored name — never getFirstName-wrapped', () => {
    // the exact regression: ownerName={getFirstName(...)} truncated the
    // invited user's name to first-only before onboarding could split it
    expect(src).not.toMatch(/ownerName=\{getFirstName\(/)
    expect(src).toContain(
      "ownerName={(viewAsUser?.name || selectedLoc?.owner || currentUser?.name || '').trim() || 'Kevin Shaw'}"
    )
  })

  it('OnboardingScreen prefills the profile form via splitNameForPrefill', () => {
    expect(src).toContain('import { splitNameForPrefill } from "@/lib/name-prefill"')
    expect(src).toContain('const namePrefill = splitNameForPrefill(ownerName)')
    expect(src).toMatch(/firstName: currentUserCtx\?\.first_name \|\| namePrefill\.firstName/)
    expect(src).toMatch(/lastName:\s+currentUserCtx\?\.last_name\s+\|\| namePrefill\.lastName/)
    // no leftover raw split of ownerName anywhere
    expect(src).not.toContain("(ownerName||'').split(' ')")
  })

  it('DB-saved profile fields (Pass 2 remount) still win over the ownerName split', () => {
    // currentUserCtx.first_name/last_name come from the same hub_users row
    // (both null on a fresh invite, both set after a profile save) — they
    // stay first in the || chain so a saved profile is never overwritten
    // by a re-derived split.
    expect(src).toMatch(/firstName: currentUserCtx\?\.first_name \|\|/)
    expect(src).toMatch(/lastName:\s+currentUserCtx\?\.last_name\s+\|\|/)
  })

  it('greetings stay FIRST-name-only now that ownerName carries the full name', () => {
    // non-owner onboarding checklist header
    expect(src).toContain("Hi {getFirstName(ownerName, ownerEmail) || 'there'}!")
    // dashboard time-of-day greeting
    expect(src).toContain('{getFirstName(ownerName, ownerEmail)?`, ${getFirstName(ownerName, ownerEmail)}`:\'\'}')
    // WelcomeStep already derives its own first name
    expect(src).toContain('const firstName = getFirstName(ownerName, ownerEmail)')
  })

  it('email-only invites land on placeholders — the Last Name input still carries "Smith"', () => {
    expect(src).toMatch(/value=\{profileForm\.lastName\}[^\n]*placeholder="Smith"/)
    expect(src).toMatch(/value=\{profileForm\.firstName\}[^\n]*placeholder="/)
  })
})

// ── C) save reassembles full_name as "First Last" ─────────────────────
describe('/api/hub_users/me PATCH — full_name reassembly', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/hub_users/me/route.ts'), 'utf8')

  it('recomputes full_name whenever either name field changes', () => {
    expect(src).toContain("if ('first_name' in patch || 'last_name' in patch)")
    expect(src).toContain('const full = `${fn} ${ln}`.trim()')
    expect(src).toContain('patch.full_name = full || null')
  })

  it('partial updates preserve the other half from the current row', () => {
    expect(src).toMatch(/'first_name' in patch \? patch\.first_name : \(current as any\)\?\.first_name/)
    expect(src).toMatch(/'last_name'\s+in patch \? patch\.last_name\s+: \(current as any\)\?\.last_name/)
  })
})
