// @vitest-environment node
//
// resolveInternalOrigin — the origin server-to-server import continuations
// (self-chain + cron sweeper) must POST to. The stalled-Scottsdale bug
// (2026-07-21): the old chain only knew INTERNAL_BASE_URL and
// VERCEL_PROJECT_PRODUCTION_URL (both UNSET in this project), so it always
// fell through to the deployment origin — which Vercel Deployment Protection
// redirects to an SSO login before the route runs. Every re-poke bounced and
// the job stalled forever.
//
// The fix threads the public custom domain (NEXT_PUBLIC_APP_URL /
// NEXT_PUBLIC_SITE_URL — configured, non-SSO, verified reachable) into the
// chain AHEAD of the gated deployment fallback. These tests pin the precedence
// and, crucially, the regression: with only the public URL set (the real prod
// shape), the gated fallback is NEVER returned.
import { describe, it, expect, vi } from 'vitest'
import { resolveInternalOrigin, isGatedResponse, probeInternalOriginGated } from '@/lib/internal-origin'

const GATED = 'https://bee-hub-abc123.vercel.app' // deployment origin — SSO-gated
const PUBLIC = 'https://beehive.beeorganized.com'  // stable custom domain — open

describe('resolveInternalOrigin — precedence', () => {
  it('INTERNAL_BASE_URL wins when set (explicit operator override)', () => {
    const env = { INTERNAL_BASE_URL: 'https://internal.example.com', NEXT_PUBLIC_APP_URL: PUBLIC } as any
    expect(resolveInternalOrigin(GATED, env)).toBe('https://internal.example.com')
  })

  it('falls to NEXT_PUBLIC_APP_URL when INTERNAL_BASE_URL is unset', () => {
    const env = { NEXT_PUBLIC_APP_URL: PUBLIC } as any
    expect(resolveInternalOrigin(GATED, env)).toBe(PUBLIC)
  })

  it('falls to NEXT_PUBLIC_SITE_URL when APP_URL is also unset', () => {
    const env = { NEXT_PUBLIC_SITE_URL: PUBLIC } as any
    expect(resolveInternalOrigin(GATED, env)).toBe(PUBLIC)
  })

  it('falls to https://VERCEL_PROJECT_PRODUCTION_URL when no public URL is set', () => {
    const env = { VERCEL_PROJECT_PRODUCTION_URL: 'bee-hub.vercel.app' } as any
    expect(resolveInternalOrigin(GATED, env)).toBe('https://bee-hub.vercel.app')
  })

  it('uses the deployment origin ONLY as the last resort (all env unset)', () => {
    expect(resolveInternalOrigin(GATED, {} as any)).toBe(GATED)
  })

  it('REGRESSION: real prod shape (only NEXT_PUBLIC_APP_URL set) never returns the gated origin', () => {
    // Exactly the .env.local Kevin runs: public URL configured, the two
    // internal keys absent. The old code returned GATED here — the whole bug.
    const env = {
      NEXT_PUBLIC_APP_URL: PUBLIC,
      NEXT_PUBLIC_SITE_URL: PUBLIC,
      // INTERNAL_BASE_URL / VERCEL_PROJECT_PRODUCTION_URL intentionally absent
    } as any
    const origin = resolveInternalOrigin(GATED, env)
    expect(origin).toBe(PUBLIC)
    expect(origin).not.toBe(GATED)
  })

  it('trims a trailing slash so callers can append /api/... cleanly', () => {
    const env = { NEXT_PUBLIC_APP_URL: PUBLIC + '/' } as any
    expect(resolveInternalOrigin(GATED, env)).toBe(PUBLIC)
  })
})

// ── origin health assertion (item 3) ─────────────────────────────
describe('isGatedResponse — classifies an SSO-gated probe response', () => {
  it('opaqueredirect (redirect:manual on a gated origin) is gated', () => {
    expect(isGatedResponse({ status: 0, type: 'opaqueredirect' })).toBe(true)
  })
  it('a raw 3xx is gated', () => {
    expect(isGatedResponse({ status: 302 })).toBe(true)
    expect(isGatedResponse({ status: 307 })).toBe(true)
  })
  it('the route’s own 401 (reachable, no session) is NOT gated', () => {
    expect(isGatedResponse({ status: 401, type: 'basic' })).toBe(false)
  })
  it('a 400/200 (route ran) is NOT gated', () => {
    expect(isGatedResponse({ status: 400 })).toBe(false)
    expect(isGatedResponse({ status: 200 })).toBe(false)
  })
})

describe('probeInternalOriginGated — probes the import route with no secret', () => {
  it('POSTs to the import route with redirect:manual + empty body', async () => {
    const fetchMock = vi.fn(async () => ({ status: 401, type: 'basic' }) as any)
    const gated = await probeInternalOriginGated(PUBLIC, fetchMock as any)
    expect(gated).toBe(false)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PUBLIC}/api/import/jobber-clients`)
    expect(opts.method).toBe('POST')
    expect(opts.redirect).toBe('manual')
    expect(opts.body).toBe('{}')
  })
  it('returns true when the origin redirects to SSO login', async () => {
    const fetchMock = vi.fn(async () => ({ status: 0, type: 'opaqueredirect' }) as any)
    expect(await probeInternalOriginGated(GATED, fetchMock as any)).toBe(true)
  })
  it('returns null (inconclusive) when the probe throws', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network') })
    expect(await probeInternalOriginGated(PUBLIC, fetchMock as any)).toBe(null)
  })
})
