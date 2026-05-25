// app/api/jobber/callback/route.ts
// Jobber OAuth callback. Supabase-primary token storage, Zoho dual-write best-effort.
// Accepts state in form "<locationId>:<nonce>" where locationId can be either
// locations.id (UUID) or locations.location_id (slug).

import { NextRequest, NextResponse } from 'next/server'
import { getZohoLocation, zohoUpdate } from '@/lib/zoho'
import { supabaseService } from '@/lib/supabase-service'
import {
  fetchRosterWithToken,
  persistRosterAndMatch,
  clearStaleJobberUserIds,
} from '@/lib/jobber-team-roster'

const JOBBER_TOKEN_URL   = 'https://api.getjobber.com/api/oauth/token'
const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/api/graphql'
const JOBBER_API_VERSION = '2025-04-16'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Helper: build a redirect back to BeeHub root with query params
function redirectHome(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/', request.url)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code     = searchParams.get('code')
  const state    = searchParams.get('state')
  const oauthErr = searchParams.get('error')

  if (oauthErr || !code || !state) {
    return redirectHome(request, { jobber: 'error', reason: oauthErr || 'denied' })
  }

  const locationId = state.split(':')[0]
  const isUuid = UUID_RE.test(locationId)
  const lookupField = isUuid ? 'id' : 'location_id'

  try {
    // 1. Verify location exists in Supabase (source of truth). Also
    //    grabs the prior jobber_account_id so we can detect a reconnect
    //    to a *different* Jobber account — stale jobber_user_id values
    //    on hub_users belong to the previous account's ID namespace and
    //    must be cleared before the fresh roster auto-match.
    const { data: supaLoc, error: supaErr } = await supabaseService
      .from('locations')
      .select('id, location_id, name, jobber_account_id')
      .eq(lookupField, locationId)
      .single()

    if (supaErr || !supaLoc) {
      console.error('Location not found in Supabase:', locationId, supaErr)
      return redirectHome(request, { jobber: 'error', reason: 'location_not_found', loc: locationId })
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/jobber/callback`

    // 2. Exchange auth code for tokens
    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.JOBBER_CLIENT_ID!,
        client_secret: process.env.JOBBER_CLIENT_SECRET!,
        code,
        redirect_uri:  redirectUri,
      }),
    })

    const tokenText = await tokenRes.text()
    let tokens: any
    try {
      tokens = JSON.parse(tokenText)
    } catch {
      console.error('Token parse error:', tokenText)
      return redirectHome(request, { jobber: 'error', reason: 'token_parse_failed', loc: locationId })
    }

    if (!tokens.access_token) {
      console.error('No access token:', tokens)
      return redirectHome(request, { jobber: 'error', reason: 'no_access_token', loc: locationId })
    }

    // 3. Probe Jobber for account ID
    const accountRes = await fetch(JOBBER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
        'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query: '{ account { id name } }' }),
    })
    const accountData = await accountRes.json()
    const accountId   = accountData.data?.account?.id ?? null
    const expiryMs    = Date.now() + 55 * 60 * 1000
    const syncStatus  = `Connected via Hub: ${new Date().toLocaleString()}`

    // 4. Supabase write — REQUIRED (this is the source of truth)
    const { error: writeErr } = await supabaseService.from('locations').update({
      jobber_access_token:  tokens.access_token,
      jobber_refresh_token: tokens.refresh_token,
      jobber_account_id:    accountId,
      jobber_client_id_app: process.env.JOBBER_CLIENT_ID,
      jobber_secret_app:    process.env.JOBBER_CLIENT_SECRET,
      token_expiry:         expiryMs,
      token_expiry_display: new Date(expiryMs).toISOString().slice(0, 19),
      last_sync_status:     syncStatus,
      jobber_connected:     true,
      updated_at:           new Date().toISOString(),
    }).eq('id', supaLoc.id)

    if (writeErr) {
      console.error('Supabase write failed:', writeErr)
      return redirectHome(request, { jobber: 'error', reason: 'supabase_write_failed', loc: locationId })
    }
    console.log('✓ Tokens written to Supabase for', supaLoc.location_id || supaLoc.id)

    // 4b. Reconnect detection + Jobber team roster sync. Non-fatal —
    //     the user IS connected at this point; the worst case from a
    //     roster failure is owner has to click "Refresh roster" in
    //     Settings → Team to populate jobber_user_id values manually.
    try {
      const reconnectedToDifferentAccount =
        !!supaLoc.jobber_account_id &&
        !!accountId &&
        supaLoc.jobber_account_id !== accountId
      if (reconnectedToDifferentAccount) {
        const cleared = await clearStaleJobberUserIds(supaLoc.id)
        console.log(
          `↺ Jobber account changed (${supaLoc.jobber_account_id} → ${accountId}) — nulled ${cleared} stale jobber_user_id values`
        )
      }

      const roster = await fetchRosterWithToken(tokens.access_token)
      if (roster) {
        const { matched, rosterSize } = await persistRosterAndMatch(supaLoc.id, roster)
        console.log(`✓ Jobber roster synced (${rosterSize} members, ${matched} hub_users auto-linked)`)
      } else {
        console.warn('⚠ Jobber roster fetch returned null — Settings → Team will show empty until refresh')
      }
    } catch (rosterErr) {
      console.warn('⚠ Jobber roster sync skipped (non-fatal):', rosterErr)
    }

    // 5. Zoho dual-write — OPTIONAL (legacy support, non-fatal)
    try {
      const slug = supaLoc.location_id
      if (slug) {
        const zohoLoc = await getZohoLocation(slug)
        if (zohoLoc) {
          await zohoUpdate('Locations', zohoLoc.id, {
            Jobber_Access_Token:  tokens.access_token,
            Jobber_Refresh_Token: tokens.refresh_token,
            Jobber_Account_ID:    accountId,
            Jobber_Client_ID_App: process.env.JOBBER_CLIENT_ID,
            Jobber_Secret_App:    process.env.JOBBER_CLIENT_SECRET,
            Token_Expiry:         expiryMs.toString(),
            Token_Expiry_Display: new Date(expiryMs).toISOString().slice(0, 19),
            Last_Sync_Status:     syncStatus,
          })
          console.log('✓ Tokens dual-written to Zoho for', slug)
        } else {
          console.log('• No Zoho record for', slug, '— Supabase-only (OK)')
        }
      }
    } catch (zohoErr) {
      // Supabase write succeeded — user IS connected. Just log the Zoho miss.
      console.warn('⚠ Zoho dual-write skipped (non-fatal):', zohoErr)
    }

    return redirectHome(request, { jobber: 'connected', loc: locationId })
  } catch (err) {
    console.error('Callback error:', err)
    return redirectHome(request, { jobber: 'error', reason: 'callback_failed', loc: locationId })
  }
}
