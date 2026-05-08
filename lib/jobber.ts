// lib/jobber.ts
// ─────────────────────────────────────────────────────────────
// Jobber GraphQL client + token management.
// Reads/writes tokens from Supabase locations table.
// Fully independent of Zoho.
// ─────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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