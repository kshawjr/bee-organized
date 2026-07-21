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
