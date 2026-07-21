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
import { describe, it, expect } from 'vitest'
import { resolveInternalOrigin } from '@/lib/internal-origin'

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
