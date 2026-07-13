// lib/jobber.ts
// ─────────────────────────────────────────────────────────────
// Jobber GraphQL client + token management.
// Reads/writes tokens from Supabase locations table.
// Fully independent of Zoho.
//
// Two access patterns:
//   - jobberQuery(token, q, vars) / getValidJobberToken(location)
//     Low-level. Caller already has the location row + a hot token.
//     Used by the import route to avoid one DB roundtrip per page.
//   - jobberGraphQL(locationId, q, vars) / jobberMutation(...)
//     High-level. Auto-refresh, surfaces userErrors. Used by
//     Send-to-Jobber + webhook handlers where each call is isolated.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

const supabase = supabaseService

export const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql'
export const JOBBER_API_VERSION = '2025-04-16'

export async function jobberQuery(accessToken: string, query: string, variables?: object) {
  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  })
  return res.json()
}

// ── Throttle-aware query wrapper ──────────────────────────────
// Reads extensions.cost.throttleStatus from every response, pre-checks
// budget before each request, and retries with exponential backoff on
// THROTTLED errors. Module-level state persists across calls within a
// single serverless invocation (reset on cold start = conservatively safe).

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class JobberThrottleError extends Error {
  constructor(errors: any[]) {
    super('Jobber rate limit exhausted after retries: ' + JSON.stringify(errors))
    this.name = 'JobberThrottleError'
  }
}

let lastThrottle = {
  maximumAvailable: 2500,
  currentlyAvailable: 2500,
  restoreRate: 50,
}

export async function jobberQueryThrottled(
  accessToken: string,
  query: string,
  variables?: object,
  opts: { retries?: number; onThrottlePause?: (waitMs: number) => void } = {},
): Promise<any> {
  const retries = opts.retries ?? 3
  const estimatedCost = 50

  if (lastThrottle.currentlyAvailable < estimatedCost) {
    const waitMs = Math.ceil(
      ((estimatedCost - lastThrottle.currentlyAvailable) / lastThrottle.restoreRate + 0.5) * 1000
    )
    console.log(`[jobber-throttle] Budget low (${lastThrottle.currentlyAvailable}/${lastThrottle.maximumAvailable}), waiting ${waitMs}ms`)
    opts.onThrottlePause?.(waitMs)
    await sleep(waitMs)
  }

  const result = await jobberQuery(accessToken, query, variables)

  const throttleStatus = result?.extensions?.cost?.throttleStatus
  if (throttleStatus) {
    lastThrottle = throttleStatus
    const cost = result.extensions?.cost
    console.log(`[jobber-throttle] cost=${cost?.actualQueryCost} budget=${throttleStatus.currentlyAvailable}/${throttleStatus.maximumAvailable}`)
  }

  if (result?.errors?.some((e: any) => e.extensions?.code === 'THROTTLED')) {
    if (retries > 0) {
      const cooldownMs = Math.ceil((lastThrottle.maximumAvailable / lastThrottle.restoreRate) * 1000)
      console.warn(`[jobber-throttle] THROTTLED — pausing ${cooldownMs}ms, ${retries} retries left`)
      opts.onThrottlePause?.(cooldownMs)
      await sleep(cooldownMs)
      return jobberQueryThrottled(accessToken, query, variables, { ...opts, retries: retries - 1 })
    }
    throw new JobberThrottleError(result.errors)
  }

  return result
}

// ── Get location from Supabase ────────────────────────────────
export async function getLocation(locationId: string) {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('location_id', locationId)
    .single()

  if (error || !data) throw new Error(`Location ${locationId} not found in Supabase`)
  return data
}

// ── Refresh token via Jobber OAuth ────────────────────────────
//
// Jobber ROTATES refresh tokens: every successful refresh returns a NEW
// refresh_token and invalidates the one we sent (single-use). That makes
// concurrent refreshes actively dangerous — a burst of webhooks for the
// same location (REQUEST_CREATE + REQUEST_UPDATE land ms apart, each its
// own serverless invocation) would each POST the same stored token; Jobber
// honours one and invalidates the rest, and whichever write lands last can
// persist an already-superseded token → the location is bricked until a
// manual OAuth reconnect. This is the systemic cause of the chronic
// `no_valid_jobber_token` failures. Defences below:
//   1. In-process coalescing — concurrent callers on one instance share a
//      single refresh instead of each burning the rotating token.
//   2. Double-checked re-read — before POSTing, re-read the row; if another
//      instance just refreshed, use that token and don't rotate again.
//   3. Persist-guard — only overwrite jobber_refresh_token when Jobber
//      actually returned one (never null it out from a partial response).
//   4. Fail loud — a rejected refresh token (invalid_grant) is a permanent
//      RECONNECT-REQUIRED state, stamped on the row + surfaced distinctly,
//      not swallowed as a transient blip.

// Thrown when Jobber rejects the refresh token itself (dead / rotated away).
// Code cannot recover this — the location owner must re-OAuth. Callers use
// instanceof to surface a distinct signal instead of a generic failure.
export class JobberReauthRequiredError extends Error {
  locationId: string
  status: number
  constructor(locationId: string, status: number, detail: string) {
    super(`jobber_reauth_required (${status}) for ${locationId}: ${detail}`)
    this.name = 'JobberReauthRequiredError'
    this.locationId = locationId
    this.status = status
  }
}

// In-flight refreshes keyed by location slug. Module-level state survives
// across concurrent requests on the SAME warm instance (best-effort — a
// cross-instance burst still relies on defence #2). Cleared on settle.
const inFlightRefresh = new Map<string, Promise<string>>()

async function doRefresh(location: any, opts: { force?: boolean } = {}): Promise<string> {
  const locId = location.location_id
  const existing = inFlightRefresh.get(locId)
  if (existing) {
    console.log('[jobber-token] joining in-flight refresh for', locId)
    return existing
  }
  const p = performRefresh(location, opts).finally(() => inFlightRefresh.delete(locId))
  inFlightRefresh.set(locId, p)
  return p
}

async function performRefresh(location: any, opts: { force?: boolean }): Promise<string> {
  const locId = location.location_id
  const fiveMinutes = 5 * 60 * 1000

  // Double-checked re-read: another invocation may have refreshed since our
  // caller loaded the row. Re-read the current state and, unless forced,
  // reuse a still-valid token rather than rotating (and invalidating) again.
  const fresh = await getLocation(locId)
  if (!opts.force) {
    const freshExpiry = fresh.token_expiry ? parseInt(fresh.token_expiry) : 0
    if (freshExpiry && Date.now() < freshExpiry - fiveMinutes && fresh.jobber_access_token) {
      console.log('[jobber-token] refresh already done by another caller — reusing token for', locId)
      return fresh.jobber_access_token
    }
  }

  const refreshToken = fresh.jobber_refresh_token
  if (!refreshToken) {
    throw new JobberReauthRequiredError(locId, 0, 'no stored refresh token')
  }

  console.log('Refreshing Jobber token for:', locId, opts.force ? '(forced)' : '')
  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.JOBBER_CLIENT_ID!,
      client_secret: process.env.JOBBER_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
    cache: 'no-store',
  })

  // Defensive parse — Jobber returns plain-text bodies for OAuth errors
  // (e.g. expired refresh token → "The provided authorization grant is
  // invalid..."). Doing `res.json()` blindly would throw an uncaught
  // SyntaxError and crash whatever's calling the import. Read the raw text
  // first, try to JSON-parse, and always surface a clear catchable error.
  const raw = await res.text()
  let tokens: any = null
  try { tokens = JSON.parse(raw) } catch { /* non-JSON error body */ }
  if (!res.ok || !tokens?.access_token) {
    const detail = tokens ? JSON.stringify(tokens) : raw.slice(0, 300)
    // A dead / rotated-away refresh token (Jobber replies 400/401 invalid_grant
    // or "authorization grant is invalid"). Unrecoverable in code — stamp the
    // row so the digest + Settings show a clear RECONNECT-REQUIRED state, and
    // throw a distinct error. We do NOT touch the token columns here: never
    // clobber a token that a concurrent successful refresh may have written.
    const isDeadRefresh =
      res.status === 400 || res.status === 401 ||
      /invalid_grant|authorization grant is invalid|invalid.*refresh/i.test(raw)
    if (isDeadRefresh) {
      console.error(`[jobber-token] RECONNECT REQUIRED — Jobber rejected refresh token (${res.status}) for ${locId}: ${detail}`)
      await supabase.from('locations').update({
        last_sync_status: `RECONNECT REQUIRED — Jobber rejected refresh token (${res.status}) @ ${new Date().toISOString().slice(0, 19)}`,
        updated_at:       new Date().toISOString(),
      }).eq('location_id', locId)
      throw new JobberReauthRequiredError(locId, res.status, detail)
    }
    // Transient (5xx / network / unexpected shape) — retryable, not a reconnect.
    throw new Error(`Jobber token refresh failed (${res.status}) for ${locId}: ${detail}`)
  }

  const expiryMs = Date.now() + 55 * 60 * 1000

  // Write refreshed tokens back to Supabase. Guard the refresh_token: only
  // overwrite when Jobber returned a new one, so a partial/odd response can
  // never null out (and thus destroy) a still-usable rotating token.
  await supabase.from('locations').update({
    jobber_access_token:  tokens.access_token,
    ...(tokens.refresh_token ? { jobber_refresh_token: tokens.refresh_token } : {}),
    token_expiry:         expiryMs,
    token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
    last_sync_status:     `Token refreshed: ${new Date().toISOString().slice(0, 19)}`,
    updated_at:           new Date().toISOString(),
  }).eq('location_id', locId)

  console.log('Token refreshed and saved to Supabase')
  return tokens.access_token
}

// ── Three-path token validation ───────────────────────────────
// 1. Token valid (expiry > 5min)   → use directly, no API calls
// 2. Token expired (past expiry)   → refresh via OAuth directly
// 3. Expiry unknown / 5min buffer  → validate via GraphQL
export async function getValidJobberToken(location: any): Promise<string> {
  const expiry      = location.token_expiry ? parseInt(location.token_expiry) : 0
  const now         = Date.now()
  const fiveMinutes = 5 * 60 * 1000

  if (expiry && now < expiry - fiveMinutes) {
    console.log('Jobber token valid — using directly')
    return location.jobber_access_token
  }

  if (expiry && now >= expiry) {
    console.log('Jobber token expired — refreshing via OAuth')
    return doRefresh(location)
  }

  // Expiry unknown — validate via API
  const test = await jobberQuery(location.jobber_access_token, '{ account { id } }')
  if (test?.data?.account?.id) {
    console.log('Jobber token valid (API confirmed)')
    return location.jobber_access_token
  }

  return doRefresh(location)
}

// ─────────────────────────────────────────────────────────────
// High-level helpers for Send-to-Jobber + webhook flows.
// Accept a location slug (locations.location_id), handle the
// fetch + refresh internally, and never throw on auth failure —
// returns null / an errors array so callers can branch cleanly.
// ─────────────────────────────────────────────────────────────

// Resolve a usable access token for a location. Returns a distinct `error`
// of 'jobber_reauth_required' when the refresh token is dead (owner must
// re-OAuth) vs 'no_valid_jobber_token' for other/transient failures, so
// callers (and the digest) can tell "reconnect needed" from a blip.
async function resolveJobberToken(
  locationId: string,
  opts: { force?: boolean } = {},
): Promise<{ token: string | null; error?: string }> {
  try {
    const location = await getLocation(locationId)
    if (!location.jobber_access_token && !location.jobber_refresh_token) {
      console.error('[jobber-token] location has no tokens:', locationId)
      return { token: null, error: 'jobber_reauth_required' }
    }
    const token = opts.force
      ? await doRefresh(location, { force: true })
      : await getValidJobberToken(location)
    return { token }
  } catch (err: any) {
    if (err instanceof JobberReauthRequiredError) {
      console.error('[jobber-token] reconnect required for', locationId, '—', err.message)
      return { token: null, error: 'jobber_reauth_required' }
    }
    console.error('[jobber-token] refresh failed for', locationId, '—', err?.message || err)
    return { token: null, error: 'no_valid_jobber_token' }
  }
}

// Back-compat shim: existing callers expect a bare token-or-null.
export async function refreshJobberToken(locationId: string): Promise<string | null> {
  return (await resolveJobberToken(locationId)).token
}

export async function jobberGraphQL(
  locationId: string,
  query: string,
  variables?: Record<string, any>,
): Promise<{ data?: any; errors?: any[]; rawResponse?: Response }> {
  const doFetch = (token: string) =>
    fetch(JOBBER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    })

  const first = await resolveJobberToken(locationId)
  if (!first.token) {
    return { errors: [{ message: first.error || 'no_valid_jobber_token', extensions: { locationId } }] }
  }

  let res = await doFetch(first.token)

  // Refresh-on-401: the token passed our clock-based check but Jobber
  // rejected it (clock skew, an early server-side expiry, or a token that
  // was rotated out from under us). Force a fresh mint and retry ONCE.
  if (res.status === 401) {
    console.warn('[jobber-token] 401 despite valid-looking token — forcing refresh + retry for', locationId)
    const retry = await resolveJobberToken(locationId, { force: true })
    if (!retry.token) {
      return { errors: [{ message: retry.error || 'no_valid_jobber_token', extensions: { locationId } }] }
    }
    res = await doFetch(retry.token)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Jobber GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`)
  }

  const json = await res.json()
  return { data: json.data, errors: json.errors, rawResponse: res }
}

export async function jobberMutation(
  locationId: string,
  mutation: string,
  variables: Record<string, any>,
): Promise<{ data?: any; userErrors?: Array<{ message: string; path?: string[] }> }> {
  const { data, errors } = await jobberGraphQL(locationId, mutation, variables)

  // Top-level GraphQL errors (syntax, auth, complexity) — surface as userErrors
  // so callers have a single field to check.
  if (errors?.length) {
    console.error('[jobber-graphql] top-level errors for', locationId, '—', JSON.stringify(errors))
    return {
      data,
      userErrors: errors.map((e: any) => ({ message: e.message, path: e.path })),
    }
  }

  // Mutation field-level userErrors are nested inside each mutation's payload
  // (Jobber convention: clientCreate.userErrors, requestCreate.userErrors, etc).
  const userErrors: Array<{ message: string; path?: string[] }> = []
  if (data && typeof data === 'object') {
    for (const key of Object.keys(data)) {
      const val = (data as any)[key]
      if (val && typeof val === 'object' && Array.isArray(val.userErrors)) {
        for (const ue of val.userErrors) {
          userErrors.push({ message: ue.message, path: ue.path })
        }
      }
    }
  }

  if (userErrors.length) {
    console.error('[jobber-graphql] userErrors for', locationId, '—', JSON.stringify(userErrors))
  }

  return { data, userErrors: userErrors.length ? userErrors : undefined }
}