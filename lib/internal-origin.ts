// lib/internal-origin.ts
//
// Resolve the origin to use for server-to-server "continue this import"
// POSTs — the waitUntil self-chain in /api/import/jobber-clients and the
// re-pokes from /api/cron/import-sweeper.
//
// WHY THIS EXISTS (the stalled-Scottsdale bug, 2026-07-21):
// A cron/self-chain POST that targets the *deployment* URL (req.nextUrl.origin
// / url.origin — a `*.vercel.app` address) is intercepted by Vercel Deployment
// Protection and redirected to an SSO login page BEFORE the route runs. The
// internal-secret header means nothing to that edge gate, so the resume never
// lands and the job stalls forever. The stable, customer-facing custom domain
// is NOT SSO-gated (verified: POST with no secret returns the route's own 401,
// not a redirect), so it is the correct target.
//
// The prior chain only consulted INTERNAL_BASE_URL and
// VERCEL_PROJECT_PRODUCTION_URL — both UNSET in this project — so it always
// fell through to the gated deployment origin. This helper adds the public
// app URL (which IS configured: NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_SITE_URL =
// https://beehive.beeorganized.com) to the chain, ahead of that gated
// last-resort fallback. No new env var required.
//
// Order (first configured value wins):
//   1. INTERNAL_BASE_URL          — explicit override, if an operator sets one
//   2. NEXT_PUBLIC_APP_URL        — stable public custom domain (non-SSO)
//   3. NEXT_PUBLIC_SITE_URL       — same domain, alternate key
//   4. VERCEL_PROJECT_PRODUCTION_URL — Vercel-injected prod alias (if exposed)
//   5. fallbackOrigin             — deployment origin; SSO-gated LAST RESORT

/** Strip a trailing slash so callers can always append `/api/...`. */
const trim = (u: string) => u.replace(/\/+$/, '')

// Classify a fetch Response (from a no-secret probe of an internal route) as
// SSO-gated or not. A gated origin makes Vercel Deployment Protection redirect
// to a login page BEFORE the route runs; with redirect:'manual' undici surfaces
// that as an opaqueredirect (type='opaqueredirect', status=0) or a raw 3xx. A
// non-gated origin runs the route, which answers with its own status (e.g. 401
// for a missing session) — anything that is NOT a redirect. Same signature the
// import-sweeper keys off. Pure so it's unit-testable without a live fetch.
export function isGatedResponse(res: { status: number; type?: string }): boolean {
  return (
    (res as any).type === 'opaqueredirect' ||
    res.status === 0 ||
    (res.status >= 300 && res.status < 400)
  )
}

// Probe whether the resolved internal origin is SSO-gated by POSTing to the
// import route WITHOUT the internal secret. A healthy (non-gated) origin runs
// the route and returns its own 401 (no session) — NOT a redirect; a gated
// origin redirects to login before the route runs. Returns:
//   true  → gated (BAD — every self-chain / sweeper re-poke will bounce)
//   false → reachable (healthy)
//   null  → probe failed (network error) — inconclusive, don't alarm
// The empty-body POST hits the route's auth check and returns 401 before any
// location lookup or job creation, so it has no side effects.
export async function probeInternalOriginGated(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const res = await fetchImpl(`${trim(origin)}/api/import/jobber-clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
    })
    return isGatedResponse(res as any)
  } catch {
    return null
  }
}

export function resolveInternalOrigin(
  fallbackOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate =
    env.INTERNAL_BASE_URL ||
    env.NEXT_PUBLIC_APP_URL ||
    env.NEXT_PUBLIC_SITE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
      : fallbackOrigin)
  return trim(candidate || fallbackOrigin)
}
