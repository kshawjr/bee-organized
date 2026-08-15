// issue 235 defect A — the reply email's link must survive the login bounce.
//
// The chain, and where it used to break:
//
//   email  → https://<app>/?feedback=1
//   page   → hubReturnTo(...)              ← BROKE HERE: returned null for the
//                                            home route, discarding the param
//   auth   → loginRedirectTarget(returnTo) → /auth/login?next=…
//   login  → forwards ?next to the OAuth callback
//   cb     → safeNextPath(next) → redirect  → /?feedback=1, modal opens
//
// Zero feedback_reply emails had been sent in production when this was found,
// so no owner had hit it yet — but every one of them would have.

import { describe, it, expect } from 'vitest'
import { queryStringFrom, hubReturnTo, safeNextPath } from './safe-next'
import { loginRedirectTarget } from './auth'

describe('queryStringFrom', () => {
  it('serializes a param', () => {
    expect(queryStringFrom({ feedback: '1' })).toBe('?feedback=1')
  })
  it('is empty for no params, so a bare visit stays "nowhere in particular"', () => {
    expect(queryStringFrom({})).toBe('')
    expect(queryStringFrom(undefined)).toBe('')
    expect(queryStringFrom(null)).toBe('')
  })
  it('skips undefined values but keeps repeated keys', () => {
    expect(queryStringFrom({ a: undefined, b: '2' })).toBe('?b=2')
    expect(queryStringFrom({ t: ['x', 'y'] })).toBe('?t=x&t=y')
  })
})

describe('hubReturnTo', () => {
  it('THE DEFECT: home with ?feedback=1 is a real destination', () => {
    expect(hubReturnTo({ searchParams: { feedback: '1' } })).toBe('/?feedback=1')
    // ...and explicitly for the route as app/page.tsx passes it.
    expect(hubReturnTo({ initialRoute: 'home', searchParams: { feedback: '1' } }))
      .toBe('/?feedback=1')
  })

  it('home with no query string is still null — someone who just typed the domain', () => {
    expect(hubReturnTo({})).toBeNull()
    expect(hubReturnTo({ initialRoute: 'home' })).toBeNull()
    expect(hubReturnTo({ initialRoute: 'home', searchParams: {} })).toBeNull()
  })

  it('leaves the existing lead and tab deep-links exactly as they were', () => {
    expect(hubReturnTo({ initialSelectedLeadId: 'abc' })).toBe('/clients/abc')
    expect(hubReturnTo({ initialSelectedLeadId: 'abc', initialSelectedEngagementId: 'e9' }))
      .toBe('/clients/abc?e=e9')
    expect(hubReturnTo({ initialRoute: 'settings' })).toBe('/settings')
    // A lead id wins over a query string, as before.
    expect(hubReturnTo({ initialSelectedLeadId: 'abc', searchParams: { feedback: '1' } }))
      .toBe('/clients/abc')
  })
})

describe('the full email → login → reply chain', () => {
  const emailLinkPath = '/?feedback=1'

  it('carries ?feedback=1 all the way to the post-login redirect', () => {
    // 1. the page works out where they were headed
    const returnTo = hubReturnTo({ initialRoute: 'home', searchParams: { feedback: '1' } })
    expect(returnTo).toBe(emailLinkPath)

    // 2. requireAuth turns that into the login URL — with a next param, which
    //    is the whole fix. It used to be a bare /auth/login.
    const loginUrl = loginRedirectTarget(returnTo)
    expect(loginUrl).toBe('/auth/login?next=%2F%3Ffeedback%3D1')

    // 3. the login page reads it back and forwards it (it only drops a bare '/')
    const nextParam = safeNextPath(
      new URLSearchParams(loginUrl.split('?')[1]).get('next'),
    )
    expect(nextParam).toBe(emailLinkPath)
    expect(nextParam !== '/').toBe(true)

    // 4. the callback sanitizes once more and redirects there
    expect(safeNextPath(nextParam)).toBe(emailLinkPath)
  })

  it('REGRESSION: a bare /auth/login means the reply never opens', () => {
    // This is exactly what shipped in issue 233 — asserted so it cannot come
    // back by someone "simplifying" the home branch to null again.
    expect(loginRedirectTarget(null)).toBe('/auth/login')
    expect(loginRedirectTarget(null)).not.toContain('feedback')
  })

  it('still refuses an off-site next, query string or not', () => {
    expect(safeNextPath('//evil.com/?feedback=1')).toBe('/')
    expect(safeNextPath('https://evil.com/?feedback=1')).toBe('/')
    expect(loginRedirectTarget('//evil.com')).toBe('/auth/login')
  })
})
