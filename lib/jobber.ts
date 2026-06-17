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
async function doRefresh(location: any): Promise<string> {
  console.log('Refreshing Jobber token for:', location.location_id)

  const res = await fetch('https://api.getjobber.com/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.JOBBER_CLIENT_ID!,
      client_secret: process.env.JOBBER_CLIENT_SECRET!,
      refresh_token: location.jobber_refresh_token,
    }),
    cache: 'no-store',
  })

  const tokens = await res.json()
  if (!tokens.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(tokens))

  const expiryMs = Date.now() + 55 * 60 * 1000

  // Write refreshed tokens back to Supabase
  await supabase.from('locations').update({
    jobber_access_token:  tokens.access_token,
    jobber_refresh_token: tokens.refresh_token,
    token_expiry:         expiryMs,
    token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
    last_sync_status:     `Token refreshed: ${new Date().toISOString().slice(0, 19)}`,
    updated_at:           new Date().toISOString(),
  }).eq('location_id', location.location_id)

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

export async function refreshJobberToken(locationId: string): Promise<string | null> {
  try {
    const location = await getLocation(locationId)
    if (!location.jobber_access_token) {
      console.error('[jobber-token] location has no access token:', locationId)
      return null
    }
    return await getValidJobberToken(location)
  } catch (err: any) {
    console.error('[jobber-token] refresh failed for', locationId, '—', err?.message || err)
    return null
  }
}

export async function jobberGraphQL(
  locationId: string,
  query: string,
  variables?: Record<string, any>,
): Promise<{ data?: any; errors?: any[]; rawResponse?: Response }> {
  const token = await refreshJobberToken(locationId)
  if (!token) {
    return { errors: [{ message: 'no_valid_jobber_token', extensions: { locationId } }] }
  }

  const res = await fetch(JOBBER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  })

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